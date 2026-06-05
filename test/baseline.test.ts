import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnchorOutcome } from "@/parser/bills/emit-diff";
import { KNOWN_SCHEMA_VERSION } from "@/types";
import { computeOkRateGate } from "../scripts/sync-bills";

const REPO_ROOT = resolve(__dirname, "..");

function walk(root: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const name = e.name;
      const p = join(cur, name);
      if (e.isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === "out") continue;
        stack.push(p);
      } else if (e.isFile() && exts.some((ext) => name.endsWith(ext))) {
        out.push(p);
      }
    }
  }
  return out;
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("baseline", () => {
  it("vitest runs", () => {
    expect(1 + 1).toBe(2);
  });

  it("the @/* path alias resolves to src in vitest", () => {
    expect(KNOWN_SCHEMA_VERSION).toBe(4);
  });
});

// ─── Renderer-foundation invariants ─────────────────────────────────────────
//
// Grep-style assertions that encode invariants biome's `noRestrictedImports`
// rule cannot express (it operates on import paths, not method calls or
// object literals). Each assertion has an explicit allow-list of files
// that may legitimately violate the pattern; any new violator surfaces
// here as a CI failure.

describe("baseline grep gates", () => {
  it("no fs.watch / fsWatch calls in src/ or electron/", () => {
    const sourceFiles = [
      ...walk(join(REPO_ROOT, "src"), [".ts", ".tsx"]),
      ...walk(join(REPO_ROOT, "electron"), [".ts", ".tsx"]),
    ];
    const offenders: string[] = [];
    // Match: `.watch(` on a fs / node:fs identifier or via destructured import.
    // Restricted-import already bans the import itself; this catches method
    // calls + destructured aliases that biome's import-name rule misses.
    const pattern = /\b(?:fs|fsPromises|fsp|fs_promises)\s*\.\s*watch\s*\(/;
    for (const file of sourceFiles) {
      const text = read(file);
      if (pattern.test(text)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("no direct localStorage access in src/ outside the documented carve-outs", () => {
    const allowList = new Set(
      [
        // The single owner of localStorage reads/writes (Layer 1).
        "src/persistence/storage.ts",
        // FOUC-avoidance carve-out — runs synchronously before the
        // renderer bundle has parsed @/persistence. See its header.
        "src/theme-bootstrap.ts",
      ].map((p) => resolve(REPO_ROOT, p)),
    );
    const sourceFiles = walk(join(REPO_ROOT, "src"), [".ts", ".tsx"]);
    const offenders: string[] = [];
    const pattern = /\blocalStorage\s*\./;
    for (const file of sourceFiles) {
      if (allowList.has(file)) continue;
      const text = read(file);
      if (pattern.test(text)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("no ad-hoc `{ moduleId, sectionId }` literals outside boundary helpers", () => {
    const allowList = new Set(
      [
        // The wire-shape primitive types live here as the boundary; renderer
        // code calls corpusRefFromWire() instead of constructing the object
        // form.
        "src/corpus/wire.ts",
        // contract.ts re-exports the wire types from src/corpus/wire and
        // declares the channel registry; back-compat surface during the
        // wire-module split.
        "electron/ipc/contract.ts",
        // The boundary helpers themselves bridge wire ↔ CorpusRef.
        "src/corpus/refs.ts",
        // The loader builds responses in the wire shape on its way out.
        "electron/corpus-loader.ts",
        // The legacy migration schema in persistence reads the
        // `{ moduleId, sectionId }` shape because that's literally what
        // legacy state was. The migration deletes the legacy key after
        // converting to `{ module, section }`.
        "src/persistence/storage.ts",
        // Command palette score+hook pre-compute SearchableItem rows
        // in the wire shape (moduleId, sectionId) and the component
        // wraps via `corpusRefFromWire` at the navigate boundary. The
        // wire shape stays internal; the boundary emits CorpusRef.
        "src/ui/command-palette/score.ts",
        "src/ui/command-palette/use-command-palette.ts",
        "src/ui/command-palette/command-palette.tsx",
        // T11 + D-T6 (feat/diff #12): the section-pending-rail row
        // dispatches a diff-tab open with the three-tuple payload
        // (file_no, module_id, section_id) per codex C6 lock. The
        // grep flags the {currentModuleId, currentSectionId} props
        // block + the (moduleId, sectionId) callback parameter
        // signature, both of which are at the section-view ↔ diff-tab
        // boundary, not ad-hoc downstream uses.
        "src/ui/center-panel/section-view/section-pending-rail.tsx",
      ].map((p) => resolve(REPO_ROOT, p)),
    );
    const sourceFiles = [
      ...walk(join(REPO_ROOT, "src"), [".ts", ".tsx"]),
      ...walk(join(REPO_ROOT, "electron"), [".ts", ".tsx"]),
    ];
    const offenders: string[] = [];
    // Match an object literal that has BOTH `moduleId:` and `sectionId:`
    // close together (the section-reference shape). Single-field uses
    // (e.g. PerModuleValidation.moduleId in the parser) are not flagged.
    // The `[^{}]*` prevents matches across nested braces and across
    // unrelated objects on the same file.
    const pattern = /\{[^{}]*\bmoduleId\s*:[^{}]*\bsectionId\s*:[^{}]*\}/s;
    for (const file of sourceFiles) {
      if (allowList.has(file)) continue;
      const text = read(file);
      if (pattern.test(text)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("active-section.ts is gone (replaced by workbench/open-items.ts + persistence)", () => {
    const path = join(REPO_ROOT, "src/app/active-section.ts");
    expect(() => statSync(path)).toThrow();
  });

  it("structure-tree.tsx is gone (replaced by file-tree/file-tree.tsx)", () => {
    const path = join(REPO_ROOT, "src/ui/left-panel/structure-tree.tsx");
    expect(() => statSync(path)).toThrow();
  });

  it("electron/ipc/contract.ts does NOT import from @/corpus/refs (preload sandbox guard)", () => {
    // contract.ts is part of the preload-script dependency graph. Importing
    // anything from @/corpus/refs drags zod into the preload bundle, which
    // sandboxed preloads cannot `require()` at runtime — `window.api` then
    // fails to expose silently and the renderer paints the BootOverlay
    // "IPC bridge unavailable" diagnostic on every launch. Wire types live
    // in `@/corpus/wire` precisely because that module is value-free and
    // safe to pull through the preload graph.
    const text = read(join(REPO_ROOT, "electron/ipc/contract.ts"));
    expect(text).not.toMatch(/from\s+["']@\/corpus\/refs["']/);
  });

  it("src/corpus/wire.ts has only `import type` statements (preload sandbox guard)", () => {
    // wire.ts is the safe primitive that `electron/ipc/contract.ts` and the
    // pure-domain layers (corpus-nav, ui) both depend on. It MUST stay
    // value-import-free so it carries zero runtime weight through the
    // preload bundle. A naked `import {...}` here would re-introduce the
    // exact failure mode the contract.ts gate above prevents.
    const text = read(join(REPO_ROOT, "src/corpus/wire.ts"));
    const importLines = text
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) && !/^\s*\/\//.test(line));
    const offenders = importLines.filter((line) => !/^\s*import\s+type\b/.test(line));
    expect(offenders).toEqual([]);
  });

  it("computeOkRateGate accepts the six known data-quality statuses", () => {
    // anchored / added_section / structural / absorbed_external — the
    // four renderable / intentional categories. classification_low_
    // confidence and unresolved are surfaced data-quality signals
    // (operator-audited or corpus-staleness), not parser regressions.
    const outcomes: AnchorOutcome[] = [
      { file_no: "1", module_id: "m", section_id: "s1", status: "anchored" },
      { file_no: "1", module_id: "m", section_id: "s2", status: "added_section" },
      { file_no: "2", module_id: "m", section_id: "s3", status: "structural" },
      { file_no: "3", module_id: "m", section_id: "s4", status: "absorbed_external" },
      {
        file_no: "4",
        module_id: "m",
        section_id: "s5",
        status: "classification_low_confidence",
      },
      { file_no: "5", module_id: "m", section_id: "s6", status: "unresolved" },
    ];
    const v = computeOkRateGate(outcomes);
    expect(v.pass).toBe(true);
    expect(v.ok_outcomes).toBe(6);
    expect(v.total_outcomes).toBe(6);
    expect(v.failures).toEqual([]);
  });

  it("computeOkRateGate fails on no_baseline (true parser/corpus regression)", () => {
    // no_baseline means the parser knew the section_id but the corpus
    // had no text for it — a true regression that warrants gate
    // failure per project_legal_corpus_zero_skip.
    const outcomes: AnchorOutcome[] = [
      { file_no: "1", module_id: "m", section_id: "s1", status: "anchored" },
      { file_no: "3", module_id: "m", section_id: "s4", status: "no_baseline" },
    ];
    const v = computeOkRateGate(outcomes);
    expect(v.pass).toBe(false);
    expect(v.ok_outcomes).toBe(1);
    expect(v.total_outcomes).toBe(2);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]?.status).toBe("no_baseline");
  });

  it("computeOkRateGate passes a zero-outcome corpus (no bills with section_outcomes)", () => {
    const v = computeOkRateGate([]);
    expect(v.pass).toBe(true);
    expect(v.total_outcomes).toBe(0);
  });

  it("no Bill consumer reads `bill.affected_sections` (replaced by section_outcomes)", () => {
    // Bill.affected_sections was removed in feat/diff-completeness; the
    // touched-set is now sourced from `Bill.section_outcomes.map(o =>
    // o.section_id)`. LegalInstrumentEntry.affected_sections is a
    // separate field on a separate schema and is intentionally kept.
    //
    // The gate matches the literal field name in src/ + electron/ +
    // scripts/, with explicit allow-list entries for schemas whose
    // `affected_sections` is unrelated to Bill.
    const sourceFiles = [
      ...walk(join(REPO_ROOT, "src"), [".ts", ".tsx"]),
      ...walk(join(REPO_ROOT, "electron"), [".ts", ".tsx"]),
      ...walk(join(REPO_ROOT, "scripts"), [".ts", ".tsx"]),
    ];
    const ALLOW = new Set([
      // LegalInstrumentEntry / ordinance-history schemas legitimately
      // carry an `affected_sections` field for the corpus ordinance log.
      "src/types/legal-instrument-entry.ts",
      "src/types/ordinance-history.ts",
    ]);
    const offenders: Array<{ file: string; line: string }> = [];
    for (const f of sourceFiles) {
      const rel = relative(REPO_ROOT, f);
      if (ALLOW.has(rel)) continue;
      const text = read(f);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Skip line comments + jsdoc bodies (mid-block `*` lines).
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/\baffected_sections\b/.test(line)) {
          offenders.push({ file: rel, line: line.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
