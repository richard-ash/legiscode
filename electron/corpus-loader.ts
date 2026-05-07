// Corpus loader for the Electron main process. Reads a built jurisdiction
// bundle (per @/storage's writer.ts layout) into memory at boot, builds the
// jurisdiction-wide structure tree once, and serves IPC requests from the
// in-memory cache.
//
// Phase 1 deliberately loads everything eagerly: trades a few hundred ms at
// boot for zero-latency corpus:read calls. Per-section lazy loading lands
// when the corpus grows past comfortable RAM (deferred to feat/sqlite-state).
//
// The loader trusts the bundle's content (it was validated 0%-skip-rate at
// build time per the legal-corpus completeness gates). It DOES NOT re-run
// schema validation; a malformed bundle indicates upstream corruption and
// should surface as a CorpusError("corrupt") rather than silent breakage.

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ModuleIdSchema, type SectionFile, SectionIdSchema } from "@/types";
import type {
  CorpusError,
  CorpusListResult,
  CorpusModuleSummary,
  CorpusReadRequest,
  CorpusReadResult,
  CorpusTreeNode,
} from "./ipc/contract";

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
    },
  };
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
  };

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
    const section = JSON.parse(raw) as SectionFile;
    // Same boundary discipline for sectionId — if the on-disk section file
    // carries an id the renderer can't brand into a CorpusRef, fail loud.
    const sectionIdCheck = SectionIdSchema.safeParse(section.id);
    if (!sectionIdCheck.success) {
      throw new Error(`module ${manifest.id}: invalid section id ${JSON.stringify(section.id)}`);
    }
    const tail = section.hierarchy.length > 0 ? section.hierarchy.slice(1) : [];
    sections.push({ moduleId: manifest.id, section, hierarchyTail: tail });
  }
  sections.sort((a, b) =>
    a.section.id.localeCompare(b.section.id, "en", { numeric: true, sensitivity: "base" }),
  );

  return {
    id: manifest.id,
    name: manifest.name,
    codeTitle: manifest.code_title,
    moduleVersion: meta.module_version ?? manifest.module_version,
    jurisdiction: manifest.jurisdiction,
    sections,
  };
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
  };
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
    cursor.kids.push({
      id: `${m.id}::${s.section.id}`,
      code: `§ ${s.section.id}`,
      name: s.section.title,
      kind: "section",
      ref: { moduleId: m.id, sectionId: s.section.id },
    });
  }
  return root;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}
