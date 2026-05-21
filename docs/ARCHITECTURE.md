# Architecture

Module-level shape of the `legiscode` codebase, the public surface each module
exposes, and a notes section for architectural observations as they come up.

This is a **living document**. When something interesting surfaces during a
review, write it down in the Notes section so the next person doesn't have to
rediscover it.

## Design principles

We follow the **deep module** discipline from John Ousterhout's *A Philosophy
of Software Design*: small, well-documented public interfaces in front of rich,
private internals. The goal is that a future contributor swapping the parser
implementation (new jurisdiction, new format) touches code in exactly one place
and the consumer side does not change.

Concretely:

- Each module lives in its own `src/<module>/` directory.
- Each module exposes a single public surface via `src/<module>/index.ts`.
- Production code outside the module reaches the module **only through that
  barrel**. Reaching past the barrel into specific files is a code smell.
- Internal helpers and sub-files inside the module use **relative imports**
  (`./atomic-write`, `../classifier`) so the public path alias is reserved for
  cross-module traffic.
- Tests may reach inside a module when they are fundamentally testing internal
  behavior. New tests should prefer the public API where reasonable.

## Runtime topology

`legiscode` ships as an Electron desktop app. The runtime splits into three
isolated processes plus a shared types layer; every renderer-to-disk hop
crosses the typed IPC bridge.

```
                ┌─────────────────────────────────────────────────────────┐
                │  Renderer process  (Chromium, sandboxed, no Node)      │
                │  src/app/ + src/ui/ + src/styles/                      │
                │                                                         │
                │   App.tsx → api() → window.api.<ns>.<method>()         │
                │                                                         │
                │   contextIsolation: true, sandbox: true, nodeIntegration: false │
                └────────────────────────────┬────────────────────────────┘
                                             │ contextBridge
                                             ▼
                ┌─────────────────────────────────────────────────────────┐
                │  Preload script  (electron/preload.ts → preload-bridge.ts) │
                │  Allowlists exposed methods only; never leaks ipcRenderer │
                │                                                         │
                │   buildApi() iterates CHANNELS, exposeInMainWorld("api", …) │
                └────────────────────────────┬────────────────────────────┘
                                             │ ipcRenderer.invoke
                                             ▼
                ┌─────────────────────────────────────────────────────────┐
                │  Main process  (electron/main.ts, full Node)           │
                │                                                         │
                │   ipc/contract.ts ── single source: ChannelMap, Api,    │
                │                       CHANNELS, IpcBridgeError, types  │
                │   ipc/main-handlers.ts ── registerHandlers({…})         │
                │   corpus-loader.ts ── reads built bundle into RAM       │
                │   CSP guard, BrowserWindow lifecycle, window state     │
                └────────────────────────────┬────────────────────────────┘
                                             │ fs/promises read
                                             ▼
                ┌─────────────────────────────────────────────────────────┐
                │  Bundled corpus (read-only at runtime)                 │
                │  process.resourcesPath/corpus/ in prod                  │
                │  build/modules-full/ in dev                            │
                │  Layout owned by @/storage's writeModule()             │
                └─────────────────────────────────────────────────────────┘
```

**IPC contract** (`electron/ipc/contract.ts`): the single source of truth.
Owns the `ChannelMap` registry, the `Api` type the renderer sees, the
`CHANNELS` runtime allowlist (cross-checked against `ChannelMap` at compile
time), and `IpcBridgeError`. No process-specific imports — both main and
preload depend on it without dragging in each other's runtime. Adding a
channel is a two-place edit in this file (`ChannelMap` + `CHANNELS`) plus
one entry in main.ts's `Handlers` literal; the renderer's `Api` interface is
hand-maintained so call sites surface a TS error if the wire grows a
channel that the renderer hasn't been taught about.

**Process binding modules**: `ipc/main-handlers.ts` (imports `ipcMain` only)
exposes `registerHandlers(handlers)` + `assertAllChannelsRegistered()`.
`ipc/preload-bridge.ts` (imports `ipcRenderer` + `contextBridge` only)
exposes `exposeApi()`, which builds the namespaced api object at runtime by
splitting each channel name on `:`. Neither file imports the other's
Electron primitives — the layering catches mistakes that would otherwise
surface as silent preload failures.

**Channel-name convention**: `<namespace>:<verb>`, lowercase, hyphenated for
multi-word namespaces. Current surface: `corpus:list`, `corpus:read`,
`app:ping`, `shell:openExternal` (registered for a future "Open at source →"
affordance on cross-module popovers; protocol-gated to http(s) main-side,
currently unused by the renderer). Renderer code imports types only via
`import type` from `contract.ts`; never the runtime allowlist.

