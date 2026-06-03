// Corpus loader for the Electron main process. Reads a built jurisdiction
// bundle (per @/storage's writer.ts layout) into memory at boot, builds the
// jurisdiction-wide structure tree once, and serves IPC requests from the
// in-memory cache.
//
// Loads everything eagerly: trades a few hundred ms at boot for
// zero-latency corpus:read calls. Per-section lazy loading would
// matter once the corpus grows past comfortable RAM (see TODOS.md
// "Per-section lazy loading").
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
  type Bill,
  BillSchema,
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
  walkBody,
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

/**
 * One ancestor (chapter / article / sub-article) of a reading section.
 * `firstSectionId` is the lexicographic-numeric minimum section.id under
 * this ancestor, used by the breadcrumb renderer to dispatch
 * `navigate({kind:"section", ref})` on a parent-button click without a
 * second IPC round-trip.
 */
interface AncestorEntry {
  firstSectionId: SectionId;
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
   * definitions-v2.json. Per-section serving works through
   * def_id-keyed lookups (definitionsById). The Definition[] is kept
   * alongside the index because the command-palette aggregation step
   * needs the full record set, not just the lookup map.
   */
  definitions: readonly Definition[];
  /** Id-keyed lookup index for O(1) per-section projection. */
  definitionsById: DefinitionsById;
  /**
   * Per-section ordered ancestor list, outermost (chapter-level) first
   * and innermost (deepest sub-article) last. Length matches the
   * section's hierarchyTail. Each entry carries the first contained
   * section id so the breadcrumb renderer can navigate without
   * re-querying.
   */
  ancestorIndex: ReadonlyMap<SectionId, ReadonlyArray<AncestorEntry>>;
  /**
   * Pending Bills loaded from this module's pending-bills/ directory.
   * Empty array when the directory is missing, when sync-bills has not
   * been run, or when no matters currently target this module.
   * Per `feedback_no_placeholder_ui`, the renderer hides the pending-
   * bill surfaces (tree branch, banner, Impact tab, bill-detail tab)
   * entirely when this is empty across all modules.
   */
  pendingBills: readonly Bill[];
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
 *   3. dev:  `<projectRoot>/build/modules/`
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
    : join(opts.projectRoot, "build", "modules");
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

  // Breadcrumb sectionId: module-root parent is non-interactive (no
  // module overview exists to navigate to), so sectionId is null. Each
  // chapter/article ancestor points at the first contained section by
  // id (numeric-aware) via the pre-built ancestorIndex so a parent-
  // button click in the renderer dispatches navigate() without a second
  // IPC round-trip.
  const ancestorEntries = module?.ancestorIndex.get(loaded.section.id) ?? [];
  const parents: Array<{ code: string; name: string; sectionId: SectionId | null }> = [
    { code: module?.codeTitle ?? "", name: module?.name ?? "", sectionId: null },
  ];
  for (let i = 0; i < loaded.hierarchyTail.length; i++) {
    const tailLabel = loaded.hierarchyTail[i] ?? "";
    const ancestor = ancestorEntries[i];
    parents.push({
      code: tailLabel,
      name: "",
      sectionId: ancestor ? ancestor.firstSectionId : null,
    });
  }

