# TODOS

Format: each item is a heading, with a one-line summary, **What/Why**, **Pros/Cons**, **Context**, **Depends on / Blocked by**, and an owner branch (or `unowned`).

Add items aggressively; remove them when shipped or when superseded by a real plan.

---

## Phase 1 alias-runtime strategy

`@/*` is resolved at TypeScript compile time and by vitest, but **not at plain Node runtime**. `scripts/sync-corpus.ts` and any future CLI script will need a runtime story.

- **What:** Pick tsx vs ts-node vs a small esbuild bundle step for runtime-resolving `@/*` imports.
- **Why:** Phase 0 deliberately scoped alias resolution to TS+tests only. The first CLI script lives in `feat/corpus-parser`.
- **Pros:** Decision teed up before parser branch starts; ~30 minutes saved.
- **Cons:** None — this is a known open question.
- **Context:** /plan-eng-review D11 (2026-04-29). Codex flagged this in the outside-voice pass.
- **Depends on / Blocked by:** Nothing. Resolves at the start of `feat/corpus-parser`.
- **Owner:** `feat/corpus-parser` (Phase 1).

---

## Electron ESM-in-main-process compatibility

Phase 0 commits to ESM globally (`"type": "module"`, `moduleResolution: "bundler"`). Electron 28+ supports ESM in the main process; older versions need a CJS boundary or a workaround.

- **What:** Verify the pinned Electron version supports ESM in `electron/main.ts`. If not, document a per-file CJS exception or upgrade Electron.
- **Why:** D10 made ESM the global default. The most likely Phase 1 stumble.
- **Pros:** Avoids half-day debug session at the start of `feat/electron-shell`.
- **Cons:** None.
- **Context:** /plan-eng-review D10 (2026-04-29). Electron version itself is decided in `feat/electron-shell`.
- **Depends on / Blocked by:** Electron version pin (decided in `feat/electron-shell`).
- **Owner:** `feat/electron-shell` (Phase 1).

---