**Error model**: plumbing errors (unknown channel, renderer disconnect,
handler throw) reject the renderer-side promise. Domain failures (corpus
not loaded, section not found) resolve with `{ ok: false, error }` — the
errors-as-data pattern matches what `@/corpus` already does for build
errors.

**Boot sequence**: main starts the corpus load before `BrowserWindow` is
constructed; window stays `show:false` until both `webContents.did-finish-load`
and the corpus promise resolve (P4 / A18). On corpus failure, `corpus:list`
returns the typed error and the renderer paints `BootOverlay variant="corpus"`
instead of the populated workspace.

**Renderer's Node-import boundary**: `src/app/**` and `src/ui/**` are linted
with Biome's `noRestrictedImports` rule blocking `fs`, `path`, `electron`,
`os`, `crypto`, `http`, `https`, `net`, `child_process` (and their `node:`
prefixed forms). The runtime sandbox is the actual security gate; lint is
defense-in-depth (A1).

## Module map

```
                  ┌──────────────────────────────────────────────┐
                  │  scripts/sync-corpus.ts (truly thin)         │
                  │  argv → buildCorpus(opts) → exit(exitCode)   │
                  │  Owns: argv parse, --only validation,        │
                  │  source.path resolve + sandbox check,        │
                  │  BuildError → human-readable output          │
                  └────────────────────┬─────────────────────────┘
                                       │ BuildCorpusOptions
                                       ▼
                  ┌──────────────────────────────────────────────┐
                  │  @/corpus  (orchestrator, deep module)      │
                  │                                              │
                  │  buildCorpus(opts) → BuildResult             │
                  │  BuildError (8 typed kinds)                  │
                  │  errorsToExitCode                            │
                  │  ExitCodes (re-exported from @/storage)      │
                  │                                              │
                  │  Internal pipeline (private):                │
                  │    1. read manifest                          │
                  │    2. read source bytes + sha256             │
                  │    3. @/parser.parseExport                   │
                  │    4. validateCorpus (Phase 4 — placeholder) │
                  │    5. purge outputDir + writeModule × N      │
                  │    6. write corpus-level corpus-meta.json    │
                  │    7. errorsToExitCode → BuildResult         │
                  │                                              │
                  │  Errors are data, not exceptions.            │
                  └────────┬─────────────────────────┬───────────┘
                           │                         │
                           ▼                         ▼
              ┌────────────────────┐     ┌─────────────────────┐
              │ @/parser           │     │ @/storage           │
              │                    │     │                     │
              │  parseExport(...)  │     │  writeModule(...)   │
              │    → ParsedModule  │     │  AtomicWriteError   │
              │  ParseAbortError   │     │  ExitCodes          │
              │                    │     │  writeJson          │
              │  (deep internals,  │     │  (deep internals,   │
              │   private)         │     │   private)          │
              └─────────┬──────────┘     └──────────┬──────────┘
                        │                           │
                        └─────────────┬─────────────┘
                                      ▼
                          ┌──────────────────────┐
                          │  @/types             │
                          │                      │
                          │  Zod schemas, types, │
                          │  validators (pure)   │
                          └──────────────────────┘
```

## Modules

### `@/corpus` (orchestrator, deep module)

**Public surface:**

| Symbol | Purpose |
|---|---|
| `buildCorpus(opts)` | Entry point. Reads + validates the manifest, parses the source export, runs corpus-level gates, atomically writes per-module bundles, writes a corpus-level `corpus-meta.json`, returns a typed `BuildResult`. Never throws to its caller — every failure mode is one variant of `BuildError`. |
| `BuildResult` | Carries `exitCode`, `modulesBuilt`, gate reports (`coverage`, `citations`, `skips`), `errors`, plus provenance (`sourceSha256`, `snapshotAt`, `durationMs`). |
| `BuildError` | Discriminated union of every failure mode. Eight kinds today: `manifest_invalid`, `source_unreadable`, `parse_aborted`, `skip_gate_exceeded`, `toc_coverage_failed`, `citation_resolution_failed`, `atomic_write_failed`, `corpus_meta_write_failed`. New kinds add a variant + a row to `errorsToExitCode`. |
| `errorsToExitCode(errors)` | Single source of truth for `BuildError.kind` → `ExitCode`. Exhaustive switch — adding a kind without a mapping is a compile error. |
| `ExitCodes` / `ExitCode` | Re-exported from `@/storage` (where `AtomicWriteError` owns the canonical enum) so callers don't have to reach across modules. |

**Private internals:**
- `pipeline.ts` — the 7-step orchestration; reads manifest, computes SHA-256, parses, purges + writes modules, writes corpus-meta
- `errors.ts` — kind → ExitCode mapping
- `types.ts` — `BuildCorpusOptions`, `BuildResult`, `BuildError`, `CorpusBuildMeta`

