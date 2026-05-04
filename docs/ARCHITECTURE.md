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

## Module map

```
                  ┌─────────────────────────────────────────────┐
                  │  scripts/sync-corpus.ts                     │
                  │  CLI entry point — argv, exit codes, errors │
                  └────────────┬────────────────────┬───────────┘
                               │                    │
                               ▼                    ▼
                  ┌────────────────────┐  ┌─────────────────────┐
                  │  @/parser          │  │  @/storage          │
                  │                    │  │                     │
                  │  parseExport(...)  │  │  writeModule(...)   │
                  │    → ParsedModule  │  │  AtomicWriteError   │
                  │  ParseAbortError   │  │  ExitCodes          │
                  │                    │  │                     │
                  │  (deep internals,  │  │  (deep internals,   │
                  │   private)         │  │   private)          │
                  └─────────┬──────────┘  └──────────┬──────────┘
                            │                        │
                            └──────────┬─────────────┘
                                       ▼
                           ┌──────────────────────┐
                           │  @/types             │
                           │                      │
                           │  Zod schemas, types, │
                           │  validators (pure)   │
                           └──────────────────────┘
```

## Modules

### `@/parser` (deep module)

**Public surface:** the only symbols consumers may import.

| Symbol | Purpose |
|---|---|
| `parseExport(buffer, manifest)` | Parse a jurisdiction's source export (today: AmLegal HTML) into one `ParsedModule` per code declared in the manifest. |
| `ParsedModule` | Validated entries (sections, appendices, ord/res histories), enriched with citations + defined terms, plus the computed definitions + references graphs, skipped entries, and warnings. |
| `ParseAbortError` | Hard failure: the parser cannot proceed (corrupt anchor, classifier dead end). Carries a diagnostic. |
| `ParseWarning` | Non-fatal observation surfaced to the caller (e.g. `UnresolvedInterCodeLinkWarning`). |

**Private internals (do not import directly):**
- `parse-html.ts` — rbox classifier, hierarchy walk, per-kind parsers
- `pipeline.ts` — orchestrates parse → enrich → validate → compute graphs
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

The CLI is intentionally thin:

1. Parse argv.
2. Read the jurisdiction manifest (validated).
3. Resolve the source path.
4. Call `parseExport(buffer, manifest)` from `@/parser`.
5. For each module result: enforce skip-rate gate, then call `writeModule(...)`
   from `@/storage`.
6. Map errors to exit codes; exit.

No domain logic lives here. If you find yourself adding a `for (... of result)`
loop inside the CLI that reaches into entries, the boundary has slipped — push
the loop into the appropriate module.

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

## Notes

Append-only log of architectural observations. Newest at the top.

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