  return {
    ok: true,
    value: {
      moduleId: req.moduleId,
      section: loaded.section,
      parents,
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
 * formatting.
 *
 * The build-time `unresolvable_def_id` gate in @/parser/validate-corpus
 * guarantees every def_id has a matching Definition in this module;
 * the loader trusts that and throws if the invariant is ever violated.
 * A throw here is a build-pipeline regression — the previous silent skip
 * masked these as missing tooltips, which violated the
 * project_legal_corpus_zero_skip policy.
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
    if (!def) {
      throw new Error(
        `loader: def_id ${JSON.stringify(defId)} in module ${module.id} is not present in definitionsById — the build-time unresolvable_def_id gate should have rejected this module`,
      );
    }
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
  walkBody(body, (seg) => {
    if (seg.kind === "defined_term" && seg.def_id) visit(seg.def_id);
  });
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
  const ancestorIndex = buildAncestorIndex(sections);
  const pendingBills = await loadPendingBills(moduleDir, manifest.id);

  return {
    id: manifest.id,
    name: manifest.name,
    codeTitle: manifest.code_title,
    moduleVersion: meta.module_version ?? manifest.module_version,
    jurisdiction: manifest.jurisdiction,
    sections,
    definitions,
    definitionsById,
    ancestorIndex,
    pendingBills,
  };
}

/**
 * Scan `<moduleDir>/pending-bills/` and return every Bill validated
 * against BillSchema. Missing directory returns an empty array — modules
 * without pending bills (or with no sync-bills run yet) are a normal
 * steady-state; per `feedback_no_placeholder_ui` the renderer hides the
 * surface entirely instead of rendering an empty stub.
 *
 * Hard-fails on a malformed Bill file: same posture as the section
 * loader. The build pipeline + sync-bills both validate against
 * BillSchema before write, so an invalid Bill on disk means the bundle
 * is corrupt and should surface as CorpusError("corrupt") rather than
 * silently skipping.
 */
async function loadPendingBills(moduleDir: string, moduleId: string): Promise<readonly Bill[]> {
  const dir = join(moduleDir, "pending-bills");
  const exists = await stat(dir).catch(() => null);
  if (!exists || !exists.isDirectory()) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const bills: Bill[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(dir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (cause) {
      throw new Error(
        `module ${moduleId}: pending-bill ${path} is not valid JSON: ${describe(cause)}`,
      );
    }
    const result = BillSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`module ${moduleId}: pending-bill ${path} failed schema: ${issues}`);
    }
    bills.push(result.data);
  }
  bills.sort((a, b) => a.file_no.localeCompare(b.file_no));
  return bills;
}

/**
 * Aggregate every pending Bill across all loaded modules. Returns an
 * empty array when no module has pending bills; the renderer uses the
 * length as the "show or hide the pending UI surfaces" gate per
 * `feedback_no_placeholder_ui`.
 */
export function listPendingBills(): readonly Bill[] {
  if (state === null || state.kind !== "ok") return [];
  const out: Bill[] = [];
  for (const mod of state.modules) {
    for (const bill of mod.pendingBills) out.push(bill);
  }
  return out;
}

/**
 * Walk the module's sections and build a per-section ordered ancestor
 * list, where each ancestor entry carries the first contained section
 * id (sorted by section.id numeric-aware — sections are already in
 * that order so we just record the first one encountered per
 * hierarchyTail prefix).
 *
 * Two sections share an ancestor at depth `d` iff their
 * `hierarchyTail.slice(0, d+1)` arrays are equal. Joining with U+0000
 * (NULL byte — a non-printing control char the parser's hierarchy-
 * label extraction never produces) makes the prefix into a single-
 * string map key without risking false collisions. A printable
 * delimiter like a space would collide between e.g.
 * ["Article", "1 Subarticle"] and ["Article 1", "Subarticle"],
 * silently routing a parent-button click to the wrong section.
 */
function buildAncestorIndex(
  sections: readonly LoadedSection[],
): ReadonlyMap<SectionId, ReadonlyArray<AncestorEntry>> {
  // prefix-key → first section id encountered (sections are pre-sorted
  // by section.id ascending, so the first wins).
  const firstByPrefix = new Map<string, SectionId>();
  for (const s of sections) {
    for (let d = 0; d < s.hierarchyTail.length; d++) {
      const key = s.hierarchyTail.slice(0, d + 1).join("\u0000");
      if (!firstByPrefix.has(key)) firstByPrefix.set(key, s.section.id);
    }
  }
  const out = new Map<SectionId, ReadonlyArray<AncestorEntry>>();
  for (const s of sections) {
    const entries: AncestorEntry[] = [];
    for (let d = 0; d < s.hierarchyTail.length; d++) {
      const key = s.hierarchyTail.slice(0, d + 1).join("\u0000");
      const firstSectionId = firstByPrefix.get(key);
      if (firstSectionId) entries.push({ firstSectionId });
    }
    out.set(s.section.id, entries);
  }
  return out;
}

/**
 * Read and validate the canonical Definition[] for a module from
 * `definitions-v2.json`.
 *
 * Missing file is legitimate (modules without defined terms produce
 * an empty array). Schema failure is hard-fail at the file level:
 * the build pipeline owns uniqueness + per-Definition shape
 * invariants (ModuleDefinitionsSchema), so a malformed file means
 * the bundle is corrupt. Whole-file hard-fail surfaces the
 * corruption clearly instead of silently dropping individual
 * entries.
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
  const totalSections = modules.reduce((n, m) => n + m.sections.length, 0);
  const definitions = aggregateDefinitions(modules);
  const pendingBillCount = modules.reduce((n, m) => n + m.pendingBills.length, 0);
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
      pendingBills: { count: 0, bills: [] },
    };
  }
  const allBills: Bill[] = [];
  for (const m of modules) {
    for (const bill of m.pendingBills) allBills.push(bill);
  }
  allBills.sort((a, b) => {
    if (a.file_no !== b.file_no) return a.file_no.localeCompare(b.file_no);
    return a.module_id.localeCompare(b.module_id);
  });
  const uniqueFileNoCount = new Set(allBills.map((b) => b.file_no)).size;
  return {
    jurisdiction,
    rootLabel: rootLabelFromJurisdiction(jurisdiction),
    jurisdictionVersion,
    codeCount: modules.length,
    sectionCount: totalSections,
    defaultRef: { moduleId: firstModule.id, sectionId: firstSection.section.id },
    tree: buildJurisdictionTree(modules, jurisdiction),
    definitions,
    pendingBills: { count: uniqueFileNoCount, bills: allBills },
  };
}

/**
 * Walk every module's canonical Definition[] and emit one row per
 * `(term, moduleId)` pair. Multiple Definitions of the same term
 * within a module collapse into a single row whose `definers` array
 * lists every `defined_in` section. Cross-module collisions stay as
 * separate rows so the command palette's `:def` filter shows each
 * definer authority distinctly — collapsing across modules would be
 * materially wrong for legal reading.
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

function jurisdictionDisplayName(jurisdiction: string): string {
  return jurisdiction.replace(/^City and County of\s+/i, "");
}

/**
 * Assemble the single jurisdiction-rooted tree. Modules become
 * children of the jurisdiction node. Pending bills live OUTSIDE the
 * tree (in the left-panel activity panel, sourced from
 * `CorpusModuleSummary.pendingBills`) — bills aren't sections, so
 * collapsing them into the section-tree shape would be a category
 * error.
 */
function buildJurisdictionTree(
  modules: readonly LoadedModule[],
  jurisdiction: string,
): CorpusTreeNode[] {
  const kids: CorpusTreeNode[] = modules.map(buildModuleTree);
  const displayName = jurisdictionDisplayName(jurisdiction);
  return [
    {
      id: `jurisdiction::${displayName}`,
      code: "",
      name: displayName,
      kind: "jurisdiction",
      kids,
    },
  ];
}

function buildModuleTree(m: LoadedModule): CorpusTreeNode {
  const root: CorpusTreeNode = {
    id: m.id,
    code: m.codeTitle,
    name: m.name,
    kind: "code",
    kids: [],
  };
  // Group sections by their hierarchy tail — each unique prefix
  // becomes a chapter node. The discriminator stays flat ("chapter"
  // for any intra-module group); a finer kind taxonomy can layer on
  // later.
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

  walkBody(body, (seg) => {
    switch (seg.kind) {
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
        // walkBody recurses into format.children automatically.
        break;
    }
  });
  flush();
  return out;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}