**Why deep:** corpus-level gates (TOC coverage, citation resolution, future) need vantage of all modules at once. Without this layer the CLI's for-loop is the only place all modules co-exist, and grafting gates onto the CLI doubles down on the wrong layering. A future cron-driven or HTTP-driven build re-uses `buildCorpus` unchanged; only argv → `BuildCorpusOptions` translation differs.

### `@/parser` (deep module)

**Public surface:** the only symbols consumers may import.

| Symbol | Purpose |
|---|---|
| `parseExport(buffer, manifest)` | Parse a jurisdiction's source export (today: AmLegal HTML) into one `ParsedModule` per code declared in the manifest. |
| `ParsedModule` | Validated entries (sections, appendices, ord/res histories), enriched with citations + defined terms, plus the computed definitions + references graphs, skipped entries, and warnings. |
| `ParseAbortError` | Hard failure: the parser cannot proceed (corrupt anchor, classifier dead end). Carries a diagnostic. |
| `ParseWarning` | Non-fatal observation surfaced to the caller (e.g. `UnresolvedInterCodeLinkWarning`). |

**Private internals (do not import directly):**
- `parse-html.ts` — rbox classifier, hierarchy walk, per-kind parsers, walker that emits text + position-bearing format spans
- `pipeline.ts` — orchestrates the 3-pass section build (extract → module-dictionary → tokenize body[]), enrich, validate, compute graphs
- `build-body-segments.ts` — tiles primaries (citations, defined-term occurrences, subsection labels, paragraph breaks) and format spans into BodySegment[] with overlap-precedence resolution
- `citations.ts`, `defined-terms.ts`, `definitions.ts`, `references.ts`
- `slugify.ts`

**Why deep:** when the next jurisdiction (NYC) or format (Legistar JSON,
sfbos.org) lands, it adds a new file inside `src/parser/` and an arm to the
internal dispatcher. The public API does not change. The CLI does not change.
Existing tests for citations / defined terms / etc. do not change.

### `@/storage` (deep module)

**Public surface:**

| Symbol | Purpose |
|---|---|
| `writeModule(parsed, opts)` | Atomically write a `ParsedModule` to disk under `<output>/<module-id>/`. Handles lock, recover, write, fsync, sentinel-checksum, promote. |
| `AtomicWriteError` | Carries an `ExitCode`. Thrown for lock contention, recovery refused, write failure. |
| `ExitCodes` | The CLI's exit-code enum. |

**Private internals:**
- `atomic-write.ts` — lock acquisition, recover/promote, checksum
- `canonical-json.ts` — deterministic JSON serialization + fsync
- `corpus-meta.ts` — sentinel composition + write
- `corpus-writer.ts` — per-entry directory layout

**Why deep:** swapping local-filesystem persistence for S3 / SQLite / a
content-addressed blob store changes one module. The CLI does not change. The
parser does not change (it produces a `ParsedModule`; persistence is
downstream).

### `@/types` (contract layer)

Zod schemas and inferred TS types for every corpus boundary. The `validate/`
sub-directory is the only sanctioned filesystem read surface — anything that
reads a JSON file off disk goes through a `read*` validator that returns a
parsed, type-safe value or throws with a formatted error.

Both `@/parser` and `@/storage` depend on `@/types`. Nothing else depends on
either of them, so changes here ripple — schema bumps require coordinated
edits in both modules and a `schema_version` increment in `corpus-meta`.

### `scripts/sync-corpus.ts` (CLI)

The CLI is genuinely thin:

1. Parse argv.
2. Preflight: read the manifest once, validate `--only` against `modules[]`,
   resolve `manifest.source.path` against the repo root with `realpathSync` +
   sandbox check (the security boundary lives here, not in `@/corpus`).
3. Call `buildCorpus({ manifestPath, sourcePath, outputDir, ... })`.
4. Format any `BuildResult.errors` for the terminal; return `result.exitCode`.

No domain logic lives here. The CLI's responsibilities top out at "validate
argv, resolve paths, format errors." Any `for (... of result)` loop that
reaches into entries means the boundary has slipped — push the loop into
`@/corpus` or downstream.

## Boundary enforcement

Today: convention + code review. The path alias `@/*` resolves to anything
under `src/`, so reaching past a barrel compiles. Reviewers are expected to
flag `import { ... } from "@/parser/parse-html"` outside `src/parser/` and
`test/parser/`.

Future-strengthening options on the table:

- **`tsconfig` path narrowing.** Replace `@/*` with explicit barrels:
  `"@/parser": ["./src/parser/index.ts"]`, etc. Internal files in each
  module would still use relative imports. Tests that need to reach inside
  would convert to relative imports as well.
- **Biome `noRestrictedImports` rule** on `@/parser/*` and `@/storage/*`
  patterns, with overrides for `src/parser/**`, `src/storage/**`, and tests.
