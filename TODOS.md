# TODOS

Format: each item is a heading, with a one-line summary, **What/Why**, **Pros/Cons**, **Context**, **Depends on / Blocked by**, and an owner branch (or `unowned`).

Add items aggressively; remove them when shipped or when superseded by a real plan.

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

## Module index hosting (GitHub Releases vs CDN)

v1.1+ module manager fetches `sf-municipal` updates and other jurisdiction modules from somewhere. v1.0 ships only `sf-municipal` pre-installed, so the publish target doesn't gate v1.0 — but `feat/build-pipeline`'s scheduled refresh workflow has to write artifacts somewhere readable by the v1.1 module manager.

- **What:** Pick the hosting target for module artifacts (`sf-municipal-2026.04.json.zst`, etc.) and the index that lists available modules + versions per `schema_version` namespace.
- **Why:** The v1.1 module manager URL pattern (`/modules/schema-1/sf-municipal/2026.04`) needs a real host. Schema-version-namespacing is a backend publish-time concern, not a client concern (memory: `project_schema_version_gate_at_backend.md`).
- **Pros (GitHub Releases):** Zero infra; baked-in CDN; free for open-source; provenance via GitHub. **Cons:** Release-asset URLs are stable but releases-tab UI gets noisy with weekly auto-updates; no fine-grained access control later.
- **Pros (Cloudflare R2 or similar):** Full control over URL structure; no UI noise; cheap. **Cons:** Adds an infra dep + a secrets footprint; provenance is on us.
- **Context:** Surfaced by `feat/corpus-parser` round 1 codex review (2026-04-30). Hostility of AmLegal to programmatic access (memory `project_amlegal_hostile_to_programmatic_access.md`) makes this slightly more urgent — once the scheduled refresh exists, it has to publish artifacts somewhere.
- **Depends on / Blocked by:** `feat/corpus-parser` shipping the module package format (this is locked in commit 1).
- **Owner:** `feat/build-pipeline`.

---

## Cross-module version compatibility policy

Modules are versioned independently (`sf-municipal@2026.04`, `ca-vehicle@2025.12`, `us-federal@2026.03`). When SF MC v2026.04 cites Cal. Veh. Code § 22358 and the user has CVC v2025.01 installed, what does the citation resolver do?

- **What:** Define the cross-module citation resolution policy. Options: (a) resolve against any installed version of the cited module ("best effort"); (b) resolve only against the version the citing module was built against ("frozen"); (c) hybrid — resolve against installed if the cited section_id exists, else mark vague.
- **Why:** Citation `target.kind === "cross_module"` is locked in `feat/corpus-parser`'s schema; the resolution code is `feat/citation-resolution`'s problem. Version skew is the realistic case (modules update independently).
- **Pros (best-effort):** Maximizes resolution rate; closest to "links don't break." **Cons:** Silent semantic drift if the cited section was renumbered.
- **Pros (frozen):** Honest about what the citing module knew. **Cons:** Resolution rate drops as modules age.
- **Pros (hybrid):** Best UX. **Cons:** Most complex.
- **Context:** `feat/corpus-parser` round 1 codex review (2026-04-30) flagged that the schema accepts cross-module citations but no resolution semantics are specified yet.
- **Depends on / Blocked by:** Need at least two modules installable to make the question concrete (i.e., `feat/module-manager` v1.1 is the natural trigger).
- **Owner:** `feat/citation-resolution`.

---

## Scheduled corpus refresh workflow

`feat/corpus-parser` builds modules from AmLegal HTML. The artifact has to be regenerated on a schedule because AmLegal updates as ordinances land — without a refresh, every shipped LegisCode is frozen at the snapshot baked into the .dmg/.exe.

- **What:** Add a scheduled GitHub Actions workflow that runs `mise run corpus:build -- --module sf-municipal --source manifests/sf-municipal/manifest.json --output build/modules/sf-municipal/`, then publishes the resulting module to the hosting target (see "Module index hosting" TODO).
- **Why:** AmLegal lag is 30-45 days; weekly is the right cadence. v1.0 doesn't need the refresh (pre-installed module ships in the .dmg) but v1.1 module-manager auto-update will pull from this workflow's outputs.
- **Pros:** Decouples corpus updates from app releases; users get fresh law without re-installing.
- **Cons:** Real fetch against AmLegal is fragile — `codelibrary.amlegal.com` Cloudflare-blocks default headless Chromium (memory `project_amlegal_hostile_to_programmatic_access.md`); will need headed-Playwright stealth, accelerated sfbos+Legistar pivot, or maintainer-curated weekly refresh.
- **Context:** `feat/corpus-parser` round 1 codex review (2026-04-30). The build-time CLI in `feat/corpus-parser` is hermetic (no live network in CI); live fetch is exclusively this workflow's problem.
- **Depends on / Blocked by:** "Module index hosting" decision; AmLegal-access strategy (Playwright stealth vs sfbos+Legistar pivot vs human-in-the-loop).
- **Owner:** `feat/build-pipeline`.

