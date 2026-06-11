# TODOS

Format: each item is a heading, with a one-line summary, **What/Why**, **Pros/Cons**, **Context**, **Depends on / Blocked by**, and an owner branch (or `unowned`).

Add items aggressively; remove them when shipped or when superseded by a real plan.

Reconciled 2026-05-19: 9 of 18 plan branches merged (Phase 2 complete). Every item below points at a real plan-overview branch, a micro-PR, or an operational action.

---

## Citation refoundation follow-ups (feat/citation-resolution 2026-05-20)

- **CR-roman — Structural citations in Roman numerals not captured.** The widened regex only matches `\d+` so "Article V" / "Chapter XII" miss. SF Charter's articles are predominantly Roman, so a meaningful fraction of `Article N`-style citations slip past the parser. Fix: extend the structural-prefix pattern with a Roman alternation (`\b[IVXLCDM]+\b`) and add a Roman→Arabic normalizer to the `structural` target so the resolver can look up the chapter node consistently. Owner: unowned; queue for v1.1.
- **CR-structural-lookup — `findStructuralRef` is best-effort.** Currently walks the corpus tree looking for chapter nodes whose `code` starts with `{LEVEL} {N}` (trying both arabic and Roman). Doesn't handle hyphenated identifiers, multi-segment numbers (e.g. "Chapter 12.4"), or cross-module structural references. Fix: build a structural index at corpus-load time keyed by `(module, level, number)` — same shape the renderer wants. Owner: unowned; queue for v1.1.
- **CR-unresolved-cross — RESOLVED in Phase 4 refoundation.** The 9,308 unresolved-cross bucket collapsed to 2,332, all of which are cites to external CA/US modules genuinely not in this build. The intra-unresolved gate now means "0" for real (binder reclassifies bindable-shape-but-actually-unbindable cites as `vague` rather than dumping to cross-unresolved). Cross-module slips moved into the binder's sibling-fallback pass. Owner: shipped via PR #25.
- **CR-charter-appendix — RESOLVED in Phase 4 refoundation.** SF Charter appendix sections (`a8.559`, `d3.750`) and the `a`/`d` prefix fallback are now manifest-driven via the `display_rules.extra_prefixes` knob, applied uniformly through the binder. The hardcoded validate-corpus.ts hack was deleted. Owner: shipped via PR #25.
- **CR-open-at-source — "Open at source →" footer affordance is not wired.** The dormant `shell:openExternal` IPC needs a renderer-side consumer; the section-view-polish plan originally scoped this for #19 but A5 verification surfaced the blocker: AmLegal URLs use opaque numeric RecordIDs (`0-0-0-14202#JD_Ch.23Art.V`) rather than the section's `display_label`, so URL substitution via a manifest pattern can't produce correct deep links. Fix is a parser-side anchor-capture pass that stashes the per-section RecordID at parse time, plus a manifest field carrying the AmLegal jurisdiction slug. Once that ships, the affordance lands on both popovers (citation footer + defined-term footer) with the existing `shell:openExternal` IPC as the dispatch path. Owner: follow-up PR; supersedes the previous CR-shell-openExternal-unused framing.

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
- **Clickable breadcrumb parent navigation. SHIPPED in `feat/section-view-polish` (PR #27).** The wire shape gained `parents[].sectionId: SectionId | null`; the loader pre-computes the first contained section per ancestor at load time via `buildAncestorIndex`; both breadcrumb surfaces (chrome strip + in-section kicker) render via the shared `BreadcrumbCrumb` component so the click target / aria-label / module-root-non-interactive rule can't drift. Module-root parents render as plain text (no module overview view to navigate to).
- **Defined-term tooltip: scope-aware single-definer popover. SUPERSEDED by `feat/definitions-foundation` (PR #28) + `feat/section-view-polish` (PR #27).** The original "rank the multi-definer list" framing died with the foundation work — per-occurrence build-time resolution picks a single canonical Definition per `defined_term` occurrence, so the tooltip never shows a list. The follow-up PR rebuilt the popover layout (green-tinted header, scope-resolved excerpt body, single-definer action) on top of the new wire shape. The §37.3 "Department" case (no in-scope definer) gracefully degrades to inline prose with no decoration.
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
  (`build/modules/`) carries ≥6 modules whose `definitions.json` has keys
  with leading newlines (e.g. `"\nCity"`) or trailing spaces (e.g. `"...third
  party "`) that violate `DefinedTermSchema`'s `^\S(?:.*\S)?$` regex. The loader
  soft-fails per-key (logs once per module summarizing the dropped keys, projects
  the rest), so the wedge boots and most tooltips work. Fix the upstream parser
  (extract defined-term keys with `.trim()` plus a `DefinedTermSchema.safeParse`
  gate on emit) so future definitions.json files arrive clean and the loader
  can flip back to hard-fail. Owner: **micro-PR direct to main** (small, isolated
  parser fix); fold into `feat/citation-resolution` (#9) if convenient when that
  branch starts, since it'll next touch the defined-term path.
- **Parser tokenizes defined terms too short — RESOLVED in `feat/defined-term-precision`.**
  Surfaced 2026-05-09 in §2a.81 ("POLICE; TRAFFIC REGULATION"). Body[] highlighted
  bare "Department" instead of the full proper noun "Department of Public Works" /
  "Department of City Planning" / "Fire Department" the surrounding sentence was
  naming. Fixed two ways in the new shared recognition layer (`src/parser/recognize.ts`):
  the glossary trie now does **longest-match-wins** (so "Department of Public Works"
  wins over "Department" when both are defined terms in scope), and a
  **capitalised-extent guard** suppresses a defined-term hit that sits inside a
  longer capitalised proper-noun extent — so a bare "Department" used as shorthand
  for a longer named department no longer lights up as a no-signal link, while a
  standalone "Department" still resolves. Owner: shipped via `feat/defined-term-precision`.

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

## Audit: background mouse actions while a modal is open

Surfaced by `feat/tabs-polish` /plan-eng-review (2026-05-27) via the codex
outside-voice pass. Codex flagged "modifier-click on a tab while the
palette is open" as suspicious UX. The codebase has consistently chosen
the opposite (un-gated background mouse) — middle-click close, plain
X-click, tab activation, file-tree row clicks all fire while a
`role=dialog` modal is open. This works as a working assumption today but
the decision is implicit; a future contributor may flip part of it by
accident and create inconsistency.

- **What:** Audit every mouse handler in the renderer that mutates
  workspace state (tab close / activate / modifier-click, file-tree row
  click, breadcrumb click, settings dropdown rows, future menus). For
  each, decide: should it fire while a `role=dialog` is mounted? Pick a
  consistent rule (current implicit rule: yes), document it in
  CLAUDE.md or `docs/INTERACTION.md` (new), and add a shared guard
  helper (`shouldHandleBackgroundMouseAction()`) if any path needs
  gating. Regression test per audited path.
- **Why:** The implicit consistency is correct for power users (palette
  is search, not modal-by-intent), but it should be a deliberate decision
  with a written rationale. Without it, the next contributor adding a
  modal (confirm dialog, settings panel, future "share section" surface)
  will face the same question and pick differently.
- **Pros:** Surfaces the implicit decision before it becomes a footgun;
  cross-cutting audit deserves its own focused pass rather than per-PR
  re-litigation; produces a shared guard helper if needed.
- **Cons:** Low urgency — no user-reported bug today. Adds an audit
  artifact to maintain.
- **Context:** Codex outside-voice on `feat-tabs-polish` plan-eng-review
  argued that mouse actions on background chrome should be gated by
  modal state. Eng review locked "keep un-gated to match existing
  consistency" for this branch but agreed the cross-cutting decision
  deserves its own audit pass. The shared guard
  `shouldHandleGlobalShortcut` (`should-handle-shortcut.ts`) is the
  precedent shape for the background-mouse equivalent.
- **Depends on / Blocked by:** None.
- **Owner:** TBD — chrome-polish or interaction-consistency branch.

---

## A11y: project-wide reduced-motion audit

Surfaced by `feat/tabs-polish` /plan-design-review (2026-05-27). DESIGN.md's
motion scale (micro 50ms / short 120ms / medium 200ms) is conservative, but
WCAG 2.3.3 (Animation from Interactions) recommends honoring
`prefers-reduced-motion` regardless of duration for vestibular-disorder users.
No audit exists today.

- **What:** Add `@media (prefers-reduced-motion: reduce) { transition: none;
  animation: none }` overrides to every CSS rule with a `transition` or
  `animation` property in `src/styles/globals.css` and any module that adds
  motion. Single cross-cutting commit. Add a Playwright snapshot test that
  toggles the preference and asserts no motion-related computed properties.
- **Why:** Cheap good-citizen pass. Conservative motion budgets don't fully
  exempt us from the recommendation; some users are sensitive to even very
  short transitions, especially on hover state cascades.
- **Pros:** Covers vestibular-disorder users with one focused commit. Sets
  the precedent so new motion automatically gets the override added by
  convention.
- **Cons:** Low urgency — no user-reported issue today. Adds a per-rule
  override that's easy to forget when adding new motion.
- **Context:** /plan-design-review on `feat-tabs-polish` (2026-05-27)
  surfaced this when locking the new menu popover and chevron hover
  transitions. The motion is already below the typical "feels animated"
  threshold, but the audit hasn't happened.
- **Depends on / Blocked by:** None.
- **Owner:** TBD — a11y-polish branch.

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

## Command palette follow-ups (feat/command-palette 2026-05-21)

`feat/command-palette` (#10) shipped the perf rewrite + field-weighted scorer + `:def` subtype + ⌘+Enter background-tab + F-palette regression test + perf budget. Three follow-ups intentionally deferred:

- **Playwright e2e perf check for palette + file-tree + section-view.** This PR ships a hermetic vitest perf budget (`rank()` p95 < 8ms over a 12k-item synthetic fixture). That catches scorer / haystack regressions, but it does NOT measure real-Electron + real-React + virt overhead + GC under load. Owner of the e2e gate: `feat/release-pipeline` (#17) — the natural home for pre-release perf instrumentation. Concrete spec: open the bundled corpus, simulate 20 keystrokes in ⌘P, assert keystroke→paint p95 < 50ms. Same infra amortizes across file-tree and section-view scroll perf gates.
- **Multi-definer disambiguation UX within a module.** D5 in this PR's plan ships per-(term, module) rows so cross-module collisions stay distinct. But intra-module collisions (e.g. the same module defines a term in 4+ sections) today get summarized as "+N more" with first-definer navigation — the user can't pick *which* definer. With the definitions-foundation cutover (PR #28) the palette aggregation still works off the term-keyed surface; the deeper question (one row per Definition, or one row per term with a disclosure) is a UX call that needs Derek-feedback signal before locking. Owner: unowned; queue alongside a future palette-polish PR once usage signal is in.
- **Cross-restart `q` persistence.** v1 persists `q` across ⌘P toggles within a session via the `useCommandPalette` hook. Cross-restart persistence (last query, recents) belongs in `feat/sqlite-state` (#14) — the branch that owns all persistence concerns. Same place per-tab history would have landed if it weren't retired.

---

## Operational: Derek dogfood session

Two TODO items collapse into one operational action: a Derek dogfood session to validate UI defaults that are guesses today. Not branch-shaped; the resulting changes are 1-5 line edits in whichever branch is in flight when the session happens.

- **Typeahead normalization rules** (`feat/file-tree` /plan-eng-review D8). Concrete questions: should typing `1` jump to `§ 1.01` or `Title 1` or `Chapter 1.04`? Should `§` be stripped before matching? Case-folding edge cases (`ARTICLE 1` vs `Article 1`)? Numeric vs alpha behavior? Today's default is case-insensitive prefix match on displayed label, no special handling for `§` or numeric prefixes. The Layer 3 predicate primitive in `src/corpus-nav/filter-predicate.ts` makes any rule change a one-file edit.
- **Default file-tree expansion depth.** Today `defaultExpansion(tree, maxDepth=1)` spills every section open on cold start — at SF Municipal scale that's ~12,000 visible rows. Virtualization makes it perform fine, but the UX of "everything spilled open" may not be what users want. VS Code's mental model is "top-level visible, click to expand." Either maxDepth=0 (only modules visible) or current maxDepth=1 are defensible; Derek's behavior with both decides it.
- **Operational action:** Schedule a 30-min session with Derek after ~2 weeks of wedge dogfood. Bring both questions. Land changes in whichever branch is open at the time (typically a `feat/section-view-polish` or `feat/file-tree-polish` follow-up); the per-user version of either decision later moves into `feat/sqlite-state` (#14) preferences.
- **Owner:** Operational — not a branch. Track session date once scheduled.

---

## Definitions foundation (feat/definitions-foundation 2026-05-22, PR #28)

End-to-end refoundation of the defined-term graph from a term-keyed dictionary to a build-time-resolved, addressable Definition[] graph. Plan: `~/.gstack/projects/legiscode/richardash-feat-definitions-foundation-plan-20260522.html`. The 4-PR sequencing (L1, L2a, L2b, L3) is folded into one branch per the user's "no half-states" directive — the feature ships as a complete unit or not at all.

**What shipped:**

- **L1 schema** — `ScopeExpr` (hierarchy / module / cross_module discriminated union), canonical `Definition` record with stable `<module>/<section>#<sha8(term)>` id, `body_anchor` char offsets, `extracted_by` provenance. `KNOWN_SCHEMA_VERSION` bumped 1 → 2.
- **L2a builder** — parser pass writes Definition[] per module, attaches `def_id` + `raw` to every `defined_term` body segment via per-occurrence resolver (precedence: hierarchy > module; longest matching prefix wins; section_id tiebreak). Self-suppression at body_anchor. Per-module `unresolved_references.json` audit artifact.
- **L2b cutover** — loader reads `definitions-v2.json` (ModuleDefinitionsSchema-validated, whole-file hard-fail); renderer keys popover lookup off `def_id`; legacy `term` field on body segments removed; bodyToText emits `raw`. `--corpus-path` schema-version gate against `MIN_SUPPORTED_SCHEMA_VERSION` so stale bundles fail with a clear "rebuild your corpus" message routed through `boot-overlay.tsx`.
- **L3 patterns** — every SF module's `defined_term_patterns` now includes shall-mean, is-defined-as, are-defined-as, and curly-quoted-means variants alongside the original quoted-means.

**L3 follow-ups (operator curation, not blocking the foundation PR):**

- **Populate `global_definer_sections` per module.** L1 added the manifest slot; L2a wires `{kind:"module"}` scope and `extracted_by:"manifest:declared-global"` when a section id is listed. The user-visible OOS-drop in sf-administrative (87% → low single digits per the plan §7 L3) requires the operator to identify which sections actually define module-wide terms ("City", "Director", "Department"). Workflow: build the corpus, run `pnpm exec tsx scripts/definitions-coverage.ts`, look at `unresolved_references.json` for high-OOS modules, identify the canonical definers, declare them in `manifests/sf/jurisdiction.json`, rebuild, re-measure. Owner: micro-PR direct to main once the operator session happens.
- **List-style + bare-term-capitalized-leading-noun patterns.** Plan §7 L3 lists these among the patterns to add, but each has subtleties the current per-section regex extractor doesn't handle well — list-style needs structural-context awareness (paragraph-leading `(a) "X" means...`), bare-term-capitalized-leading-noun has high false-positive risk without scope filtering. Defer until the coverage report tells us they're load-bearing. Owner: post-merge follow-up.
- **Coverage-script promotion to operator gate** (was T5 in the plan). Promote `scripts/definitions-coverage.ts` to a `mise run validate:full` threshold gate that asserts the OOS-drop target post-L3. Per CI gate split decision (plan §5): operator-driven, not in PR CI. Owner: micro-PR after manifest globals are curated.
- **v2 missed-phrasing finder** (was T6 in the plan, explicit P3 follow-up). Filter prepositional false positives from the "candidates we should have caught" suggestions. Owner: deferred to the post-L3 follow-up plan.

---

## Ordinance body parsing follow-ups (feat/ordinance-text-parsing 2026-06-01)

- **Restore `lead_in` on subsection blocks when Layer 3 typography lands.** SF ordinance subsection markers like `(a)` are followed by a short bold-italic phrase ("Materials and Cleaning Thereof.") and then body prose. Layer 2's body parser doesn't extract the lead-in as a separate field — without per-span font-style information from the typography pass, the heuristics produce false positives (any subsection whose first sentence isn't a bold-italic label gets mislabeled). The schema in Layer 2 is `{ kind: "subsection"; marker: string; body: OrdinanceBlock[] }`. When Layer 3 (`docs/spike-pdf-typography-correlation.md`) ships and `italic.ts` is available, change the subsection variant to `{ kind, marker, lead_in: string | null, body }` and populate `lead_in` from the italic-decorated leading span when present. The renderer can then style lead-ins as bold per the source-PDF convention, and a future search index / citation extractor can use the lead-in as the subsection's plain-English label. Owner: the Layer 3 inline-diff PR that owns `spike-pdf-typography-correlation.md`.
  - **REAFFIRMED 2026-06-02 by feat/diff (#12):** the inline-diff PR did NOT pick up `lead_in` extraction. Per codex C9 lock the italic info doesn't survive `stripChrome`/reflow — adding `italic.ts` for classify-spans does NOT give the body parser the same signal. `lead_in` waits on a body-parser refactor that runs against `extractTextRuns` + `extractFontMetadata` directly. Still owned by a separate follow-up PR.

---

## Inline diff follow-ups (feat/diff 2026-06-02)

- **Per-section attribution in `anchorTextDiff`. RESOLVED in feat/diff-completeness (2026-06-04).** Per-section partition via `runOffsetMap` shipped alongside the section_outcomes schema. emit-diff.ts now produces one outcome per touched section.
- **Async section baseline lookup for the diff view. RESOLVED in feat/diff-completeness (2026-06-04).** DiffView component (`src/ui/diff-view/DiffView.tsx`) carries a `BaselineLoader` contract + epoch-keyed cache + cancellation guard mirroring `App.tsx:156/179`. Section-view still uses the synchronous `baselineOverride` path for the in-place overlay; cross-section diff tabs (a v1.1+ surface) will use the async loader directly.
- **Per-span ground truth fixtures. PARTIALLY RESOLVED in feat/diff-completeness (2026-06-04).** Four annotated baselines (260217, 260544, 260545, 260296) upgraded from min-floor to exact-count regression. The 5th labelled fixture + hand-validated per-span ground truth on real bill PDFs still requires operator dogfood; queue after first end-to-end render.
- **Render-time perf instrumentation.** P5 deferred — extend the Playwright perf gate (owned by `feat/release-pipeline`) to cover the diff tab with a 100ms per-render budget once that pipeline lands.

## Inline diff follow-ups (feat/diff-completeness 2026-06-04)

- **Operators must re-run `pnpm bills:sync` after pulling feat/diff-completeness.** Bill JSON on disk pre-PR carries `affected_sections` and no `section_outcomes`; the new strict() schema rejects those files. The corpus loader will throw `CorpusError("corrupt")` until sync regenerates the per-module bill files. Adding a `bill_schema_version` field + migration path is a v1.1 hardening; today the operational workflow is "pull + re-sync."
- **Diff-tab UX as a separate surface.** Cross-section diff opens (e.g., from amends chips → see the diff for §X) still aren't wired. The DiffView component is ready; the consumer (a new tab kind that takes `(bill_file_no, module_id, section_id)`) is the next step.
- **Wholesale-add against existing section is currently `alignment_failed`.** When a bill body says "add Section X" but X already exists in the corpus, emit-diff bails to manual_review. Honest behavior given the data conflict, but a future refinement could distinguish "operator should fix the corpus" from "bill is rewriting an existing section wholesale" — both surface today as the same banner.
- **Span-overlap-at-section-header attribution is single-owner.** Spans that straddle a SEC. header attribute to the partition that owns the span's START. The other partition gets no spans from that source-run. Acceptable for v1; revisit if real bills produce 5+ word straddling spans that need to render in both sections.
- **Sample-validated tightening of classify-spans is partial.** T3 locked the zero-width-run → context fix. Board-amendment Arial runs with decoration are still silently classified as `context` (documented limitation per `feat/board-amendments` scope). Real board-amendment bills will need that branch lifted.

---

## Per-section lazy loading

The corpus loader (`electron/corpus-loader.ts`) reads every section into memory at boot — a few hundred ms cost in exchange for zero-latency `corpus:read` calls. When SF Municipal alone is the installed corpus this is fine. Once `feat/module-manager` ships and a user can install multiple jurisdictions, the load may grow past comfortable RAM and per-section disk reads on demand become the right shape. Trigger: a profiling pass on a multi-jurisdiction corpus shows boot RSS or boot time crossing the comfort line.

---

## Bill UI copy polish (deferred from feat/session-bills 2026-06-03)

- **Tighten bill-context copy for enacted bills across rail / overlay / status-bar.** Codex review surfaced three copy nits the session-bills PR ships with: (1) section-pending rail header still says "pending ordinances" — should read "ordinances affecting this section" once enacted bills surface there; (2) overlay button "View this section as if X had passed" reads as nonsense for enacted bills (the bill already passed) — should switch tense by status ("View this section as enacted by X" for signed bills, "View this section as if X passed" for pending); (3) status-bar badge still reads "X pending" — this one is correct per design D7 (status bar deliberately answers "what's in flight," not "session count"), but worth confirming once the panel ships and we see it in context. **Pros:** more accurate UI copy aligned with new enacted-bill surfaces. **Cons:** trivial, easy to defer, doesn't block ship; needs conditional rendering or status-aware copy strings. **Context:** SF Board's BoS site uses "Adopted" for signed ordinances in headers; consider matching their vocabulary. **Depends on / blocked by:** feat/session-bills landing (touch sites won't exist until then). Owner: unowned; queue after first user feedback or as part of a general copy-polish PR.

---

## Class B (non-code) ordinance store (deferred from feat/session-bills 2026-06-03)

- **Build jurisdiction-level Class B bill store IF user demand surfaces for non-code ordinances.** v1.0 ships Class B (resolutions-shaped, appropriations, waivers) as simple Activity-panel rows backed by jurisdiction-level BillsIndex — they have no per-module Bill file, no parsed body, no section-rail anchor (no affected_sections). Click-through on a Class B row opens a bill-detail tab that shows the BillMeta info + a "this ordinance doesn't amend code; see Legistar for full text" note. **What to build IF needed:** parser path for non-code ordinance PDFs (different structure than Class A amendments), per-jurisdiction Bill store at `build/modules/_jurisdiction/bills/`, richer click-through tab. **Pros of building it:** users can read full Class B content in-app. **Cons:** ~half a feature's worth of work; unclear that users care about "authorize $1.4M for Mission Bay drainage" inline vs clicking through to Legistar. **Context:** codex caught (during /plan-eng-review on 2026-06-03) that the original session-scoped design didn't address Class B at all; user explicitly chose to include them as minimal Activity rows rather than build the full store. Trigger to revisit: user complains about clicking Class B → Legistar instead of reading inline. **Depends on / blocked by:** real session-bills usage data. Owner: unowned.

---

## Section-pending rail: AmLegal-lag absorption detection (deferred from feat/session-bills 2026-06-03)

- **Decide between option F (current) and option C (text-equality absorption detection) once we have real user signal on the lag-window UX.** `feat/session-bills` ships the rail with predicate `bill_status ∈ PENDING_STATES ∪ {enacted}` — pending bills stay on rail, signed bills stay on rail forever (until terminal), terminal bills drop. The deferred option C builds an `absorbed_at` field set by a text-equality pass that checks AmLegal HTML for each affected section's `text_diff[].after`, plus a 180d audit-log for enacted-but-unabsorbed bills. **Pros of building it:** rail correctly drops bills once AmLegal publishes the change, no clutter accumulation. **Cons:** ~30% of the original PR's scope, new module (`src/corpus/absorption.ts`), text-equality false-negatives on AmLegal editorial transforms (renumbering, capitalization, cross-reference parentheticals), audit-log operational surface. **Context:** the design captured this gap as the "AmLegal lag is real" invariant (`richardash-feat-session-bills-design-20260603-120000.md` § 1); /plan-eng-review surfaced that the absorption-detection machinery was load-bearing only for one consumer (the section pending rail), and the activity panel already shows signed bills permanently — so the rail-drop nicety could be deferred. Trigger to revisit: (a) users complain about signed-bill clutter on high-traffic sections (Police Code §96, Planning Code 309, etc.) once SF mid-session signed-bill count grows to ~10+ per section, OR (b) users complain about reading stale section text without realizing a signed amendment exists. Either complaint surfaces the right side of the trade-off. **Depends on / blocked by:** real session-bills usage data (post-merge). Owner: unowned; queue review after `feat/session-bills` has been live for ~3 months or after first user complaint.

---

## Agent polish follow-ups (feat/agent-polish 2026-06-10)

Surfaced during /plan-eng-review on the feat/agent-polish design. Each is conditional on something the branch's commit-2 measurement step or commit-6 retest will reveal.

- **Reduced thinking budget exploration.** The Anthropic provider enables extended thinking on every request (`electron/ai/providers/anthropic.ts:27`, 4000-token reasoning budget). Codex (D9 measurement step) may show model thinking dominates T03 latency rather than RTT count. **What:** explore reducing the thinking budget for tool-heavy turns, OR routing tool-loop turns through a smaller / non-thinking model. **Why:** if parallel dispatch alone doesn't move T03 ≤60s, thinking is the next lever. **Pros:** addresses the right bottleneck if measurement says so. **Cons:** quality risk on reasoning-heavy bill questions; needs golden Q&A regression coverage. **Context:** D9 instrumentation results dictate whether this is needed. **Depends on / blocked by:** feat/agent-polish commit-2 measurement results. Owner: unowned; queue if commit-2 telemetry shows thinking > 50% of T03 wall-clock.
- **Batch `/bills/{n}/changes-full` path.** D6 picked parallel tool dispatch over the design's F3-A batch path. **What:** if parallel dispatch alone doesn't clear the 60s target for multi-section bills, add `/bills/{n}/changes-full` as a one-shot bill changes payload. **Why:** complementary fix — parallel speeds up rounds, batch reduces round count. **Pros:** halves round-trip count for the bill-question wedge. **Cons:** more path-tree surface; extra prompt-rule wording; some redundancy with parallel-dispatched per-section reads. **Context:** the original design §3.3 candidate A. **Depends on / blocked by:** retest outcome on T03. Owner: unowned; queue if T03 retest after D6 doesn't clear 60s.
- **Parallel-dispatch streaming UI flicker mitigation.** Codex flagged that parallel tool dispatch may cause transient text deltas to appear and then be overwritten by tool-result-driven re-rendering. **What:** observe in dogfood; if visible, gate text-delta render on tool-loop completion (or clear interim text on tool dispatch). **Why:** chat-UI quality; transient text reads as a stutter. **Pros:** sharper chat experience under multi-tool turns. **Cons:** changes when interim text appears; trade-off with perceived responsiveness. **Context:** codex outside-voice review on feat/agent-polish, 2026-06-10. **Depends on / blocked by:** real usage observation post-merge. Owner: unowned; queue on first reported flicker.