- **Project-references** (TS workspaces / pnpm workspaces) — the heaviest
  option, makes each module its own package with explicit dependencies.

We have not picked one yet. Re-evaluate when a violation slips through.

## Renderer layering (feat/file-tree D10)

The renderer is organized as five composable layers, bottom-up. Each
layer has a single responsibility and a narrow public surface; every
Phase 3-10 feature lands as either a new module within an existing
layer (additive) or as a new symbol behind an existing barrel (extension).

```
┌────────────────────────────────────────────────────────────────────┐
│ LAYER 5  UI bindings — thin React, mostly stateless                │
│   src/ui/left-panel/file-tree/                                     │
│     file-tree.tsx, tree-node.tsx, use-corpus-tree.ts,              │
│     use-typeahead.ts, use-roving-focus.ts,                         │
│     use-tree-virtualizer.ts                                        │
│   src/ui/App.tsx (orchestration)                                   │
├────────────────────────────────────────────────────────────────────┤
│ LAYER 4  Workbench — what is the user "looking at"                 │
│   src/workbench/  open-items.ts (kind: "section"; "chat" lands     │
│                                   with feat/ai-agent)              │
│                   navigate.ts   (NavigationIntent only, no history)│
│   src/citations/  resolver.ts + module-registry.ts (pure)          │
├────────────────────────────────────────────────────────────────────┤
│ LAYER 3  Navigation — tree model + filters + keyboard, pure        │
│   src/corpus-nav/  tree-model.ts, visible-rows.ts,                 │
│                    filter-predicate.ts, keyboard-actions.ts        │
├────────────────────────────────────────────────────────────────────┤
│ LAYER 2  Corpus loading (Electron main process)                    │
│   electron/corpus-loader.ts (IPC handler for corpus:list / read)   │
├────────────────────────────────────────────────────────────────────┤
│ LAYER 1  Persistence — single module, swappable                    │
│   src/persistence/  storage.ts (zod-validated, ONLY localStorage   │
│                     call site in src/ outside theme-bootstrap.ts)  │
├────────────────────────────────────────────────────────────────────┤
│ LAYER 0  Reference system — atom of the entire stack               │
│   src/corpus/refs.ts                                               │
│     CorpusRef (opaque-tagged), parse, serialize, equals, hash      │
└────────────────────────────────────────────────────────────────────┘
```

**Layer 0 — `src/corpus/refs.ts`.** `CorpusRef` is the canonical type
for "this section in this module" — opaque-tagged so an arbitrary
`{ moduleId, sectionId }` object can never be assigned without going
through `parse()`. Every consumer above Layer 2 carries `CorpusRef`,
not the wire shape. The wire shape (`{ moduleId, sectionId }`) is
preserved in `electron/ipc/contract.ts` for back-compat; the
`corpusRefFromWire` / `corpusRefToWire` helpers cross the boundary.
Extension fields (`version`, `anchor`, `revision`) are deferred until
their consumers land — see TODOS.md "CorpusRef extension fields".

**Layer 1 — `src/persistence/storage.ts`.** The single owner of
`localStorage` reads + writes from the renderer. Schemas are zod-
validated; corrupt or future-version data returns `null` + logs.
The legacy `legiscode.activeSection` → `legiscode.openItems` migration
lives here as a one-shot read-old / write-new / delete-old (D7).
A documented FOUC carve-out (`src/theme-bootstrap.ts`) is the only
other file in `src/` allowed to touch localStorage; the grep gate in
`test/baseline.test.ts` enforces this.

**Layer 2 — `electron/corpus-loader.ts`.** Unchanged in structure
from Phase 1 — eagerly loads the bundled corpus into RAM at boot,
serves `corpus:list` / `corpus:read`. The wire types use the legacy
`{ moduleId, sectionId }` shape; renderer code wraps via
`corpusRefFromRequest` (in contract.ts) at the boundary.

**Layer 3 — `src/corpus-nav/`.** Pure (event, state) → state functions
separated from React: `tree-model.ts` (immutable expansion state),
`visible-rows.ts` (memoized flat-row derivation per D11),
`filter-predicate.ts` (composable predicates including the
`prefixMatch` primitive used by typeahead), and `keyboard-actions.ts`
(WAI-ARIA tree spec MUST set + Cmd/Ctrl+Enter "open without switch").
No jsdom dependency in tests — pure-Node units cover ~80% of behavior.

**Layer 4 — `src/workbench/`.** `open-items.ts` carries the tab-state
discriminator (`section` today; `chat` lands with `feat/ai-agent`).
Functions are pure: `openItem`, `openItemWithoutSwitching`, `closeItem`,
`setActiveIndex`, `validateAgainstCorpus` (drops vanished refs on
cold-start), plus persistence interop (`fromPersisted` / `toPersisted`).
Per-item persistence is tolerant — a single corrupt tab is dropped while
siblings survive, so a schema bump to one kind never wipes the whole
strip.

