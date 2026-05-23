// Corpus loader for the Electron main process. Reads a built jurisdiction
// bundle (per @/storage's writer.ts layout) into memory at boot, builds the
// jurisdiction-wide structure tree once, and serves IPC requests from the
// in-memory cache.
//
// Phase 1 deliberately loads everything eagerly: trades a few hundred ms at
// boot for zero-latency corpus:read calls. Per-section lazy loading lands
// when the corpus grows past comfortable RAM (deferred to feat/sqlite-state).
//
// The loader runs schema validation at the trust boundary. Bundles are
// validated at build time (0%-skip-rate gate per the legal-corpus
// completeness rules), but bundles travel — a custom --corpus-path can
// point at a hand-edited or stale tree, and a future bundled module
// could ship with a schema-mismatched section file. Re-validating with
// SectionFileSchema.safeParse here turns those into CorpusError("corrupt")
// at boot rather than crashes downstream when the renderer reaches into
// a malformed body[] segment or an unknown editorial_status. The
// performance cost (zod parse per section, ~11k sections) is amortized
// against the boot once-per-app-launch.

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type BodySegment,
  type Definition,
  type DefinitionId,
  MIN_SUPPORTED_SCHEMA_VERSION,
  ModuleDefinitionsSchema,
  ModuleIdSchema,
  type ScopeExpr,
  type SectionFile,
  SectionFileSchema,
  type SectionId,
} from "@/types";
import type {
  CorpusError,
  CorpusListResult,
  CorpusModuleSummary,
  CorpusReadRequest,
  CorpusReadResult,
  CorpusTreeNode,
} from "./ipc/contract";

// Per-section wire shape returned for the popover lookup. Mirrors
// CorpusSectionView.definitions value type so the loader's projection
// step doesn't need a transform.
type DefinitionView = {
  term: string;
  excerpt: string;
  scope: ScopeExpr;
  first_use_section: SectionId;
};

type DefinitionsById = ReadonlyMap<DefinitionId, Definition>;

interface LoadedSection {
  moduleId: string;
  section: SectionFile;
  /** Hierarchy strings from section.hierarchy minus the leading code-title. */
  hierarchyTail: readonly string[];
}

interface LoadedModule {
  id: string;
  /** Display name from manifest.json — e.g. "San Francisco Port Code". */
  name: string;
  /** Per-module file path label from manifest.code_title — e.g. "Port Code". */
  codeTitle: string;
  /** YYYY.MM.DD per CorpusMetaSchema.module_version. */
  moduleVersion: string;
  jurisdiction: string;
  /** Sections sorted by SectionId ascending (numeric-aware). */
  sections: LoadedSection[];
  /**
   * Canonical Definition[] for this module, loaded from
   * definitions-v2.json. The L2b cutover means per-section serving
   * works through def_id-keyed lookups (definitionsById) instead of
   * the legacy term-keyed dict. The Definition[] is kept alongside
   * the index because the command-palette aggregation step needs the
   * full record set, not just the lookup map.
   */
  definitions: readonly Definition[];
  /** Id-keyed lookup index for O(1) per-section projection. */
  definitionsById: DefinitionsById;
}

interface LoadedCorpus {
  kind: "ok";
  jurisdiction: string;
  jurisdictionVersion: string;
  modules: LoadedModule[];
  /** Pre-computed summary for `corpus:list`. */
  summary: CorpusModuleSummary;
  /** moduleId → sectionId → LoadedSection — backs `corpus:read`. */
  byRef: Map<string, Map<string, LoadedSection>>;
}

type LoaderState = LoadedCorpus | { kind: "error"; error: CorpusError };

let state: LoaderState | null = null;

/**
 * Resolve the corpus root directory. Precedence:
 *   1. `--corpus-path=<path>` from argv (absolute or cwd-relative)
 *   2. `LEGISCODE_CORPUS_PATH` env var
 *   3. dev:  `<projectRoot>/build/modules-full/`
 *      prod: `<process.resourcesPath>/corpus/`
 */
export function resolveCorpusPath(opts: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
  resourcesPath: string;
  projectRoot: string;
}): string {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const flag = argv.find((a) => a.startsWith("--corpus-path="));
  if (flag) {
    const value = flag.slice("--corpus-path=".length);
    return isAbsolute(value) ? value : resolve(process.cwd(), value);
  }
  const envPath = env.LEGISCODE_CORPUS_PATH;
  if (envPath && envPath.length > 0) {
    return isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
  }
  return opts.isPackaged
    ? join(opts.resourcesPath, "corpus")
    : join(opts.projectRoot, "build", "modules-full");
}

