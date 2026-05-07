# TODOS

Format: each item is a heading, with a one-line summary, **What/Why**, **Pros/Cons**, **Context**, **Depends on / Blocked by**, and an owner branch (or `unowned`).

Add items aggressively; remove them when shipped or when superseded by a real plan.

---

## File-tree review deferrals (feat/file-tree round-1 review)

Adversarial /review on `feat-file-tree` (2026-05-06) surfaced findings beyond
F1 (boundary ref validation, fixed in this PR) and F12 (typeahead onBlur
reset, fixed in this PR). These were intentionally deferred:

- **F2 — Stale `legiscode.activeSection` legacy key never deleted when valid `legiscode.openItems` exists.** `src/persistence/storage.ts:135` returns the parsed new value immediately, leaving the legacy key behind. If a future schema bump corrupts `openItems`, the fall-through migration silently rolls user state back to whatever was at first migration. Fix: remove legacy key on the line that returns the valid new value (~3 lines). Owner: next persistence-touching branch.
- **F3 — `corpus.read` returning `{ ok: false }` silently leaves stale section visible.** `src/ui/App.tsx:117` only sets section on `r.ok=true`. Today the loader doesn't produce mid-session domain errors, but the contract permits them. Fix: route ok:false to either `setCorpusError` or `setSection(null)`. Owner: `feat/corpus-loader-errors` (creates when needed) or fold into `feat/sqlite-state`.
- **F7 — Out-of-range persisted `activeIndex` blanks the center forever.** `src/persistence/storage.ts:46` schema accepts any int; `fromPersisted` maps out-of-range to null; `App.tsx:71` only seeds `defaultRef` when `items.length===0`. Persisted `{items:[A,B,C], activeIndex:999}` cold-starts with 3 tabs but no active section. Fix: when activeIndex remaps to null but `items.length>0`, promote `items[0]` to active. Owner: same as F3.
- **F-perf — Three O(n) `findIndex` scans per keypress at 12k SF Municipal rows.** `src/corpus-nav/keyboard-actions.ts:107`, `src/ui/left-panel/file-tree/use-roving-focus.ts:70`, `src/ui/left-panel/file-tree/file-tree.tsx:93`. ~36k id comparisons per arrow press. Currently under the perf budget (in-tree assertion <50ms uncached). Fix: promote `Map<rowId, index>` from `useCorpusTree`, thread through `KeyboardState` and `useRovingFocus`. Owner: `feat/file-tree-polish` (#18 in master plans-overview) — bundles with F-sticky and F-pendingFocus since all three touch the same hooks.
- **F-palette — `⌘B` collapses the panel underneath an open command palette.** Three `window` keydown handlers (App.tsx:131, three-panel.tsx:46, file-tree onKeyDown) compete with no focus-trap coordination. Fix: palette dialog stops keydown propagation, OR three-panel checks `document.activeElement` is inside `[role=dialog]`. Owner: `feat/command-palette` (which already has the palette-perf work scoped).
- **F-empty-css — `.lc-tree-empty` and `.lc-tree-empty-caption` referenced in `file-tree.tsx:169` but not styled in globals.css.** Branch shouldn't fire in Phase 1 per DESIGN.md but is reachable defensively (e.g. once filtering ships). Fix: add 8 lines of CSS or drop the class hooks. Owner: `feat/search-filter` (when the filter ships and an empty result-set is real).
- **F-pendingFocus — `pendingFocusRowRef` not cleared when target row disappears (collapse race).** `src/ui/left-panel/file-tree/use-roving-focus.ts`: keyboard nav into a virtualized-out row stashes id; if user collapses the parent containing it, stash sits forever; later remount steals focus. ~3 lines: clear pendingFocus inside the row-disappeared effect at lines 53-57. Owner: same as F-perf.
- **F-sticky — No sticky ancestor headers under virtualization.** VSCode pins the current open directory at the top of the explorer pane so deep scrolling doesn't lose the parent context. Our file tree at 12k rows can scroll the user 1000+ sections deep into ARTICLE IV before the article header scrolls off. Surfaced 2026-05-06 by direct comparison against VSCode's explorer. Fix outline: read `virtualizer.scrollOffset`, find the topmost virtualized row, walk its ancestor chain, render those ancestors as fixed-position rows above the scroll viewport. Edge cases: (a) sticky-header transition seam when the real ancestor row scrolls into view, (b) ARIA — sticky copies must not double-count as `treeitem`s (`role="presentation"` with the real `treeitem` keeping focus + tabindex), (c) clicking a sticky header behaves like clicking the real ancestor (toggle expansion + focus). Estimated 100-200 LOC + Playwright coverage. Owner: same as F-perf — natural bundle since it reads the same `useRovingFocus` + `useTreeVirtualizer` internals.

**Owner:** Distributed across owning branches as listed above. This entry is the index so future devs (or future-me) don't lose them.

---

## Section-view scope cuts (feat/section-view scope-reduction 2026-05-06)

`/plan-eng-review` on `feat-section-view` (2026-05-06) cut the following from
the v1.0 wedge to ship the readable-section experience to Derek faster.
Each has a designated owning branch for re-introduction.

- **Line numbers (40px JetBrains Mono gutter).** DESIGN.md spec'd it; cut
  because legal cites reference `(a)(2)` subsection labels, never display
  lines (which change with viewport width). Westlaw/LexisNexis don't ship
  line numbers over section text. Re-introduce only if Derek dogfood surfaces
  a concrete "I wish I could cite line N" need. Owner: `feat/section-view-polish`
  (new tail branch, parallel to `feat/file-tree-polish` #18) if validated.
- **Minimap (44px right edge).** Same story — VS Code uses minimap for code
  with structural visual texture; serif legal text doesn't have that, and
  most SF sections fit on one screen. Re-introduce if a long-section
  navigation pain surfaces in real reading sessions. Owner: same as above.
- **Slot extension points** (`<SectionView slot="diff-banner" />`,
  `<SectionView slot="annotations" />`). Plan archived these as the
  integration mechanism for downstream branches per the master plans-overview
  Conflict Flags ("extend via well-defined slots... so they can land in
  parallel"). Cut because pre-designing slot shapes before the consumer
  branches exist risks getting the seam wrong (memory
  `feedback_minimum_shapes.md`). Each consumer adds its own slot when it
  lands: `feat/citation-resolution` (#9, Phase 3) for annotations on cited
  sections; `feat/diff` (#12, Phase 4) for diff-banner; `feat/sqlite-state`
  (#14, Phase 6) for annotation overlays; `feat/ai-agent` (#13, Phase 5) for
  per-section chat anchor. Phase 3-5 sequencing means parallel-merge risk is
  low. If two consumers DO need to overlap, the second-lander introduces a
  slot dispatcher (~20 LOC) at that moment with a real shape in hand.
- **Print-friendly CSS.** Cut because "lawyers print" is asserted, not
  validated. Re-introduce after first Derek/lawyer feedback round says they
  print and tells us what they print (full section? selected paragraphs?
  with or without citations expanded?). Owner: `feat/section-view-polish`.
- **Section header metadata: enacted ordinance + last amended ordinance + date.**
  Cut from `feat/section-view` because `SectionFileSchema` (in `src/types/section.ts`)
  has no `enacted_at` / `last_amended` fields and the parser doesn't extract them
  yet. The Done-when of `feat/section-view` originally listed "effective date" —
  that target moves with this cut. Owner: schema-extension PR on
  `feat/corpus-parser` adds the fields + parser extraction; renderer-side
  consumption rolls into `feat/section-view-polish` or whichever section-view
  branch is in flight when the schema lands.
- ~~**Defined-term tooltip showing "definition source".**~~ **REVERTED 2026-05-06**
  during the same /plan-eng-review session. Codex outside-voice catch:
  `build/modules/{module-id}/definitions.json` already exists with shape
  `Record<term, [{defined_in_section: SectionId, ...}]>`. The data IS there;
  the cut was based on incorrect "data doesn't exist" reasoning. Re-included
  as **D11** in feat/section-view: new IPC method `definitions.lookup(term,
  moduleId)` + tooltip UI on `<DefinedTerm>`. ~70 LOC + tests + IPC channel
  registration. No schema change needed.

**Owner:** Distributed across owning branches as listed above. This entry
is the index so future devs (or future-me) don't lose them. The natural
home for the renderer-side re-introductions is a new `feat/section-view-polish`
tail branch mirroring `feat/file-tree-polish` (#18) — propose adding it to
the master plans-overview when the first re-introduction is scheduled.

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

## Production release pipeline

Production sign + notarize + publish lives on a separate branch — `feat/build-pipeline` ships PR-side CI only. The release branch is blocked on credentials (Apple Developer cert + Azure Trusted Signing) that aren't yet in hand.

- **What:** Implement `feat/release-pipeline` per the design at `~/.gstack/projects/richard-ash-legiscode/richardash-feat-release-pipeline-design-20260505-180700.md`. Adds: `release.yml` (tag-triggered), macOS `mac.notarize: true` + entitlements.plist, Windows `win.azureSignOptions` (Azure Trusted Signing), `electron-builder --publish always` with auto-provisioned `GITHUB_TOKEN`, validate-before-publish ordering (sign → notarize → staple → `xcrun stapler validate` → `spctl --assess` → publish), `verify-secrets` pre-flight job, `packaged-csp.spec.ts` (closes the explicit deferral in `posture.spec.ts`), `RELEASING.md`.
- **Why:** v1.0 is a paid product; users won't double-click an unsigned `.dmg`/`.exe`. Notarization gates macOS Gatekeeper; Authenticode signing gates Windows SmartScreen. Both need a real release pipeline that validates signatures locally before pushing artifacts public.
- **Pros:** Decouples release from build; composite `setup-and-build` action is reused; `build-matrix.yml` is `workflow_call`-reusable so release.yml chains the same verify before signing. Estimated v1 fixed cost ~$230-260/yr (Apple Dev $99 + Azure Trusted Signing ~$120 + domain).
- **Cons:** Blocked on creds. ATS application latency unknown; could be days.
- **Context:** Originally scoped into `feat/build-pipeline`; rescoped out 2026-05-05 during /plan-eng-review when the user said "defer production till after MVP — won't have Apple/Microsoft creds yet." Codex's 16 review findings are absorbed into the release-pipeline design (validate-before-publish, OIDC over client_secret, `id-token: write` permissions, tag/version verify, `mac.target: [dmg, zip]` for the auto-updater feed).
- **Depends on / Blocked by:** Apple Developer enrollment ($99/yr); Azure Trusted Signing enrollment (~$120/yr) + AAD OIDC federation; `feat/build-pipeline` (this branch) shipped first so the composite action exists.
- **Owner:** `feat/release-pipeline` (#17 in master plans-overview).

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

## Typeahead normalization session with Derek

`feat/file-tree` ships keyboard typeahead with default normalization rules: case-insensitive prefix match on the displayed label string, no special handling for section symbols (`§`) or numeric prefixes. Real legal-research workflows likely have opinions on this that we can't predict from outside the use case.

- **What:** After `feat/file-tree` ships and Derek dogfoods it for ~2 weeks, schedule a 30-min session to validate or evolve the typeahead normalization rules. Concrete questions: should typing `1` jump to `§ 1.01` or `Title 1` or `Chapter 1.04`? Should `§` be stripped before matching? Case-folding edge cases (`ARTICLE 1` vs `Article 1` from typing `a`)? Numeric vs alpha behavior?
- **Why:** Default normalization is a guess. Each rule we get wrong wastes Derek's keystrokes; each rule we get right makes him faster. The cost of being wrong is small (one-file edit in `src/corpus-nav/filter-predicate.ts` or `src/ui/left-panel/file-tree/use-typeahead.ts`) but the cost of never asking is permanent suboptimality.
- **Pros:** Validates a real product assumption with the actual user; cheap to act on.
- **Cons:** Requires Derek-time; outcomes may be inconsistent with screen-reader expectations (need to test both paths).
- **Context:** Surfaced by `feat/file-tree` /plan-eng-review (2026-05-05) D8. The Layer 3 predicate primitive makes any normalization change a one-file edit, so deferring rule decisions is cheap.
- **Depends on / Blocked by:** `feat/file-tree` shipped; Derek dogfood session scheduled.
- **Owner:** `feat/file-tree` polish PR or a `feat/derek-feedback-loop` branch.

---

## CorpusRef extension fields (version, anchor, revision)

`feat/file-tree` ships `src/corpus/refs.ts` with the minimal canonical type: `{ module: ModuleId, section: SectionId }` (opaque-tagged). Three extension fields are documented but not implemented: `version` (citation pinning), `anchor` (sub-section addressing for annotations), `revision` (point-in-time view for revision compare). Each field lands when its first real consumer exists.

- **What:** Extend `CorpusRef` (in `src/corpus/refs.ts`) with the named field when each consumer branch lands:
  - `version: ModuleVersion` → owned by `feat/citation-resolution`. Pins a citation to the cited section's version-at-time-of-citation so renumbering doesn't silently change meaning.
  - `anchor: string` → owned by `feat/annotations`. Addresses a position within a section (subdivision letter, paragraph number) so an annotation survives section-text edits that don't touch its anchor.
  - `revision: ModuleVersion | "latest"` → owned by `feat/revision-compare`. Resolves the section as it existed at the named version.
- **Why:** Pre-designing all three fields without their consumers risks getting the shape wrong (interfaces designed before the second impl is real). Pre-stubbing the slot in `refs.ts` makes the extension obvious to the next dev and keeps the canonical type centralized.
- **Pros:** Each consumer branch makes a one-file edit to `refs.ts`; foundation evolves with real requirements.
- **Cons:** Requires discipline — when the consumer branch lands, the dev must remember to extend `refs.ts` rather than working around it with an ad-hoc wrapper type.
- **Context:** Surfaced by `feat/file-tree` /plan-eng-review (2026-05-05) D10 + D12. Layer 0's mitigation against premature abstraction is "ship minimal, extend on demand" — this TODO captures the extension-on-demand intent.
- **Depends on / Blocked by:** Each consumer branch lands separately.
- **Owner:** Distributed across `feat/citation-resolution`, `feat/annotations`, `feat/revision-compare`. This TODO is the cross-branch index.

---

## Command palette virtualization + debounce

`feat/electron-shell` shipped a placeholder section-finder palette (`src/ui/chrome/command-palette.tsx`) at Phase 1. At SF Municipal scale (11,659 sections), the per-keystroke filter is a synchronous full-list scan + lowercase + DOM-render-every-match — ~hundreds of ms of jank per keystroke. The filter is correct; the rendering shape is the problem.

- **What:** In `feat/command-palette` (branch #10), replace the current implementation with: (a) `useDeferredValue` or a 50-100ms debounce on the input string; (b) a precomputed lowercase index built once when `corpus.tree` arrives (avoid per-keystroke `${num} ${name} ${path}.toLowerCase()` allocations); (c) `@tanstack/react-virtual` over the matched-items list (the same dep `feat/file-tree` already pulled in for the tree); (d) a result cap (e.g. top 200 matches) so worst-case typing of single common letters doesn't paint thousands of buttons.
- **Why:** The palette is the second half of the perf cliff surfaced 2026-05-06 alongside the file-tree click latency. The tree fix shipped in `feat/file-tree`; the palette fix logically belongs in `feat/command-palette` (which is already in the decomp plan to layer the `commandRegistry` primitive on top of the placeholder). Folding both into one PR was rejected during scoping — palette virt is self-contained polish on a UI component, not a load-bearing-contract change.
- **Pros:** Single coherent rewrite at the time the branch is owned by the palette work; matches VS Code's debounced-+-virtualized Quick Open model; the v1.0 wedge release at week 3 doesn't gate on this (the palette isn't in the wedge surface).
- **Cons:** Until `feat/command-palette` lands, ⌘P remains laggy. Acceptable because the wedge browse loop is tree-driven, not palette-driven.
- **Context:** Surfaced 2026-05-06 alongside the file-tree click-latency report. Tree virt landed in `feat/file-tree` as a wedge-blocker; palette virt was deferred to its owning Phase 3 branch via the 2026-05-06 split decision (see this commit + plans-overview "Updated 2026-05-06" note).
- **Depends on / Blocked by:** `feat/command-palette` (#10) starting.
- **Owner:** `feat/command-palette` (#10).

---

## Default file-tree expansion at scale

`feat/file-tree`'s `defaultExpansion(tree, maxDepth=1)` auto-expands codes (depth 0) and chapters (depth 1) on first launch, which reveals every section leaf at depth 2. At SF Municipal scale that's ~12,000 visible rows on cold start. Virtualization (also shipped in `feat/file-tree`) makes this performant, but the UX of "everything spilled open" may not be what users want — VS Code's mental model is "top-level visible, click to expand."

- **What:** Decide whether the v1.0 default should be `maxDepth=0` (only modules visible, sections hidden under their chapters until expanded) or stay at `maxDepth=1` (current behavior; sections all visible). Either way, the per-user choice could be persisted via `feat/sqlite-state` later.
- **Why:** Surfaced as a side-effect of investigating the click-latency report — the catastrophic visible-row count is a defaults choice, not a tree-shape constraint. Virtualization makes it OK; UX research would say which is right.
- **Pros (maxDepth=0):** Tighter cognitive load on cold start; matches VS Code/Finder/Explorer mental model; encourages users to navigate by code → chapter → section. **Cons:** Two extra clicks to reach any leaf section first time.
- **Pros (maxDepth=1, current):** Section browsing without disclosure-triangle hunting; closer to "everything is searchable from the keyboard." **Cons:** Visually overwhelming on cold start; default state has no narrative.
- **Context:** Surfaced 2026-05-06 during file-tree perf investigation. Not a perf concern after virtualization — pure UX call. Derek's dogfood feedback is the right signal.
- **Depends on / Blocked by:** Derek dogfood session (overlaps with the typeahead-normalization session already on TODOS.md).
- **Owner:** `feat/file-tree` polish PR or `feat/derek-feedback-loop`.

---

## Plan-archive cleanup: structure-tree.tsx promises about feat/file-tree

The current `src/ui/left-panel/structure-tree.tsx` comment block (lines 6-8) says it'll be "replaced wholesale by feat/file-tree (Phase 2)" and that feat/file-tree adds "search-box wiring, pending dots, ordinances-mode panel, and chapter-roll-up indicators." The current `feat/file-tree` design (post-/plan-eng-review) explicitly defers ALL of those: search → `feat/ripgrep-search`, pending dots → `feat/ordinance-ingestion`, ordinances panel → `feat/ordinance-ingestion`, chapter-roll-up → not in any current plan. When this branch deletes structure-tree.tsx, those stale promises vanish — but if anyone fetched the design archive, they're misled.

- **What:** When `feat/file-tree` lands and deletes `structure-tree.tsx`, also update the plan archive (`~/.gstack/projects/richard-ash-legiscode/richardash-feat-file-tree-design-*.md` is the live one; check for any older copies in the archive directory) to reflect what `feat/file-tree` actually shipped vs what the original `structure-tree.tsx` placeholder anticipated. Specifically: confirm the search/dots/panel work is correctly attributed to the owning branches (`feat/ripgrep-search`, `feat/ordinance-ingestion`).
- **Why:** Plans rot when they don't get updated post-ship. A future dev fetching the archived plan would get a misleading picture of what shipped in `feat/file-tree`. Cheap insurance against future archeological confusion.
- **Pros:** Five-minute cleanup; plan archive stays accurate.
- **Cons:** None — pure housekeeping.
- **Context:** Surfaced by `feat/file-tree` /plan-eng-review (2026-05-05) D13.
- **Depends on / Blocked by:** `feat/file-tree` shipped (the deletion happens here).
- **Owner:** This branch (small cleanup commit at the end) OR `feat/docs-rebuild` (next docs housekeeping pass).