---

## `amlegal-base` vs `sf-amlegal` parser split

`feat/corpus-parser`'s parser-correctness PR added jurisdiction-agnostic logic (the editorial-chrome classifier works for any AmLegal HTML) and SF-specific logic (`Note\d+`/`-\d+` JD-anchor suffix stripping; SF Charter's appendix conventions; sf-planning's map-sheet headers). They live mixed in `src/parser/parse-html.ts` because the right split is speculative until parser #2 surfaces a different convention.

- **What:** Extract jurisdiction-specific code paths from `src/parser/parse-html.ts` into `src/parser/sf-amlegal/`, leaving the generic `src/parser/amlegal-base/` as the shared substrate. The `parser_strategy` field in `JurisdictionManifest` already routes to the right parser; this just makes the routing real.
- **Why:** Every SF-specific pattern added to `parse-html.ts` is one we'll have to extract later. Cost grows linearly. Resolve before parser #2 arrives.
- **Pros:** Clean inheritance/composition for future jurisdiction parsers; the deep-module promise stays honored. Makes parser #2 a 1-week project instead of a 1-month archaeology dig.
- **Cons:** Speculative until parser #2 has real requirements. Done too early, the seams are wrong; the right split is obvious in hindsight after seeing one alternative jurisdiction's HTML.
- **Context:** Surfaced by `feat/corpus-parser` /plan-eng-review on `feat-corpus-parser` (2026-05-04). Deliberately deferred — extracting before a second jurisdiction is in hand picks the wrong seams.
- **Depends on / Blocked by:** Real parser #2 candidate (LA Municipal? NYC?). Don't extract until at least one alternative jurisdiction's HTML is in hand.
- **Owner:** `feat/jurisdiction-2` (whichever branch picks up the second jurisdiction).

---

## Wire `InterCodeLink` graph + `UnresolvedInterCodeLinkWarning` through `@/corpus`

Code comments in `src/parser/parse-html.ts` and `src/parser/references.ts` reference an `InterCodeLink` graph and an `UnresolvedInterCodeLinkWarning` that aren't yet implemented through the pipeline. Cross-module citation resolution is the runtime feature this enables.

- **What:** Implement the `InterCodeLink` aggregation in `@/corpus`'s pipeline (after parseExport, before validateCorpus); surface `UnresolvedInterCodeLinkWarning` entries to `BuildResult.citations.unresolvedCross[]`. Already-built scaffolding in `parse-html.ts:849-895` extracts `InterCodeLink` data; this just wires it through.
- **Why:** Cross-module citation reporting is a published surface (`BuildResult.citations.unresolvedCross`) but the wiring through pipeline isn't built. Without it, the field exists but is always empty.
- **Pros:** Closes the loop on the corpus-level cross-module reporting promise. Required before `feat/citation-resolution` can do anything useful with cross-module links.
- **Cons:** None — the data extraction is already there, only wiring is missing.
- **Context:** Surfaced by `feat/corpus-parser` /plan-eng-review (2026-05-04). Mentioned in code comments since round-12 of the original parser PR; punted out of the correctness PR to keep scope tight.
- **Depends on / Blocked by:** Nothing — `validateCorpus` already lives in `@/parser` and is wired through `@/corpus`.
- **Owner:** `feat/citation-resolution` or whichever branch ships first cross-module feature.

---

## Multi-producer `@/corpus` interface (queue-shaped)

`feat/corpus-parser`'s parser-correctness PR adds `@/corpus.buildCorpus(opts) → BuildResult` with errors-as-data and JSON-serializable types. Today the only producer is the CLI. When a second producer materializes (cron, HTTP endpoint, in-process worker), the existing shapes are ready; this TODO is the explicit reminder not to redesign them when that day comes.

- **What:** When a second producer needs to invoke `buildCorpus` programmatically, add the serialization layer (e.g., `BuildCorpusRequest` JSON schema, queue adapter, worker wrapper) WITHOUT changing the existing `buildCorpus(opts) → BuildResult` worker signature. The worker is reusable as-is; only the dispatch layer is producer-specific.
- **Why:** Spending innovation tokens on a queue-shaped abstraction when one producer exists was correctly rejected during /plan-eng-review (2026-05-04). This TODO captures that the path is already clear when the need arrives.
- **Pros:** Avoids re-litigating the architecture when a second producer arrives. The worker boundary is already correct.
- **Cons:** Premature speculation if it never arrives — but the cost of the TODO itself is zero.
- **Context:** Surfaced by `feat/corpus-parser` /plan-eng-review (2026-05-04). Plan's Open Decisions section explicitly defers the multi-producer abstraction with this TODO as the placeholder.
- **Depends on / Blocked by:** A real second producer with real requirements (cron-refresh? HTTP API? Oban worker?). Don't speculate the schema until it exists.
- **Owner:** `feat/build-pipeline` (cron is the most likely first second-producer).

---