/**
 * Load the corpus from `rootDir` into memory. Idempotent — subsequent calls
 * with the same `rootDir` return the cached state. Returns the populated
 * cache on success; sets the error state and returns it on failure so the
 * `corpus:list` handler can surface the BootOverlay corpus variant.
 */
export async function loadCorpus(rootDir: string): Promise<LoaderState> {
  if (state !== null) return state;

  try {
    const exists = await stat(rootDir).catch(() => null);
    if (!exists || !exists.isDirectory()) {
      return setError({
        kind: "not_loaded",
        detail: `Corpus directory not found at ${rootDir}. Reinstall the app or run with --corpus-path=…`,
      });
    }

    const moduleDirs = (await readdir(rootDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(rootDir, d.name))
      .sort();

    if (moduleDirs.length === 0) {
      return setError({
        kind: "not_loaded",
        detail: `No code modules found under ${rootDir}.`,
      });
    }

    const modules: LoadedModule[] = [];
    for (const moduleDir of moduleDirs) {
      const loaded = await loadModule(moduleDir);
      modules.push(loaded);
    }

    const jurisdiction = modules[0]?.jurisdiction ?? "Unknown";
    const jurisdictionVersion = modules.reduce(
      (latest, m) => (m.moduleVersion > latest ? m.moduleVersion : latest),
      "0000.00.00",
    );
    const summary = buildSummary(modules, jurisdiction, jurisdictionVersion);
    const byRef = new Map<string, Map<string, LoadedSection>>();
    for (const m of modules) {
      const inner = new Map<string, LoadedSection>();
      for (const s of m.sections) inner.set(s.section.id, s);
      byRef.set(m.id, inner);
    }

    state = { kind: "ok", jurisdiction, jurisdictionVersion, modules, summary, byRef };
    return state;
  } catch (cause) {
    return setError({
      kind: "corrupt",
      detail: `Failed to load corpus: ${describe(cause)}`,
    });
  }
}

/** Test seam — clears the loader cache between runs. */
export function __resetCorpusForTests(): void {
  state = null;
}

/** Return the cached `corpus:list` result without re-reading disk. */
export function listCorpus(): CorpusListResult {
  if (state === null) {
    return { ok: false, error: { kind: "not_loaded", detail: "Corpus has not been loaded." } };
  }
  if (state.kind === "error") return { ok: false, error: state.error };
  return { ok: true, value: state.summary };
}

/** Resolve a single section. Returns a domain error if the ref is unknown. */
export function readSection(req: CorpusReadRequest): CorpusReadResult {
  if (state === null) {
    return { ok: false, error: { kind: "not_loaded", detail: "Corpus has not been loaded." } };
  }
  if (state.kind === "error") return { ok: false, error: state.error };
  const moduleSections = state.byRef.get(req.moduleId);
  if (!moduleSections) {
    return {
      ok: false,
      error: { kind: "not_found", detail: `Unknown module: ${req.moduleId}` },
    };
  }
  const loaded = moduleSections.get(req.sectionId);
  if (!loaded) {
    return {
      ok: false,
      error: {
        kind: "not_found",
        detail: `Section ${req.sectionId} not found in module ${req.moduleId}`,
      },
    };
  }
  const module = state.modules.find((m) => m.id === req.moduleId);
  const sectionList = module?.sections ?? [];
  const idx = sectionList.findIndex((s) => s.section.id === req.sectionId);
  const prev = idx > 0 ? sectionList[idx - 1] : null;
  const next = idx >= 0 && idx < sectionList.length - 1 ? sectionList[idx + 1] : null;
  const definitions = module ? joinDefinitionsForSection(module, loaded.section.body) : {};

  return {
    ok: true,
    value: {
      moduleId: req.moduleId,
      section: loaded.section,
      parents: [
        { code: module?.codeTitle ?? "", name: module?.name ?? "" },
        ...loaded.hierarchyTail.map((h) => ({ code: h, name: "" })),
      ],
      prev: prev ? { moduleId: req.moduleId, sectionId: prev.section.id } : null,
      next: next ? { moduleId: req.moduleId, sectionId: next.section.id } : null,
      definitions,
    },
  };
}

/**
 * Walk `body[]` and project the module's Definition index down to only
 * the def_ids referenced by this section. Recurses into `format.children`
 * because a defined-term span may be nested inside bold/italic/list
 * formatting. Skips def_ids missing from the module index (graceful —
 * the renderer renders the highlight without a popover; happens when
 * the build pipeline emits a def_id that wasn't persisted, which is
 * an extractor bug worth seeing as a missing tooltip rather than a
 * crash).
 */
function joinDefinitionsForSection(
  module: LoadedModule,
  body: readonly BodySegment[],
): Record<DefinitionId, DefinitionView> {
  // Null-prototype object so def_ids colliding with Object.prototype
  // names ("constructor", "toString", "__proto__") project correctly.
  // With a plain {} the `defId in out` check would short-circuit on
  // those keys and we'd silently drop their tooltip entries.
  const out: Record<DefinitionId, DefinitionView> = Object.create(null);
  collectDefIds(body, (defId) => {
    if (defId in out) return;
    const def = module.definitionsById.get(defId);
    if (!def) return;
    out[defId] = {
      term: def.term,
      excerpt: def.excerpt,
      scope: def.scope,
      first_use_section: def.defined_in,
    };
  });
  return out;
}

function collectDefIds(body: readonly BodySegment[], visit: (defId: DefinitionId) => void): void {
  for (const seg of body) {
    if (seg.type === "defined_term") {
      if (seg.def_id) visit(seg.def_id);
    } else if (seg.type === "format") {
      collectDefIds(seg.children, visit);
    }
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

function setError(error: CorpusError): { kind: "error"; error: CorpusError } {
  state = { kind: "error", error };
  return state;
}

async function loadModule(moduleDir: string): Promise<LoadedModule> {
  const manifestRaw = await readFile(join(moduleDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as {
    id: string;
    name: string;
    code_title: string;
    jurisdiction: string;
    module_version: string;
  };
  const meta = JSON.parse(await readFile(join(moduleDir, "corpus-meta.json"), "utf8")) as {
    module_version: string;
    schema_version?: number;
  };

  // Schema-version gate. The --corpus-path flag lets power users point
  // at custom local bundles that bypass the backend's per-version URL
  // namespacing. A stale bundle would otherwise crash downstream when
  // the renderer reaches into a defined_term segment that's missing
  // its now-required def_id. Fail loudly with a clear message.
  if (
    typeof meta.schema_version === "number" &&
    meta.schema_version < MIN_SUPPORTED_SCHEMA_VERSION
  ) {
    throw new Error(
      `module ${manifest.id}: corpus at ${moduleDir} uses schema_version ${meta.schema_version}, ` +
        `app requires >= ${MIN_SUPPORTED_SCHEMA_VERSION}. Reinstall the app or run ` +
        "`mise run validate:full` to rebuild the corpus.",
    );
  }

  // Validate the moduleId at the trust boundary. If the bundle ships a
  // module id that fails ModuleIdSchema, the renderer's CorpusRef.parse()
  // would later throw inside computeRows() during render, blanking the
  // tree before BootOverlay can intercept. Surface the corruption here
  // so loadCorpus's catch routes it to CorpusError("corrupt") instead.
  const moduleIdCheck = ModuleIdSchema.safeParse(manifest.id);
  if (!moduleIdCheck.success) {
    throw new Error(`module ${moduleDir}: invalid id ${JSON.stringify(manifest.id)}`);
  }

  const sectionsRoot = join(moduleDir, "sections");
  const sectionFiles = await collectJson(sectionsRoot);
  const sections: LoadedSection[] = [];
  for (const filePath of sectionFiles) {
    const raw = await readFile(filePath, "utf8");
    // Validate at the trust boundary. SectionFileSchema enforces every
    // field (incl. the body[] discriminated union and the citation_index
    // superRefine); a malformed file fails closed here instead of
    // surfacing as a render-time crash. The thrown Error is caught by
    // loadCorpus's outer catch and routed to CorpusError("corrupt").
    let parsed: ReturnType<typeof JSON.parse>;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(
        `module ${manifest.id}: section ${filePath} is not valid JSON: ${describe(cause)}`,
      );
    }
    const validated = SectionFileSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`module ${manifest.id}: section ${filePath} failed schema: ${issues}`);
    }
    const section: SectionFile = validated.data;
    const tail = section.hierarchy.length > 0 ? section.hierarchy.slice(1) : [];
    sections.push({ moduleId: manifest.id, section, hierarchyTail: tail });
  }
  sections.sort((a, b) =>
    a.section.id.localeCompare(b.section.id, "en", { numeric: true, sensitivity: "base" }),
  );

  const definitions = await loadDefinitions(moduleDir, manifest.id);
  const definitionsById = indexDefinitionsById(definitions);

  return {
    id: manifest.id,
    name: manifest.name,
    codeTitle: manifest.code_title,
    moduleVersion: meta.module_version ?? manifest.module_version,
    jurisdiction: manifest.jurisdiction,
    sections,
    definitions,
    definitionsById,
  };
}

/**
 * Read and validate the canonical Definition[] for a module from
 * `definitions-v2.json`. The L2b cutover replaced the legacy
 * term-keyed `definitions.json` with the addressable Definition[]
 * graph; the loader reads only the v2 file.
 *
 * Missing file is legitimate (modules without defined terms produce
 * an empty array). Schema failure is hard-fail at the file level: by
 * L2b the build pipeline owns uniqueness + per-Definition shape
 * invariants (ModuleDefinitionsSchema), so a malformed file means
 * the bundle is corrupt. The whole-file hard-fail surfaces the
 * corruption clearly instead of silently dropping individual entries.
 * The per-key soft-fail policy of the legacy path was a workaround
 * for an upstream parser bug that the L2a builder fixes by
 * construction (terms are canonicalized + schema-validated at
 * extraction time).
 */
async function loadDefinitions(
  moduleDir: string,
  moduleId: string,
): Promise<readonly Definition[]> {
  const path = join(moduleDir, "definitions-v2.json");
  const exists = await stat(path).catch(() => null);
  if (!exists || !exists.isFile()) return [];
  let parsed: ReturnType<typeof JSON.parse>;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(
      `module ${moduleId}: definitions-v2.json is not valid JSON: ${describe(cause)}`,
    );
  }
  const result = ModuleDefinitionsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`module ${moduleId}: definitions-v2.json failed schema: ${issues}`);
  }
  return result.data;
}