`navigate.ts` shrunk to a single type export (`NavigationIntent =
"primary" | "background"`) in `feat/citation-resolution` (2026-05-20).
The pre-refoundation per-tab `HistoryMap` and its mutators were ripped
in favor of VS Code tab semantics: ⌘-click opens a new foreground tab,
⌘⌥← / ⌘⌥→ switches between open tabs (wraps at boundaries). To
revisit a section the user brings its tab forward.

**Layer 4a — `src/citations/`.** Sits alongside the workbench; consumed
by it. `resolver.ts` is a pure function from a parsed `Citation` and an
existence oracle (built once per corpus snapshot from the tree's
section keys + the active section ref) to a verb-shaped
`ResolutionResult`: `navigate-section` | `navigate-appendix` |
`navigate-structural` | `module-not-installed` | `scroll-only` |
`unresolvable`. Consumers switch on `result.kind`, not on the citation's
`target.kind` — the branch lives once. `module-registry.ts` is the
static index of every external code module — all 29 named California
codes plus US Code and CFR (31 entries). It exposes `findModuleByPhrase`
(text → `module_id`, used by the parser's paragraph-scope code-prefix
tracker) and `getModule` (`module_id` → display name, used by the
resolver to format the "Not downloaded" popover label).

**Layer 5 — `src/ui/`.** Container components + adapter hooks that bind
the pure layers below to React. `left-panel/file-tree/` is the tree
container plus four hooks (`use-corpus-tree`, `use-typeahead`,
`use-roving-focus`, `use-tree-virtualizer`); a tree-follows-active-tab
effect auto-expands the ancestor chain and scrolls the active section
into view whenever the active tab changes. `center-panel/section-view/`
renders body[] segments and emits each citation as a `<span>` so plain
text selection works across boundaries; a single delegated
`onClick` on the section's content root dispatches resolve() →
navigate() ONLY when ⌘/Ctrl is held. A hover popover
(`citation-popover.tsx`) shows after 400ms with the resolved title +
"⌘-click to open" footer, hides 200ms after the cursor leaves, and
dismisses on ESC. `tabs/tab-content.tsx` switches on the active item's
`kind` to pick a renderer. `use-navigation.ts` owns the navigate
primitive + ⌘⌥←/→ global shortcuts; it shouldn't be confused with
`corpus-nav/` (Layer 3, tree keyboard actions).

**Foundation invariants** (asserted by `test/baseline.test.ts`):
1. No `fs.watch` calls in src/ or electron/ (deferred-watcher gate).
2. No direct `localStorage` access in src/ outside Layer 1 + the
   FOUC carve-out.
