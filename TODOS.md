# TODOS

Format: each item is a heading, with a one-line summary, **What/Why**, **Pros/Cons**, **Context**, **Depends on / Blocked by**, and an owner branch (or `unowned`).

Add items aggressively; remove them when shipped or when superseded by a real plan.

---

## Re-enable Phase-1-hidden chrome elements when their backing systems ship

`feat/electron-shell` ships the chrome from the Claude Design handoff but **hides six elements** the mockup shows because their backing systems don't exist in Phase 1. Each has a designated owning branch. Without this tracking item, a future dev re-fetching the handoff and copying `chrome.jsx` verbatim could reintroduce dead UI before its system ships.

- **What:** Re-enable each of these chrome elements when its owning branch ships:
  - `lc-sync` indicator (titlebar) → `feat/module-manager` (v1.1+) — turns on the day cross-machine sync ships
  - Bell button (titlebar) → owning branch TBD (notifications system; not on roadmap yet)
  - Share button (titlebar) → owning branch TBD (share-section-URL feature; not on roadmap yet)
  - "+ Ask" tab affordance (tab bar) → `feat/ai-agent` (Phase 5) — adds chat tab kind + the affordance
  - Activity-bar bottom Pin/Account icon → owning branch TBD (account / saved-views system)
  - Activity-bar bottom Settings icon → either remove permanently (titlebar Settings is canonical) or repurpose for workspace-scoped settings — decide when a downstream branch wants the slot
- **Why:** Phase 1 follows the "don't render UI for capability that doesn't exist" rule (A15/A16/A20/A21). Each hidden element has a documented re-enable trigger; this TODO is the cross-branch coordination point so they don't get forgotten or accidentally reintroduced.
- **Pros:** Single tracking point for 6 deferred items; future devs know which branch owns each re-enable; prevents dead UI from drifting back into Phase 1 via mockup-fidelity arguments.
- **Cons:** Redundant with the plan archive's A15/A16/A20/A21 rows — but TODOS.md is where future devs actually look.
- **Context:** Surfaced by `feat/electron-shell` /plan-design-review on `feat-electron-shell` (2026-05-05). The mockup at `https://api.anthropic.com/v1/design/h/cwT4ElTPhtoFd9vZt3e7cw` shows all six elements; Phase 1 deliberately leaves them unrendered.
- **Depends on / Blocked by:** Each element's owning branch (listed above).
- **Owner:** Distributed across owning branches — this TODO is the index, not a single-branch task.

---

## Cross-platform titlebar CI matrix

`feat/electron-shell` ships `titleBarStyle: 'hiddenInset'` (macOS) + `titleBarOverlay` (Windows 11+) for a custom-painted titlebar. Cross-platform rendering needs CI assurance that doesn't replicate the matrix on every PR.

- **What:** macOS + Windows runners in `feat/build-pipeline`'s matrix run a single titlebar smoke (`@playwright/test` `_electron`) asserting the bar renders with brand mark + workspace chip + sync indicator on each OS.
- **Why:** Custom titlebar is design-load-bearing per `chrome.jsx` from the Claude Design handoff. Cross-platform regressions are easy to ship without matrix CI.
- **Pros:** Catches "works on my Mac" failures before users see them.
- **Cons:** Adds ~2-3 minutes to matrix CI runs. Trades CI time for confidence.
- **Context:** Surfaced by `feat/electron-shell` /plan-eng-review on `feat-electron-shell` (2026-05-04). Test would otherwise live on `feat/electron-shell` itself but the matrix runners only exist after `feat/build-pipeline` ships.
- **Depends on / Blocked by:** `feat/build-pipeline` matrix CI workflow.
- **Owner:** `feat/build-pipeline`.

---

## Windows 10 custom-titlebar fallback polish

Windows 10 has no `titleBarOverlay` API (introduced in Windows 11). v1.0 falls back to a native frame with the renderer-painted titlebar absent. Functional but visually inconsistent vs macOS / Windows 11+.

- **What:** Add a Windows 10 detection branch + a custom-frame implementation (e.g. `frame: false` + draggable region in CSS + manual Minimize/Maximize/Close button cluster) so Windows 10 users see the same titlebar visuals as Windows 11+.
- **Why:** Brand consistency. Windows 10 still has meaningful market share in legal/government tier.
- **Pros:** Visual parity across all supported platforms.
- **Cons:** Custom-frame on Windows is a known pain point — drag regions, double-click-to-maximize, snapping behavior all need manual implementation. Easy to ship subtle bugs.
- **Context:** Surfaced by `feat/electron-shell` /plan-eng-review (2026-05-04). v1.0 ships native frame fallback on Win10; revisit once we see real telemetry on Win10 user share.
- **Depends on / Blocked by:** v1.0 release in user hands.
- **Owner:** `feat/release-prep` (v1.1 polish window).

---

## CSP `connect-src` extension for Anthropic API

`feat/electron-shell` Phase-1 prod CSP is `default-src 'self'; connect-src 'self'`. When `feat/ai-agent` ships, the renderer needs to call the Anthropic API (or via main-process proxy — choose during ai-agent design).

- **What:** When `feat/ai-agent` lands, extend prod CSP `connect-src` to include `https://api.anthropic.com` (or omit if the call happens in main process and the renderer never sees the domain). Decide based on ai-agent's IPC vs direct-call architecture.
- **Why:** Without this update, the four-hard-rules citation-verification flow's network calls get CSP-blocked in prod. Failure mode would only show up in packaged builds, not dev.
- **Pros:** Prevents a notorious failure mode (works in dev, breaks in prod).
- **Cons:** None — small addition.
- **Context:** Surfaced by `feat/electron-shell` /plan-eng-review (2026-05-04). The architecture decision (renderer-direct vs main-proxy) is `feat/ai-agent`'s call; this TODO just makes sure CSP gets updated whichever way.
- **Depends on / Blocked by:** `feat/ai-agent` design pass.
- **Owner:** `feat/ai-agent`.

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