function indexDefinitionsById(definitions: readonly Definition[]): DefinitionsById {
  const map = new Map<DefinitionId, Definition>();
  for (const def of definitions) map.set(def.id, def);
  return map;
}

async function collectJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const exists = await stat(current).catch(() => null);
    if (!exists || !exists.isDirectory()) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const p = join(current, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(".json")) out.push(p);
    }
  }
  out.sort();
  return out;
}

function buildSummary(
  modules: LoadedModule[],
  jurisdiction: string,
  jurisdictionVersion: string,
): CorpusModuleSummary {
  const tree: CorpusTreeNode[] = modules.map(buildModuleTree);
  const totalSections = modules.reduce((n, m) => n + m.sections.length, 0);
  const definitions = aggregateDefinitions(modules);
  const firstModule = modules[0];
  const firstSection = firstModule?.sections[0];
  if (!firstModule || !firstSection) {
    // Should be impossible — loadCorpus rejects empty directories — but
    // narrow the type instead of asserting !.
    return {
      jurisdiction,
      rootLabel: jurisdiction,
      jurisdictionVersion,
      codeCount: 0,
      sectionCount: 0,
      defaultRef: { moduleId: "", sectionId: "" },
      tree: [],
      definitions: [],
    };
  }
  return {
    jurisdiction,
    rootLabel: rootLabelFromJurisdiction(jurisdiction),
    jurisdictionVersion,
    codeCount: modules.length,
    sectionCount: totalSections,
    defaultRef: { moduleId: firstModule.id, sectionId: firstSection.section.id },
    tree,
    definitions,
  };
}

