# TODOS

Format: each item is a heading, with a one-line summary, **What/Why**, **Pros/Cons**, **Context**, **Depends on / Blocked by**, and an owner branch (or `unowned`).

Add items aggressively; remove them when shipped or when superseded by a real plan.

Reconciled 2026-05-19: 9 of 18 plan branches merged (Phase 2 complete). Every item below points at a real plan-overview branch, a micro-PR, or an operational action.

---

## Citation refoundation follow-ups (feat/citation-resolution 2026-05-20)

- **CR-roman — Structural citations in Roman numerals not captured.** The widened regex only matches `\d+` so "Article V" / "Chapter XII" miss. SF Charter's articles are predominantly Roman, so a meaningful fraction of `Article N`-style citations slip past the parser. Fix: extend the structural-prefix pattern with a Roman alternation (`\b[IVXLCDM]+\b`) and add a Roman→Arabic normalizer to the `structural` target so the resolver can look up the chapter node consistently. Owner: unowned; queue for v1.1.
- **CR-structural-lookup — `findStructuralRef` is best-effort.** Currently walks the corpus tree looking for chapter nodes whose `code` starts with `{LEVEL} {N}` (trying both arabic and Roman). Doesn't handle hyphenated identifiers, multi-segment numbers (e.g. "Chapter 12.4"), or cross-module structural references. Fix: build a structural index at corpus-load time keyed by `(module, level, number)` — same shape the renderer wants. Owner: unowned; queue for v1.1.
- **CR-popover-content — Popover body is empty for resolved cites.** The popover renders header + footer correctly but doesn't yet fetch the target section's title or first-paragraph excerpt; the App-side `resolveCitation` returns only the verb-shaped `ResolutionResult`, not the section content. Fix: extend the existence oracle with a `lookupTitle(ref)` (and optional `lookupExcerpt(ref)`) so the popover can render the resolved title + body excerpt per the 2026-05-19 mockup. Owner: unowned; near-term polish, before the public Phase-3 demo.
- **CR-unresolved-cross — RESOLVED in Phase 4 refoundation.** The 9,308 unresolved-cross bucket collapsed to 2,332, all of which are cites to external CA/US modules genuinely not in this build. The intra-unresolved gate now means "0" for real (binder reclassifies bindable-shape-but-actually-unbindable cites as `vague` rather than dumping to cross-unresolved). Cross-module slips moved into the binder's sibling-fallback pass. Owner: shipped via PR #25.
- **CR-charter-appendix — RESOLVED in Phase 4 refoundation.** SF Charter appendix sections (`a8.559`, `d3.750`) and the `a`/`d` prefix fallback are now manifest-driven via the `display_rules.extra_prefixes` knob, applied uniformly through the binder. The hardcoded validate-corpus.ts hack was deleted. Owner: shipped via PR #25.
- **CR-shell-openExternal-unused — `shell:openExternal` IPC is registered but has no caller.** The 2026-05-20 refoundation removed every renderer-side call site (popover ⌘-click on not-installed modules is a no-op by design). The handler stays for a future "Open at source →" affordance on the popover. Fix: either ship the affordance or remove the IPC. Owner: unowned.
- **CR-popover-unit-tests — `citation-popover.tsx` (new file, 124 lines) has no dedicated unit test.** The four kind-discriminated body branches (module-not-installed, scroll-only, navigate-*, unresolvable→null) and footer rendering are only covered indirectly via App-level integration tests. Fix: add `test/ui/center-panel/section-view/citation-popover.test.tsx` exercising each branch with `render({ result, anchorRect })`. Owner: unowned; v1.1 polish.
- **CR-hover-dispatch-tests — `section-view.tsx` hover dispatch has no test.** The 400ms show timer, 200ms hide timer, Escape-key handler, mouseover→resolveCitation→setHoverState wiring, and anchorRect positioning are unverified by unit or e2e tests. Fix: add a `section-view-hover.test.tsx` using `vi.useFakeTimers()` to assert the show/hide timing contract. Owner: unowned; v1.1 polish.

---

## File-tree review deferrals (feat/file-tree round-1 review)

Adversarial /review on `feat-file-tree` (2026-05-06) surfaced findings beyond
F1 (boundary ref validation, fixed in `feat/file-tree`) and F12 (typeahead onBlur
reset, fixed in `feat/file-tree`). These were intentionally deferred.