3. No ad-hoc `{ moduleId, sectionId }` literals outside the boundary
   helpers (`refs.ts`, `corpus/wire.ts`, `contract.ts`,
   `corpus-loader.ts`, `storage.ts`'s legacy schema,
   `command-palette.tsx`'s internal `PaletteItem`).

## Notes

Append-only log of architectural observations. Newest at the top.

### 2026-05-20 — citation refoundation (VS Code interaction + module-aware resolution)

Manual QA against the live corpus surfaced six findings that collapsed
into a coherent refoundation of the citation system. The earlier
2026-05-19 architecture (described below in the second part of this
entry, kept for history) made citations clickable; this iteration
rewrites the parser, the resolver, and the interaction model.

**Architectural moves:**

1. **External citations go away.** The `external` `Citation` kind is
   removed. Every cite is now `internal | cross_module | structural |
   vague | internal_appendix`. Cross-module references carry a stable
   `module_id` (e.g. `ca-vehicle`, `us-code`) even when the bundle isn't
   installed — which collapses "dead clicks" into a typed user-facing
   outcome (`module-not-installed` popover) instead of silent failure.

2. **`src/citations/module-registry.ts`** is the static registry of every
   external code module identity — all 29 named California codes plus US
   Code and CFR (31 entries today). It exposes:
   - `findModuleByPhrase(text)` — text → `ModuleRegistryEntry`. The parser
     uses this for paragraph-scope code-prefix tracking: when a phrase
     like "Cal. Veh. Code" appears, every § cite that follows in the same
     paragraph classifies as `cross_module` with `module_id: "ca-vehicle"`.
   - `getModule(moduleId)` — id → display name. The resolver uses this
     to format the "Not downloaded" popover label.
   - `allModules()` — used by tests + diagnostic surfaces.

3. **Parser widening (`src/parser/citations.ts`).** The manifest pattern
   was widened to match `§`, `§§`, `Section(s)`, `Sec.`, `Article(s)`,
   `Chapter(s)`, `Division(s)`, `Title(s)`, `subsection(s)`,
   `subdivision(s)` + a number-or-subsection-paren tail. The parser now
   runs paragraph-by-paragraph (splits on `\n`) so the active code-prefix
   resets at paragraph boundaries — replacing the previous 50-char
   `EXTERNAL_LOOKBACK_CHARS` heuristic. `classifyMatch` branches on the
   prefix word: `§`/`Section`/`Sec.` → section-level; `Article`/`Chapter`/
   `Division`/`Title` → `structural` (level + number); `subsection`/
   `subdivision` → `internal` anchored to the current section.
   Capture rose from ~5,965 citations to ~43,427 (7.3×) on the SF corpus.

4. **Resolver (`src/citations/resolver.ts`).** The result union changed
   shape: `navigate-section` and `navigate-appendix` stay; `open-external`
   is gone; three new kinds add `navigate-structural` (corpus-tree lookup
   yields a `CorpusRef`), `module-not-installed` (carries `moduleId`,
   `displayName`, `label` for the popover), and `scroll-only` (carries a
   subsection label — used when an internal cite anchors back to its own
   active section, so dispatch scrolls within the active tab instead of
   opening a duplicate). The existence oracle (`CorpusExistence`) gained
   `activeSection` + `findStructural` so the resolver can make those two
   new decisions without re-discriminating in the renderer.

5. **VS Code interaction model.** Plain click on a citation is *text
   selection only* — the body container's `onClick` handler exits early
   unless ⌘/Ctrl is held. ⌘/Ctrl-click opens the resolved target in a
   new foreground tab (`navigate(item, "primary")`). ⌘⌥← / ⌘⌥→ switches
   between open tabs and wraps at the boundaries. Per-tab back/forward
   history was deleted entirely from `src/workbench/navigate.ts` and
   `src/ui/use-navigation.ts`; `HistoryMap`, `recordEntry`, `initHistory`,
   `back`, `forward`, `canGoBack`, `canGoForward` and the ⌘[ / ⌘]
   shortcuts are gone. `NavigationIntent` shrunk to `"primary" |
   "background"`. The `OpenItem` `external-citation` variant is gone too,
   along with `src/ui/external-viewer/` and `src/citations/external-url.ts`.

6. **Hover popover** (`src/ui/center-panel/section-view/citation-popover.tsx`).
   The section view tracks `mouseover`/`mouseout` on `[data-cite-kind]`
   spans; after a 400 ms delay it resolves the citation and renders a
   popover with the kind-discriminated body. Hover-out delays 200 ms
   before dismissing (so the cursor can travel into the popover for the
   future "Go to definition →" affordance); ESC dismisses immediately.
   `module-not-installed` results render a body that says
   "{displayName} not downloaded" with no action footer — ⌘-click on a
   not-installed module is a no-op by design.

7. **Tree-follows-active-tab** (`src/ui/left-panel/file-tree/file-tree.tsx`).
   A `useEffect` on `activeRef` walks the corpus tree to find the
   ancestor chain of the active section, adds those node IDs to the
   expansion set, and calls `virtualizer.scrollToIndex(..., {align:
   "center"})`. Roman / Arabic ambiguity (SF Articles are Roman, Chapters
   are Arabic) is handled by `findStructuralRef` in App.tsx via a small
   `toRoman()` converter; the lookup tries both forms.

8. **Validate-corpus demotion** (`src/parser/validate-corpus.ts`). With
   the wider parser, internal-shaped cites that don't resolve in the
   citing module are now demoted to `cross-unresolved` (informational)
   rather than failing the gate. The demoter checks (in order):
   self-citation; own section index with dot-truncation hierarchy walk;
   `a`-prefix variant (SF Charter appendix sections store as `a8.559`
   but are cited as `Section 8.559`); sibling-module section index
   (catches cross-module slips like "Section 8.509" in sf-administrative
   pointing at sf-charter); generic fallback for stale or off-corpus
   references. The gate still requires zero `unresolvedIntra`; demotion
   preserves the spirit of `project_legal_corpus_zero_skip` without
   blocking the build on legitimately-stale references in the underlying
   legal text.

**Carry-forward from 2026-05-19:** the delegated-click + existence-oracle
pattern remains the dispatcher; only the result shape and the click-
semantics-gate changed. Citations remain rendered as `<span
class="lc-cite">` with `data-cite-kind` driving CSS styling (amber
section citations, blue structural labels, green defined terms — the
three load-bearing colors).

### 2026-05-19 — citation resolution becomes a renderer-side primitive (superseded)

Before this branch, every `Citation` rendered by the section view was
visually styled as a link but inert — clicking did nothing. The
2026-05-19 work introduced a resolver + an `external` `OpenItem` tab
kind + a `shell:openExternal` IPC channel for "Open at source →"
affordances. The 2026-05-20 refoundation (above) supersedes this:
external citations no longer exist as a top-level kind; cross-module
references with stable `module_id`s replace the URL-synthesis pathway;
the external viewer was removed. The `shell:openExternal` IPC handler
stays registered for a future "Open at <source>" affordance on the
cross-module popover but is unused by the renderer today.

### 2026-05-07 — body[] becomes the canonical section representation

Section files previously shipped only a flat `text` field plus
summary `citations[]` and `defined_terms[]` arrays; the renderer
re-tokenized at display time. This branch (feat-parse-html-ast) added
`body: BodySegment[]` to the section schema and made it the canonical
form the renderer iterates. `text` stays alongside it so search,
ripgrep, and exporters keep working unchanged.

**3-pass parser pipeline** (`src/parser/pipeline.ts`). The body builder
needs the module-wide defined-term dictionary, which can't exist until
every section's local definitions are extracted, so the work splits:

- Pass 1 — per section: extract citations + defined-term matches,
  build a body-less section, schema-validate. Skips with a parse/section
  reason on shape failure.
- Pass 2 — module-wide: compute the defined-term dictionary so any
  section's body[] can hyperlink occurrences of any other section's
  definitions.
- Pass 3 — per section: call `buildBodySegments` with the Pass-1
  outputs + Pass-2 dictionary; re-validate the section with the
  populated body[]. A failure here is a body-builder bug, surfaced via
  the 0%-skip-rate gate.

**Schema invariants enforced at the trust boundary**
(`src/types/section.ts` superRefine). The boundary runs on every
disk read via `readSection` (which calls `SectionFileSchema.safeParse`),
so a stale `--corpus-path` bundle or hand-edited section JSON fails
closed instead of corrupting the rendered view:

1. **body[] re-flattens to text** (`bodyToText(body) === text`). The
   renderer iterates body[]; search and export read text. Drift
   between the two would render a section blank while search insists
   it has content. The pure helper `bodyToText` is exported so the
   schema and `test/parser/body-text-roundtrip.test.ts` agree on
   what "re-flatten" means.
2. **citation_index in range**. Bounds check against `citations[]`.
3. **citation raw matches the indexed citation's display_text**.
   Bounds-only would let `raw="§ 1.01"` link to `citations[0]` whose
   display_text is `"§ 2.02"` — silent wire-mismatch where the visible
   text doesn't match the click target. Both 2 and 3 must live at the
   section level because segment-level validation can't see siblings.

**Migration wedge for `--corpus-path`**. Section bundles built before
this branch had no body[]. The schema's `body: z.array(...).default([])`
fills in `[]`, which then fails the roundtrip invariant for any
content-bearing section. Stale bundles surface as
`CorpusError("corrupt")` at boot rather than rendering blank — users
must re-run `mise run sync-corpus` to regenerate.

**Two regression invariants** guard the migration end-to-end:
`text-fidelity.test.ts` pins text bytes against a committed snapshot;
`body-text-roundtrip.test.ts` asserts every section's body[]
reflattens to its text byte-for-byte across the whole fixture. The
operator-driven `mise run validate:full` runs the same gates over
~11k production sections.

This was caught and tightened during `/codex review`: an initial cut
shipped only the bounds check on citations; codex flagged
(a) the body[] roundtrip was provable at parse time but not enforced,
and (b) raw/display_text drift was unchecked. Both were folded back
into the same commits before opening the PR (`feedback_arch_fixes_in_review`).

### 2026-05-06 — feat/file-tree foundation reset

Replaced the Phase 1 `structure-tree.tsx` with a five-layer foundation
(`refs` / `persistence` / `corpus-nav` / `workbench` / file-tree UI).
The plan archive lives at
`~/.gstack/projects/richard-ash-legiscode/richardash-feat-file-tree-design-20260428-150025.md`;
the design rationale (D1-D13) is captured there. Most rendering
logic moved out of React into pure-Node modules, so the test suite
shifted from jsdom component tests to pure-function units. The
single-active-section model became an `openItems[]` + `activeIndex`
state with a `kind` discriminator that `feat/ai-agent` extends to
chat tabs without touching this branch. A grep-gate baseline asserts
the foundation invariants (no fs.watch, no localStorage outside
Layer 1, no ad-hoc `{ moduleId, sectionId }` literals).

### 2026-05-05 — IPC layer collapsed to a single contract

Before this change the IPC layer was spread across five files:
`electron/ipc/channels.ts` (payloads + allowlist), `electron/ipc/api-types.ts`
(re-exported `Api` shape), `electron/ipc/bridge.ts` (registerHandler +
safeInvoke + IpcBridgeError, importing both `ipcMain` and `ipcRenderer` in
the same runtime module), `electron/preload.ts` (hand-wired namespace
literal), and `src/app/ipc-client.ts` (renderer-side namespaced re-wrapper).
Adding a channel was a five-place change with two of those files duplicating
the `Api` shape; `bridge.ts` blurred the main/preload process boundary by
importing both runtime sides at once.

Collapsed to one deep contract module + two thin process bindings.
`electron/ipc/contract.ts` owns `ChannelMap`, the runtime `CHANNELS`
allowlist (cross-checked against `ChannelMap` keys at compile time), the
hand-written `Api` interface, and `IpcBridgeError`.
`electron/ipc/main-handlers.ts` imports `ipcMain` only and exposes
`registerHandlers({...})` taking an exhaustive `Handlers` literal —
forgetting a channel is a TS error. `electron/ipc/preload-bridge.ts` imports
`ipcRenderer` + `contextBridge` only and builds the `window.api` object at
runtime by iterating `CHANNELS`, so adding a channel never edits this file.
The renderer-side `ipc-client.ts` was deleted in favor of a 5-line `api()`
accessor that throws if `window.api` is unwired; call sites use
`window.api.<ns>.<method>()` directly.

Adding a channel after this change: extend `ChannelMap` + `CHANNELS` in
`contract.ts`, add the namespaced method to `Api` in the same file, add the
handler entry to the `Handlers` literal in main.ts. Renderer call sites
enforce the `Api` shape; main.ts handler exhaustiveness is type-checked.
The boot-time `assertAllChannelsRegistered()` tripwire is kept as
defense-in-depth — if a future refactor splits handler registration across
multiple call sites, missing handlers surface at boot rather than as a
renderer-side timeout.

This was caught by `/codex review` against the electron-shell branch: P2
findings on IPC fanout (3-of-4) and bridge.ts process-mixing (4-of-4)
both addressed by the same restructure. The corpus-singleton-jurisdiction
finding (P2 #1 — codex's "biggest structural risk") was deferred to
`feat/module-manager` per a staff-eng review of the proposed wire-shape
change: designing the multi-jurisdiction shape requires a real second
jurisdiction on disk to verify against, which v1.0 doesn't have.

### 2026-05-04 — `@/corpus` orchestrator extraction (Phase 0 of parser correctness)

Before this change the CLI accreted orchestration: argv parse + manifest read +
source read + per-module loop + dual error → exit-code mapping. Phase 4's
upcoming corpus-level gates (TOC coverage, citation resolution) had no
clean home — they need vantage of all modules at once, and the CLI's for-loop
was the only place all modules co-exist.

Extracted `@/corpus` as the orchestrator deep module. Public surface is one
function (`buildCorpus`) returning one type (`BuildResult`) carrying one
discriminated-union error type (`BuildError`, eight kinds). Errors are data;
the orchestrator never throws to its caller. `errorsToExitCode` is the single
source of truth for kind → ExitCode and is exhaustively switched, so a new
error kind is a TypeScript compile error until it has a mapping.

CLI shrunk to argv → preflight (manifest read for `--only` + `source.path`
resolution + sandbox check) → `buildCorpus(opts)` → format errors → exit.
Output directory is purged at the start of every build (D6 from the plan):
`outputDir` is ephemeral build state, not authoritative storage. A failed
mid-build leaves a partial corpus on disk — that's the accepted tradeoff per
the plan. Per-module atomic-write semantics are preserved within the
freshly-cleared `outputDir`.

A new corpus-level `corpus-meta.json` lives at `<outputDir>/corpus-meta.json`,
sibling to the per-module sentinels. It records `valid`, `source_sha256`,
`snapshot_at`, `duration_ms`, `modules_built`, gate reports, and the typed
error list.

Phase 4's `validateCorpus` step is reserved as pipeline step 4 (between
parse and write) but unimplemented today — `coverage` and `citations` are
empty placeholders. Phase 4 fills them in without changing the public
contract.

### 2026-05-03 — Parser encapsulation refactor (PR #2)

`src/parser/` was originally a flat bag of 9 files with no `index.ts`.
`scripts/sync-corpus.ts` reached into 8 of those 9 files for individual
symbols and orchestrated the parse → extract-citations → extract-defined-terms
→ compute-definitions → compute-references → compose-meta → write pipeline
itself. Swapping the parser implementation would have required touching the
CLI orchestrator and ~10 test files coupled to internal helpers.

Refactored to deep-module shape: parser exposes only `parseExport()` and the
result type via `index.ts`; the pipeline orchestration moved inside the
module; persistence (atomic-write, canonical-json, corpus-meta sentinel)
extracted to a sibling `@/storage` module with its own narrow public surface.

This was caught and fixed during PR #2's review pass — fixing structural
problems is much cheaper before code lands on `main`. Recorded as
`feedback_arch_fixes_in_review` in personal memory.