/**
 * Walk every module's canonical Definition[] and emit one row per
 * `(term, moduleId)` pair. Multiple Definitions of the same term
 * within a module collapse into a single row whose `definers` array
 * lists every `defined_in` section. Cross-module collisions stay as
 * separate rows so the command palette's `:def` filter shows each
 * definer authority distinctly — collapsing across modules would be
 * materially wrong for legal reading (D5).
 *
 * Sorted by `(term, moduleId)` so display order is stable across
 * boots — both for human eyes scrolling the palette and for the
 * hermetic test fixtures.
 */
function aggregateDefinitions(
  modules: readonly LoadedModule[],
): CorpusModuleSummary["definitions"] {
  const rows: Array<{ term: string; moduleId: string; definers: SectionId[] }> = [];
  for (const m of modules) {
    const byTerm = new Map<string, SectionId[]>();
    for (const def of m.definitions) {
      const definers = byTerm.get(def.term);
      if (definers) definers.push(def.defined_in);
      else byTerm.set(def.term, [def.defined_in]);
    }
    for (const [term, definers] of byTerm) {
      definers.sort((a, b) => a.localeCompare(b));
      rows.push({ term, moduleId: m.id, definers });
    }
  }
  rows.sort((a, b) => {
    if (a.term !== b.term) return a.term.localeCompare(b.term, "en", { sensitivity: "variant" });
    return a.moduleId.localeCompare(b.moduleId);
  });
  return rows;
}