**Shipped 2026-05-19 in `feat/file-tree-polish` (PR #24):** F-perf (`rowIndexById: ReadonlyMap<string, number>` threaded as a required field, no findIndex fallback per D6), F-pendingFocus (clear stash on collapse race), F-sticky (VSCode-style ancestor pinning under virtualization).

Remaining:

- **F2 — Stale `legiscode.activeSection` legacy key never deleted when valid `legiscode.openItems` exists.** `src/persistence/storage.ts:135` returns the parsed new value immediately, leaving the legacy key behind. If a future schema bump corrupts `openItems`, the fall-through migration silently rolls user state back to whatever was at first migration. Fix: remove legacy key on the line that returns the valid new value (~3 lines). Owner: `feat/sqlite-state` (#14) — same branch that's already inheriting all persistence concerns.
- **F3 — `corpus.read` returning `{ ok: false }` silently leaves stale section visible.** `src/ui/App.tsx:117` only sets section on `r.ok=true`. Today the loader doesn't produce mid-session domain errors, but the contract permits them. Fix: route ok:false to either `setCorpusError` or `setSection(null)`. Owner: `feat/sqlite-state` (#14).
- **F7 — Out-of-range persisted `activeIndex` blanks the center forever.** `src/persistence/storage.ts:46` schema accepts any int; `fromPersisted` maps out-of-range to null; `App.tsx:71` only seeds `defaultRef` when `items.length===0`. Persisted `{items:[A,B,C], activeIndex:999}` cold-starts with 3 tabs but no active section. Fix: when activeIndex remaps to null but `items.length>0`, promote `items[0]` to active. Owner: `feat/sqlite-state` (#14).
- **F-palette — `⌘B` collapses the panel underneath an open command palette.** Three `window` keydown handlers (App.tsx:131, three-panel.tsx:46, file-tree onKeyDown) compete with no focus-trap coordination. Fix: palette dialog stops keydown propagation, OR three-panel checks `document.activeElement` is inside `[role=dialog]`. Owner: `feat/command-palette` (#10).
- **F-empty-css — `.lc-tree-empty` and `.lc-tree-empty-caption` referenced in `file-tree.tsx:169` but not styled in globals.css.** Branch shouldn't fire in Phase 1 per DESIGN.md but is reachable defensively. Fix: add 8 lines of CSS or drop the class hooks. Owner: `feat/ripgrep-search` (#8) — the branch that makes the empty branch actually reachable via filter.

---

## Section-view scope cuts (feat/section-view scope-reduction 2026-05-06)

`/plan-eng-review` on `feat-section-view` (2026-05-06) cut the following from
the v1.0 wedge to ship the readable-section experience to Derek faster.
Each has a designated owning branch for re-introduction.

Re-introductions bundled into the new `feat/section-view-polish` (#19) tail branch, mirroring `feat/file-tree-polish` (#18). Lands when Derek dogfood validates priority.

- **Line numbers (40px JetBrains Mono gutter).** DESIGN.md spec'd it; cut
  because legal cites reference `(a)(2)` subsection labels, never display
  lines (which change with viewport width). Westlaw/LexisNexis don't ship
  line numbers over section text. Re-introduce only if Derek dogfood surfaces
  a concrete "I wish I could cite line N" need. Owner: `feat/section-view-polish` (#19).
- **Minimap (44px right edge).** VS Code uses minimap for code with structural
  visual texture; serif legal text doesn't have that, and most SF sections fit
  on one screen. Re-introduce if a long-section navigation pain surfaces in
  real reading sessions. Owner: `feat/section-view-polish` (#19).
- **Slot extension points** (`<SectionView slot="diff-banner" />`,
  `<SectionView slot="annotations" />`). Plan archived these as the
  integration mechanism for downstream branches per the master plans-overview
  Conflict Flags. Cut because pre-designing slot shapes before the consumer
  branches exist risks getting the seam wrong (memory
  `feedback_minimum_shapes.md`). Each consumer adds its own slot when it
  lands: `feat/citation-resolution` (#9) for annotations on cited sections;
  `feat/diff` (#12) for diff-banner; `feat/sqlite-state` (#14) for annotation
  overlays; `feat/ai-agent` (#13) for per-section chat anchor. Phase 3-5
  sequencing means parallel-merge risk is low. If two consumers DO need to
  overlap, the second-lander introduces a slot dispatcher (~20 LOC) at that
  moment with a real shape in hand. Owner: distributed across consumers as listed.
- **Print-friendly CSS.** Cut because "lawyers print" is asserted, not
  validated. Re-introduce after first Derek/lawyer feedback round says they
  print and tells us what they print (full section? selected paragraphs?
  with or without citations expanded?). Owner: `feat/section-view-polish` (#19).
- **Section header metadata: enacted ordinance + last amended ordinance + date.**
  `SectionFileSchema` (in `src/types/section.ts`) has no `enacted_at` / `last_amended`
  fields and the parser doesn't extract them yet. Owner split: **schema + parser
  extraction lands as a micro-PR direct to main** (small, additive); **renderer-side
  consumption** lands in `feat/section-view-polish` (#19).
- **Clickable breadcrumb parent navigation.** Cut 2026-05-07 from feat/section-view
  via /plan-eng-review outside-voice (codex). The original D4 plan had clickable
  parent labels dispatching to a file-tree imperative `scrollAndReveal(rowId)` API
  with ancestor expansion + virtualizer-timing handling — 80-150 LOC for a secondary
  affordance with real edge cases. Cut because non-clickable parents are usable in
  the wedge and `feat/tabs` (#7, now merged) plus the nav pipeline make the right
  plumbing obvious. Owner: `feat/section-view-polish` (#19) — the nav pipeline
  question is now answered, so this can dispatch through the same route layer rather
  than imperatively into the file-tree.
- **Defined-term tooltip: rank multi-section definitions for readability.**
  Surfaced 2026-05-09 while reviewing §11.1 ("DEFINITIONS" in sf-cable). The
  tooltip currently lists every defining section in section-id order — for
  common terms ("City") that's 5+ entries spanning unrelated chapters, with
  no signal which one applies in the current reading context. Three polish
  passes worth doing before public release:
    1. **Group by chapter scope.** "In this chapter: § 11.1" then "Elsewhere
       in this code: § 15.1, § 22a.2, …".
    2. **Sort by likelihood-of-applies.** Same-module first, then alphabetic
       by chapter, then cross-module last.
    3. **Truncate long lists.** First 3 rows + "Show 2 more" disclosure when
       count > 4.
  None are wedge blockers; bundle as one focused PR. Owner: `feat/section-view-polish` (#19).
- **Pre-launch CI gate on `mise run validate:full`.** Surfaced 2026-05-07 by
  /plan-eng-review outside-voice (codex). Today `validate:full` is operator-driven
  (per `mise.toml` task description: "Operator-driven, NOT in CI"). The wedge can
  ship and pass while full SF body[]/citation/definition rendering is unexercised
  — only the bundled subset (Chapter 10.04) is rebuilt by feat/section-view's
  D-DELTA-1 regen step. Before any public release, add a CI workflow that runs
  `validate:full` against a checked-in production HTML snapshot and asserts the
  same 0%-skip / 100%-TOC-coverage / 100%-citation-resolution gates. Owner:
  `feat/release-pipeline` (#17) — the branch that owns the release-gate surface.
- **Parser emits definitions.json keys with stray whitespace.** Surfaced
  2026-05-08 while implementing feat/section-view's D-DELTA-2 (loader joins
  module's definitions.json into corpus:read). The operator-built dev corpus
  (`build/modules-full/`) carries ≥6 modules whose `definitions.json` has keys
  with leading newlines (e.g. `"\nCity"`) or trailing spaces (e.g. `"...third
  party "`) that violate `DefinedTermSchema`'s `^\S(?:.*\S)?$` regex. The loader
  soft-fails per-key (logs once per module summarizing the dropped keys, projects
  the rest), so the wedge boots and most tooltips work. Fix the upstream parser
  (extract defined-term keys with `.trim()` plus a `DefinedTermSchema.safeParse`
  gate on emit) so future definitions.json files arrive clean and the loader
  can flip back to hard-fail. Owner: **micro-PR direct to main** (small, isolated
  parser fix); fold into `feat/citation-resolution` (#9) if convenient when that
  branch starts, since it'll next touch the defined-term path.
- **Parser tokenizes defined terms too short.** Surfaced 2026-05-09 in §2a.81
  ("POLICE; TRAFFIC REGULATION"). Body[] highlights bare "Department" instead
  of the full proper noun "Department of Public Works" / "Department of City
  Planning" / "Fire Department" the surrounding sentence is naming. The match
  is technically correct — "Department" *is* a defined term in sf-administrative
  — but the reader has no signal which department, since legal drafters use
  capitalized "Department" as a shorthand for whichever full name was introduced
  earlier in the article. Fix: in the parser's defined-term emit pass, prefer
  the LONGEST defined-term phrase that matches at any given offset (replace the
  current first-match-wins with longest-match-wins), so "Department of Public
  Works" wins over "Department" when both are in scope. Requires emitting the
  full phrases as defined terms (definitions.json today only has "Department",
  not "Department of Public Works") OR having the parser walk the surrounding
  prepositional phrase and extend the highlight client-side. Owner: **micro-PR
  direct to main** OR fold into `feat/citation-resolution` (#9) if convenient.

---

## Re-enable Phase-1-hidden chrome elements when their backing systems ship

`feat/electron-shell` ships the chrome from the Claude Design handoff but **hides two elements** the mockup shows because their backing systems don't exist in Phase 1. Each has a designated owning branch.

**Cut from v1.0 (2026-05-19):** Bell (notifications), Share (share-section-URL), activity-bar Pin/Account, activity-bar Settings. None had backing-system branches on the v1.0 roadmap and per `feedback_no_placeholder_ui.md` we don't ship placeholder UI. They're now in the plan-overview's "NOT in scope" section; future branches that ship a notifications / sharing / account system reintroduce the affordance themselves.

Remaining:

- **What:** Re-enable each of these chrome elements when its owning branch ships:
  - `lc-sync` indicator (titlebar) → `feat/module-manager` (#16, v1.1+) — turns on the day cross-machine sync ships
  - "+ Ask" tab affordance (tab bar) → `feat/ai-agent` (#13, Phase 5) — adds chat tab kind + the affordance
- **Why:** Phase 1 follows the "don't render UI for capability that doesn't exist" rule. Each hidden element has a documented re-enable trigger; this TODO is the cross-branch coordination point so they don't get forgotten or accidentally reintroduced.
- **Pros:** Single tracking point for the two remaining deferred items; future devs know which branch owns each re-enable; prevents dead UI from drifting back into Phase 1 via mockup-fidelity arguments.
- **Cons:** None — minimal cost, real value as cross-branch index.
- **Context:** Surfaced by `feat/electron-shell` /plan-design-review on `feat-electron-shell` (2026-05-05). Mockup at `https://api.anthropic.com/v1/design/h/cwT4ElTPhtoFd9vZt3e7cw` shows all six elements; Phase 1 deliberately leaves them unrendered. Four cut 2026-05-19 via /office-hours reconciliation.
- **Depends on / Blocked by:** Each element's owning branch (listed above).
- **Owner:** Distributed across owning branches — this TODO is the index, not a single-branch task.

---

## Tabs v1.1 polish (feat/tabs design review 2026-05-10)

`/plan-design-review` on `feat-tabs` (2026-05-10) explicitly deferred two power-user paths from v1 because they're not wedge-critical and would extend scope past the locked plan. Documented here so the v1.1 polish branch picks them up as a unit. Two overflow-ergonomics items added 2026-05-18 from manual testing of feat/file-tree-polish.

- **What:**
  1. Modifier-click semantics on `.lc-tab-close`: Cmd+click X = close-others, Alt+click X = close-to-the-right. Mirrors VS Code's tab close-modifier semantics.
  2. Right-click context menu on `.lc-tab`: Close / Close Others / Close to the Right / Pin Tab (Pin defers to its own v1.1 pinning feature). Lightweight popover anchored to the tab; arrow-key navigable.
  3. Overflow affordance on `.lc-tabs`: today `overflow-x: auto` with the scrollbar hidden (`globals.css:468`) means mouse-only users have no way to reach offscreen tabs and no signal that they exist. Add a chevron-`⌄` overflow menu at the right edge listing all tabs (alphabetical or open-order, click-to-activate, arrow-key navigable, mirrors VS Code's "Show Opened Editors"). Edge-fade gradient on the scroll edge is a cheap additional signal but the menu is the load-bearing fix.
  4. Active-tab privileged width: today `.lc-tab` and `.lc-tab.is-active` both use `flex: 0 1 auto; max-width: 240px` (`globals.css:481/509`), so under pressure all tabs ellipsize at the same rate and the active title becomes unreadable when 15+ tabs are open. Add `flex-shrink: 0` + a wider `min-width` to `.is-active` so inactive tabs shrink first (Chrome/Safari pattern). Pairs with #3: the menu handles "too many to fit," the privileged width handles "the one I care about stays readable."
- **Why:** v1 covers every browse-loop close path (⌘W + middle-click + visible X) but lacks the bulk-close affordances heavy users reach for after a long session, and the v1 strip is silent about overflow (scrollbar hidden by design, no chevrons, no menu). Discoverability via right-click + a visible overflow chevron is the conventional path on every IDE / browser they already use.
- **Pros:** Closes the "I have 12 tabs and need to clear most of them" friction in one branch; matches VS Code muscle memory; right-click menu is a natural home for future commands (Move to New Window, Duplicate). Bundling overflow + privileged-width with the close-menu work shares the same use-tabs hook surface and popover component (overflow menu reuses the right-click menu's positioning + a11y plumbing).
- **Cons:** Right-click menu adds a small component surface (popover positioning, outside-click dismiss, keyboard a11y) that the v1 strip avoids; close-others/close-to-right need new use-tabs hook methods + tests. Overflow menu raises a sort-order decision (open-order vs alphabetical vs MRU) that needs a /plan-design-review pass before locking.
- **Context:** Surfaced by /plan-design-review Pass 7 on the locked feat/tabs plan. The plan's `## Visual Spec` and `## Accessibility & responsive` sections already establish the patterns (ARIA tablist, roving tabindex, close-button aria-label) that v1.1 polish will extend. Items 3-4 surfaced 2026-05-18 during manual QA on `feat/file-tree-polish`.
- **Depends on / Blocked by:** `feat/tabs` v1 shipped (PR #17, merged 2026-05-18).
- **Owner:** `feat/tabs-polish` (#20).

---

## Production release pipeline

Production sign + notarize + publish lives on a separate branch — `feat/build-pipeline` ships PR-side CI only. The release branch is blocked on credentials (Apple Developer cert + Azure Trusted Signing) that aren't yet in hand.

Scope expanded 2026-05-19 to bundle three orphaned items (module index hosting, scheduled corpus refresh, multi-producer @/corpus dispatch) — all share the publishing-secrets and CI-workflow surfaces.

- **What:** Implement `feat/release-pipeline` per the design at `~/.gstack/projects/legiscode/richardash-feat-release-pipeline-design-20260505-180700.md`. Core: `release.yml` (tag-triggered), macOS `mac.notarize: true` + entitlements.plist, Windows `win.azureSignOptions` (Azure Trusted Signing), `electron-builder --publish always`, validate-before-publish ordering (sign → notarize → staple → `xcrun stapler validate` → `spctl --assess` → publish), `verify-secrets` pre-flight job, `packaged-csp.spec.ts`, `RELEASING.md`. **Expanded scope:** also owns the scheduled corpus refresh workflow, the module hosting/index decision, and the dispatch layer for `@/corpus.buildCorpus` as a second producer (cron is the most likely first second-producer).
- **Why:** v1.0 is a paid product; users won't double-click an unsigned `.dmg`/`.exe`. Notarization gates macOS Gatekeeper; Authenticode signing gates Windows SmartScreen. The expanded scope groups every "publish-to-a-CDN-on-a-schedule" surface under one branch, sharing OIDC trust + secret rotation.
- **Pros:** Decouples release from build; composite `setup-and-build` action is reused; `build-matrix.yml` is `workflow_call`-reusable so release.yml chains the same verify before signing. Estimated v1 fixed cost ~$230-260/yr.
- **Cons:** Blocked on creds. Branch is bigger than originally scoped.
- **Context:** Originally scoped into `feat/build-pipeline`; rescoped out 2026-05-05 during /plan-eng-review. Codex's 16 review findings are absorbed into the release-pipeline design.
- **Depends on / Blocked by:** Apple Developer enrollment ($99/yr); Azure Trusted Signing enrollment (~$120/yr) + AAD OIDC federation; `feat/build-pipeline` (now shipped) so the composite action exists.
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
- **Owner:** `feat/release-prep` (#15) — v1.1 polish window.

---

## CSP `connect-src` extension for Anthropic API

`feat/electron-shell` Phase-1 prod CSP is `default-src 'self'; connect-src 'self'`. When `feat/ai-agent` ships, the renderer needs to call the Anthropic API (or via main-process proxy — choose during ai-agent design).

- **What:** When `feat/ai-agent` lands, extend prod CSP `connect-src` to include `https://api.anthropic.com` (or omit if the call happens in main process and the renderer never sees the domain). Decide based on ai-agent's IPC vs direct-call architecture.
- **Why:** Without this update, the four-hard-rules citation-verification flow's network calls get CSP-blocked in prod. Failure mode would only show up in packaged builds, not dev.
- **Pros:** Prevents a notorious failure mode (works in dev, breaks in prod).
- **Cons:** None — small addition.
- **Context:** Surfaced by `feat/electron-shell` /plan-eng-review (2026-05-04). The architecture decision (renderer-direct vs main-proxy) is `feat/ai-agent`'s call; this TODO just makes sure CSP gets updated whichever way.
- **Depends on / Blocked by:** `feat/ai-agent` design pass.
- **Owner:** `feat/ai-agent` (#13).

---

## Cross-module version compatibility policy

Modules are versioned independently (`sf-municipal@2026.04`, `ca-vehicle@2025.12`, `us-federal@2026.03`). When SF MC v2026.04 cites Cal. Veh. Code § 22358 and the user has CVC v2025.01 installed, what does the citation resolver do?

**Status (2026-05-19, set by `feat/citation-resolution` /plan-eng-review D4):** v1 picks **best-effort** against the installed corpus — resolve when the (module_id, section_id) exists in the in-memory corpus tree, else mark unresolvable. No version-skew check. Acceptable because v1 ships all SF Municipal sub-modules as one bundle; version skew is theoretical until multi-jurisdiction is installable.

Remaining work for the multi-jurisdiction era (post-v1):

- **What:** Add a version-skew detection layer on top of the best-effort policy. Options still on the table: (b) frozen — pin each module's references.json to a `built_against: {module_id, version}` map; (c) hybrid — best-effort + AI agent surfaces "I followed this citation but the target section may have been renumbered." Both deferred until module-manager v1.1+ lets users install modules at different versions.
- **Why:** v1's best-effort is correct *while* every module ships as one bundle. As soon as that breaks, silent semantic drift becomes a real failure mode.
- **Pros (frozen):** Honest about what the citing module knew. **Cons:** Resolution rate drops as modules age.
- **Pros (hybrid):** Best UX. **Cons:** Most complex; depends on AI agent's verification flow being load-bearing.
- **Context:** `feat/corpus-parser` round 1 codex review (2026-04-30) flagged the schema accepts cross-module citations but no resolution semantics. v1 policy locked 2026-05-19 in `feat/citation-resolution` /plan-eng-review.
- **Depends on / Blocked by:** `feat/module-manager` v1.1 (the natural trigger).
- **Owner:** `feat/module-manager` (#?) — version-skew handling is naturally co-located with the install/version-pin surface, not citation-resolution.

---

## `amlegal-base` vs `sf-amlegal` parser split

`feat/corpus-parser`'s parser-correctness PR added jurisdiction-agnostic logic (the editorial-chrome classifier works for any AmLegal HTML) and SF-specific logic (`Note\d+`/`-\d+` JD-anchor suffix stripping; SF Charter's appendix conventions; sf-planning's map-sheet headers). They live mixed in `src/parser/parse-html.ts` because the right split is speculative until parser #2 surfaces a different convention.

- **What:** Extract jurisdiction-specific code paths from `src/parser/parse-html.ts` into `src/parser/sf-amlegal/`, leaving the generic `src/parser/amlegal-base/` as the shared substrate. The `parser_strategy` field in `JurisdictionManifest` already routes to the right parser; this just makes the routing real.
- **Why:** Every SF-specific pattern added to `parse-html.ts` is one we'll have to extract later. Cost grows linearly. Resolve before parser #2 arrives.
- **Pros:** Clean inheritance/composition for future jurisdiction parsers; the deep-module promise stays honored. Makes parser #2 a 1-week project instead of a 1-month archaeology dig.
- **Cons:** Speculative until parser #2 has real requirements. Done too early, the seams are wrong; the right split is obvious in hindsight after seeing one alternative jurisdiction's HTML.
- **Context:** Surfaced by `feat/corpus-parser` /plan-eng-review on `feat-corpus-parser` (2026-05-04). Deliberately deferred — extracting before a second jurisdiction is in hand picks the wrong seams.
- **Depends on / Blocked by:** Real parser #2 candidate (LA Municipal? NYC?). Don't extract until at least one alternative jurisdiction's HTML is in hand.
- **Owner:** `feat/jurisdiction-2` (speculative branch — not in plan-overview yet; create when a real jurisdiction #2 candidate lands).

---

## Wire `InterCodeLink` graph + `UnresolvedInterCodeLinkWarning` through `@/corpus`

Code comments in `src/parser/parse-html.ts` and `src/parser/references.ts` reference an `InterCodeLink` graph and an `UnresolvedInterCodeLinkWarning` that aren't yet implemented through the pipeline. Cross-module citation resolution is the runtime feature this enables.

- **What:** Implement the `InterCodeLink` aggregation in `@/corpus`'s pipeline (after parseExport, before validateCorpus); surface `UnresolvedInterCodeLinkWarning` entries to `BuildResult.citations.unresolvedCross[]`. Already-built scaffolding in `parse-html.ts:849-895` extracts `InterCodeLink` data; this just wires it through.
- **Why:** Cross-module citation reporting is a published surface (`BuildResult.citations.unresolvedCross`) but the wiring through pipeline isn't built. Without it, the field exists but is always empty.
- **Pros:** Closes the loop on the corpus-level cross-module reporting promise. Required before `feat/citation-resolution` can do anything useful with cross-module links.
- **Cons:** None — the data extraction is already there, only wiring is missing.
- **Context:** Surfaced by `feat/corpus-parser` /plan-eng-review (2026-05-04). Mentioned in code comments since round-12 of the original parser PR; punted out of the correctness PR to keep scope tight.
- **Depends on / Blocked by:** Nothing — `validateCorpus` already lives in `@/parser` and is wired through `@/corpus`.
- **Owner:** `feat/citation-resolution` (#9) — first cross-module feature consumer.

---

## CorpusRef extension fields (version, anchor, revision)

`feat/file-tree` ships `src/corpus/refs.ts` with the minimal canonical type: `{ module: ModuleId, section: SectionId }` (opaque-tagged). Three extension fields are documented but not implemented: `version` (citation pinning), `anchor` (sub-section addressing for annotations), `revision` (point-in-time view for revision compare). Each field lands when its first real consumer exists.

- **What:** Extend `CorpusRef` (in `src/corpus/refs.ts`) with the named field when each consumer branch lands:
  - `version: ModuleVersion` → owned by `feat/citation-resolution` (#9). Pins a citation to the cited section's version-at-time-of-citation so renumbering doesn't silently change meaning.
  - `anchor: string` → owned by `feat/sqlite-state` (#14). Annotations are the canonical anchor consumer and persistence is sqlite-state's surface; folding here avoids a separate `feat/annotations` branch.
  - `revision: ModuleVersion | "latest"` → **v1.1+, no branch yet.** Revision-compare is post-v1.0; create `feat/revision-compare` when that work is scheduled.
- **Why:** Pre-designing all three fields without their consumers risks getting the shape wrong (interfaces designed before the second impl is real). Pre-stubbing the slot in `refs.ts` makes the extension obvious to the next dev and keeps the canonical type centralized.
- **Pros:** Each consumer branch makes a one-file edit to `refs.ts`; foundation evolves with real requirements.
- **Cons:** Requires discipline — when the consumer branch lands, the dev must remember to extend `refs.ts` rather than working around it with an ad-hoc wrapper type.
- **Context:** Surfaced by `feat/file-tree` /plan-eng-review (2026-05-05) D10 + D12. Layer 0's mitigation against premature abstraction is "ship minimal, extend on demand."
- **Depends on / Blocked by:** Each consumer branch lands separately.
- **Owner:** Distributed across `feat/citation-resolution` (#9), `feat/sqlite-state` (#14), and future `feat/revision-compare`. This TODO is the cross-branch index.

---

## Live-fetch external citation content (v1.1)

`feat/citation-resolution` v1 ships an external-viewer tab that renders the parsed citation (e.g. "Cal. Veh. Code § 22358") + an "Open at leginfo →" button when the URL synthesizer recognizes the code. v1 has no in-app content — clicking the button calls `shell.openExternal` and bounces the user to leginfo in their default browser.

- **What:** Build a leginfo content fetcher + cache in the main process. External-viewer tab fetches and renders the section's text inline (still read-only, banner still shows "State law — open at leginfo for the canonical version"). HTTP client + on-disk cache with invalidation policy (TTL? content-hash? user-triggered refresh?).
- **Why:** Closes the read loop. Today: user clicks external citation → external tab → external browser → context-switched. v1.1: user clicks → external tab with content → can read inline without leaving the IDE.
- **Pros:** The "go to definition" metaphor extends to state law, not just municipal. Better reading flow for citation-heavy sections. Foundation for AI agent's "follow external citation" tool (which today has nothing to verify against).
- **Cons:** Adds an HTTP client + cache invalidation surface. leginfo.legislature.ca.gov ToS — verify caching is permitted. U.S.C. fetcher is a separate effort (uscode.house.gov has different scraping characteristics).
- **Context:** Originally listed in the 2026-04-28 design doc's "Open questions"; deferred to v1.1 to keep `feat/citation-resolution` scope tight. Locked as v1.1 candidate by /plan-eng-review on 2026-05-19.
- **Depends on / Blocked by:** Nothing — can start any time after `feat/citation-resolution` lands. CSP `connect-src` extension already separately TODO'd for `feat/ai-agent`; same change covers leginfo.
- **Owner:** `feat/citation-resolution-v1.1` or post-v1 polish branch (TBD).

---

## Inline citation preview popover (v1.1)

Hover over a citation link → small floating panel shows the cited section's title + first sentence + "click to open" button. Lets users scan citation-heavy sections without click-and-back navigation churn.

- **What:** Floating-UI-positioned popover triggered by hover on `[data-cite-kind]` elements in section-view. Reads the cited section via `corpus.read({moduleId, sectionId})` on hover-intent (delay 200-300ms to avoid fetch storms on accidental hovers). Keyboard equivalent: focus the link + press a hotkey (suggest `?` per VS Code's quick-info convention).
- **Why:** Reading a paragraph with 8 citations today is "click-back, click-back" × 8. Preview popover collapses that to hover-glance × 8 — closer to how lawyers actually read referenced statutes.
- **Pros:** Low-friction "is this the right ref?" check. Builds on `feat/citation-resolution`'s resolver primitive (preview popover is just another consumer that calls `resolve()` and reads the navigate result).
- **Cons:** Floating-element positioning is finicky (viewport-edge clipping, scroll detachment). Accessibility — screen reader equivalent for hover (already need the keyboard hotkey). Hover-intent debounce calibration.
- **Context:** Originally listed in the 2026-04-28 design doc's "NOT in scope" with "v1.1 candidate" annotation. Locked as v1.1 candidate by /plan-eng-review on 2026-05-19.
- **Depends on / Blocked by:** `feat/citation-resolution` (#9) — needs the resolver primitive.
- **Owner:** TBD (v1.1 polish branch).

---

## Subsection-id collision strategy for v1.1 (conditional)

`feat/citation-resolution` v1 ships subsection scroll anchors with **first-occurrence wins** semantics: section-view emits `id="lc-sub-{label}"` on the first subsection_label with a given label; duplicates render as plain spans. This handles real legal sections (which rarely have ambiguous duplicate top-level labels) but breaks down for sections like `§X(a)(1)` + `§X(b)(1)` where the same "(1)" appears under different parents.

- **What:** Upgrade subsection id strategy to compose ids from the parent chain — e.g., `id="lc-sub-a-1"` for "(a)(1)", `id="lc-sub-b-1"` for "(b)(1)". Requires section-view to track render-time parent context (which subsection_label's children are being rendered). Plus a parser-level decision: does the parser annotate subsection_label segments with their full path, or does the renderer infer it from sibling order?
- **Why:** Defense-in-depth against legal sections with nested duplicate labels. v1's first-occurrence-wins lands the scroll at a wrong-but-not-broken position; v1.1 fixes the wrong-position case.
- **Pros:** Eliminates a class of "back button took me to the wrong (1)" subtle bugs. Cleaner id structure for future per-subsection annotations (`feat/sqlite-state` annotations) and per-subsection diffs (`feat/diff`).
- **Cons:** Speculative until a real corpus surfaces a collision. Premature picks the wrong parent-tracking shape. ~15-30 LOC + test fixtures.
- **Context:** Locked as v1 first-occurrence-wins by /plan-eng-review D14 on 2026-05-19. v1.1 upgrade path captured here.
- **Depends on / Blocked by:** Real corpus collision (sf-municipal or any v1.1 jurisdiction). Re-test the test plan's "duplicate subsection_label" edge case against post-v1 corpora.
- **Owner:** `feat/citation-resolution-v1.1` or whichever branch first encounters a real collision report.

---

## Command palette virtualization + debounce

`feat/electron-shell` shipped a placeholder section-finder palette (`src/ui/chrome/command-palette.tsx`) at Phase 1. At SF Municipal scale (11,659 sections), the per-keystroke filter is a synchronous full-list scan + lowercase + DOM-render-every-match — ~hundreds of ms of jank per keystroke. The filter is correct; the rendering shape is the problem.

Already scheduled inline in plan-overview branch #10's row; this entry exists as a TODO-side pointer with extra implementation detail.

- **What:** In `feat/command-palette` (#10), replace the current implementation with: (a) `useDeferredValue` or a 50-100ms debounce on the input string; (b) a precomputed lowercase index built once when `corpus.tree` arrives; (c) `@tanstack/react-virtual` over the matched-items list (the same dep `feat/file-tree` already pulled in for the tree); (d) a result cap (e.g. top 200 matches).
- **Why:** Until `feat/command-palette` lands, ⌘P remains laggy. Acceptable because the wedge browse loop is tree-driven, not palette-driven.
- **Context:** Surfaced 2026-05-06 alongside the file-tree click-latency report. Tree virt landed in `feat/file-tree` as a wedge-blocker; palette virt deferred to its owning Phase 3 branch.
- **Depends on / Blocked by:** `feat/command-palette` (#10) starting.
- **Owner:** `feat/command-palette` (#10).

---

## Operational: Derek dogfood session

Two TODO items collapse into one operational action: a Derek dogfood session to validate UI defaults that are guesses today. Not branch-shaped; the resulting changes are 1-5 line edits in whichever branch is in flight when the session happens.

- **Typeahead normalization rules** (`feat/file-tree` /plan-eng-review D8). Concrete questions: should typing `1` jump to `§ 1.01` or `Title 1` or `Chapter 1.04`? Should `§` be stripped before matching? Case-folding edge cases (`ARTICLE 1` vs `Article 1`)? Numeric vs alpha behavior? Today's default is case-insensitive prefix match on displayed label, no special handling for `§` or numeric prefixes. The Layer 3 predicate primitive in `src/corpus-nav/filter-predicate.ts` makes any rule change a one-file edit.
- **Default file-tree expansion depth.** Today `defaultExpansion(tree, maxDepth=1)` spills every section open on cold start — at SF Municipal scale that's ~12,000 visible rows. Virtualization makes it perform fine, but the UX of "everything spilled open" may not be what users want. VS Code's mental model is "top-level visible, click to expand." Either maxDepth=0 (only modules visible) or current maxDepth=1 are defensible; Derek's behavior with both decides it.
- **Operational action:** Schedule a 30-min session with Derek after ~2 weeks of wedge dogfood. Bring both questions. Land changes in whichever branch is open at the time (typically a `feat/section-view-polish` or `feat/file-tree-polish` follow-up); the per-user version of either decision later moves into `feat/sqlite-state` (#14) preferences.
- **Owner:** Operational — not a branch. Track session date once scheduled.

---