function rootLabelFromJurisdiction(jurisdiction: string): string {
  // Heuristic: strip "City and County of " prefix to fit the chrome chip.
  return jurisdiction.replace(/^City and County of\s+/i, "").concat(" Municipal Code");
}

function buildModuleTree(m: LoadedModule): CorpusTreeNode {
  const root: CorpusTreeNode = {
    id: m.id,
    code: m.codeTitle,
    name: m.name,
    kind: "code",
    kids: [],
  };
  // Group sections by their hierarchy tail — each unique prefix becomes a
  // chapter node. Phase 1 keeps the discriminator flat ("chapter" for any
  // intra-module group); feat/file-tree refines the kind taxonomy.
  for (const s of m.sections) {
    let cursor = root;
    for (const segment of s.hierarchyTail) {
      const existing = cursor.kids?.find((k) => k.kind === "chapter" && k.code === segment);
      if (existing) {
        cursor = existing;
        continue;
      }
      const next: CorpusTreeNode = {
        id: `${cursor.id}::${segment}`,
        code: segment,
        name: "",
        kind: "chapter",
        kids: [],
      };
      if (!cursor.kids) cursor.kids = [];
      cursor.kids.push(next);
      cursor = next;
    }
    if (!cursor.kids) cursor.kids = [];
    // `code` carries the human-readable display label, not the
    // canonical anchor id. Post-refoundation, sf-plumbing's section
    // anchor "p109" has display_label "109.0" — the file tree, command
    // palette, and inactive-tab titles all surface `code`, and users
    // need to see the legal section number ("109.0") not the prefixed
    // anchor ("p109"). The anchor id stays canonical via `ref.sectionId`
    // for routing.
    const preview = extractPreview(s.section.text);
    const subsectionPreviews = extractSubsectionPreviews(s.section.body);
    cursor.kids.push({
      id: `${m.id}::${s.section.id}`,
      code: `§ ${s.section.display_label}`,
      name: s.section.title,
      kind: "section",
      ref: { moduleId: m.id, sectionId: s.section.id },
      ...(preview ? { preview } : {}),
      ...(Object.keys(subsectionPreviews).length > 0 ? { subsectionPreviews } : {}),
    });
  }
  return root;
}

const PREVIEW_MAX_CHARS = 180;

/**
 * First chunk of section text, normalized for the hover popover. Used
 * synchronously from the file-tree map keyed by refHash; the tree is
 * already on the IPC wire so adding ~180 chars per section is a small
 * fixed multiplier on the existing payload.
 *
 * Truncation prefers a word boundary inside the last 40 chars to avoid
 * cutting mid-word, then appends an ellipsis. Returns empty when the
 * section text is itself empty so the field is omitted (consumers
 * branch on presence, not on the empty string).
 */
function extractPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed;
  const window = collapsed.slice(0, PREVIEW_MAX_CHARS);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace >= PREVIEW_MAX_CHARS - 40 ? lastSpace : PREVIEW_MAX_CHARS;
  return `${window.slice(0, cut).trimEnd()}…`;
}

/**
 * Walk body[] and bake a preview for each subsection_label encountered.
 * Each preview is the text immediately following the label, up to the
 * next subsection_label or the end of body (whichever comes first), then
 * normalized + truncated by the same rules as extractPreview.
 *
 * First-occurrence-wins matches the subsection-id emission pattern in
 * section-view.tsx — duplicate labels in the same section are rare in
 * real legal corpora and the renderer's anchor lands on the first.
 *
 * Recurses into format.children so subsection_labels inside list /
 * listItem wrappers still get previews.
 */
function extractSubsectionPreviews(body: readonly BodySegment[]): Record<string, string> {
  const out: Record<string, string> = {};
  let currentLabel: string | null = null;
  let currentBuf = "";

  const flush = (): void => {
    if (currentLabel === null) return;
    if (!(currentLabel in out)) {
      const preview = extractPreview(currentBuf);
      if (preview) out[currentLabel] = preview;
    }
    currentLabel = null;
    currentBuf = "";
  };

  const walk = (segs: readonly BodySegment[]): void => {
    for (const seg of segs) {
      switch (seg.type) {
        case "subsection_label":
          flush();
          currentLabel = seg.label;
          break;
        case "text":
          if (currentLabel !== null) currentBuf += seg.text;
          break;
        case "citation":
          if (currentLabel !== null) currentBuf += seg.raw;
          break;
        case "defined_term":
          if (currentLabel !== null) currentBuf += seg.raw;
          break;
        case "paragraph_break":
          if (currentLabel !== null) currentBuf += " ";
          break;
        case "format":
          walk(seg.children);
          break;
      }
    }
  };

  walk(body);
  flush();
  return out;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}
