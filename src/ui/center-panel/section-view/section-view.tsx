// Section view — the centre-panel reader for a single corpus section.
// Iterates `section.body[]` (the BodySegment discriminated union)
// into React, rendering citations, defined-terms, subsection labels,
// and inline formatting without re-parsing text. Three top-level
// states:
//
//   error  →  in-section error banner replaces the body. App.tsx
//             clears `view` to null on `corpus.read` ok:false so
//             stale chrome (breadcrumb, parents kicker) doesn't leak.
//   null   →  "No section selected" placeholder. Only visible if the
//             workbench has no active section item; corpus:read latency
//             on the in-memory loader is negligible so a transient
//             loading state isn't user-visible.
//   view   →  full render: parents kicker, § id + title, editorial chip
//             (when status !== "active"), redesignated redirect link
//             (when redirect_to is set), then body iteration.
//
// Body iteration: split body[] at top-level `paragraph_break` segments
// and render each chunk inside `<p class="lc-para">`. Within a paragraph,
// recurse into `format` children for bold/italic/list/listItem wrappers.
// The roundtrip-invariant `bodyToText(body) === text` guarantees the
// rendered text matches what search/export sees (enforced by
// SectionFileSchema.superRefine at src/types/section.ts:286).
//
// Hover popover state: SectionView owns ONE useHoverPopover instance
// whose payload is a discriminated union over the two surfaces that
// share it (citation + defined-term). DefinedTerm consumes the handle
// via SectionHoverContext rather than owning its own state machine,
// so "one popover at a time" is enforced structurally — there's no
// way for a cite-popover and a defined-term-popover to be visible
// simultaneously. Both popovers render at the lc-doc-inner level
// (outside the <p>-containing body), avoiding the
// `<div>`-inside-`<p>` DOM-validity issue that an inline render would
// hit.

import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import type { ResolutionResult } from "@/citations/resolver";
import type { CorpusRef } from "@/corpus/refs";
import { parse as parseCorpusRef } from "@/corpus/refs";
import type { CorpusError, CorpusSectionView } from "@/corpus/wire";
import {
  type Bill,
  type BodySegment,
  type Citation,
  type RenderBodySegment,
  type SectionId,
  splitParagraphs,
  walkBody,
} from "@/types";
import { billHasDiffForSection } from "@/ui/diff/bill-section-diff";
import { overlayStructured } from "@/ui/diff/overlay";
import type { OpenItem } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";
import { CitationLink } from "./citation-link";
import { CitationPopover } from "./citation-popover";
import { Crumb } from "./crumb";
import { DefinedTerm, DefinedTermPopover } from "./defined-term";
import { type HoverPayload, SectionHoverContext } from "./hover-context";
import { SectionPendingRail } from "./section-pending-rail";
import "./section-view.css";
import { useHoverPopover } from "./use-hover-popover";

export interface SectionViewProps {
  view: CorpusSectionView | null;
  /** Pretty parents string for the kicker — e.g. "Port Code · ARTICLE 1". */
  parentsLabel: string;
  /** Set when corpus.read returns ok:false; replaces the body with a banner. */
  error: CorpusError | null;
  /** Tab-dispatch primitive. Used by defined-term tooltip jump-links and
   *  the redesignated redirect link — both `navigate(item, "primary")`. */
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
  /** Fired by delegated click on any `[data-cite-kind]` span in the body
   *  ONLY when a modifier (⌘ / Ctrl) is held — VS Code semantics: plain
   *  click selects text, ⌘-click opens in a new foreground tab. Parent
   *  dispatches resolve() → navigate(). */
  onCitationActivate?: (citation: Citation, intent: NavigationIntent) => void;
  /** Resolves a citation against the current corpus state. Used by the
   *  hover popover to render kind-discriminated bodies. Returns null when
   *  the parent isn't ready to resolve yet (no corpus, no section). */
  resolveCitation?: (citation: Citation) => ResolutionResult | null;
  /** Synchronous (title, excerpt) lookup keyed by the resolved target's
   *  ref and an optional subsection label. Pre-baked at corpus-load time
   *  so the popover renders without IPC or loading flicker. When
   *  `subsection` is provided and a pre-baked entry matches, the excerpt
   *  is the subsection text; otherwise it's the section-level preview.
   *  Returns null when the ref isn't in the loaded corpus — the popover
   *  falls back to ref-only rendering. */
  getCitationPreview?: (
    ref: CorpusRef,
    subsection?: string,
  ) => { title: string; excerpt?: string } | null;
  /** Callback ref attached to the scroll container so the parent can
   *  drive per-tab scroll restoration via the use-tabs hook. Only wired
   *  on the loaded-view branch — error/placeholder branches don't have
   *  meaningful per-section scroll state. */
  scrollContainerRef?: (el: HTMLElement | null) => void;
  /** Called on every scroll event with the container's scrollTop. */
  onScrollY?: (y: number) => void;
  /** When this view is the active tab's panel, the tab host passes its
   *  ARIA wiring so role=tabpanel lives on the actual scroll container
   *  (.lc-doc). Folding the role onto .lc-doc avoids a wrapper element
   *  that would otherwise break the `.lc-center` flex chain that pins
   *  the TabStrip and Breadcrumb above the scroll viewport. */
  tabPanel?: { id: string; labelledBy: string };
  /** Pending Bill rows whose `section_outcomes` include this section.
   *  Drives the peach-left-border pending-rail above the body. Empty
   *  array (or undefined) suppresses the rail entirely (Pass 2 lock). */
  pendingRailBills?: ReadonlyArray<Bill>;
  /** Dispatches the bill open when the bill identifier in a pending-
   *  rail row is activated (Cmd-click / Enter). */
  onOpenBill?: (fileNo: string, mode: "primary" | "background") => void;
}

interface RenderCtx {
  citations: ReadonlyArray<Citation>;
  definitions: CorpusSectionView["definitions"];
  onJump: (sectionId: SectionId) => void;
  /** Mutable set of subsection labels still owed an id emission.
   *  Pre-seeded with one entry per distinct label and drained on the
   *  first encounter in render order, so duplicate labels render
   *  plain. Mutating during render is safe because the set is rebuilt
   *  per render — never observed across renders. */
  pendingSubsectionIds: Set<string>;
}

export function SectionView({
  view,
  parentsLabel,
  error,
  navigate,
  onCitationActivate,
  resolveCitation,
  getCitationPreview,
  scrollContainerRef,
  onScrollY,
  tabPanel,
  pendingRailBills,
  onOpenBill,
}: SectionViewProps) {
  const tabPanelAttrs = tabPanel
    ? { role: "tabpanel" as const, id: tabPanel.id, "aria-labelledby": tabPanel.labelledBy }
    : null;
  // Per-section local state — the active overlay carries both the
  // bill driving it and the mode the reader picked from the rail's
  // three-mode segmented control:
  //
  //   null              → "Original" (the resting state — render
  //                       section.body unchanged).
  //   { billId, mode: "changes" }  → walk the structured-diff overlay
  //                                  for that bill (strikethrough
  //                                  deletions + highlighted inserts).
  //   { billId, mode: "proposed" } → render the bill's new_body
  //                                  directly (post-amendment text,
  //                                  no marks).
  //
  // Resets to null whenever the section identity changes so a stale
  // overlay can't leak across tab navigation.
  type ActiveOverlay = { billId: string; mode: "changes" | "proposed" };
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay | null>(null);
  const sectionKey = view !== null ? `${view.moduleId}::${view.section.id}` : null;
  const lastSectionKeyRef = useRef<string | null>(null);
  if (lastSectionKeyRef.current !== sectionKey) {
    lastSectionKeyRef.current = sectionKey;
    if (activeOverlay !== null) setActiveOverlay(null);
  }
  // Single hover-popover hook for the whole section. Citation handlers
  // and DefinedTerm (via SectionHoverContext) dispatch into the same
  // instance — guarantees "one popover at a time" without needing to
  // coordinate independent timer machines across components.
  const hover = useHoverPopover<HoverPayload>();

  /**
   * Resolve a delegated event back to the citation + anchor element it
   * targets. Returns null when the event didn't land on a cite span or
   * the citation index is missing — caller exits early in that case.
   */
  const resolveCitationFromEvent = useCallback(
    (target: EventTarget | null): { citation: Citation; anchor: HTMLElement } | null => {
      if (!view) return null;
      const node = target as HTMLElement | null;
      const anchor = node?.closest("[data-cite-kind]") as HTMLElement | null;
      if (!anchor) return null;
      const raw = anchor.dataset.citationIndex;
      if (raw === undefined) return null;
      const idx = Number(raw);
      const citation = view.section.citations[idx];
      if (!citation) return null;
      return { citation, anchor };
    },
    [view],
  );

  // VS Code citation semantics: plain click is text selection only,
  // ⌘/Ctrl-click opens the cite in a new foreground tab. The
  // event-delegated handler exits early when no modifier is held so the
  // browser's default text-selection behavior runs unimpeded. Dismissing
  // the hover popover on dispatch is non-obvious but load-bearing: the
  // cursor doesn't leave the cite span on navigation, so mouseout never
  // fires and the popover would otherwise stick around over the new
  // tab's content.
  const onBodyClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!onCitationActivate) return;
      const hit = resolveCitationFromEvent(e.target);
      if (!hit) return;
      e.preventDefault();
      hover.closeNow();
      onCitationActivate(hit.citation, "primary");
    },
    [onCitationActivate, hover, resolveCitationFromEvent],
  );

  // Keyboard activation: Enter / Mod+Enter on a focused cite span
  // dispatches primary intent (matches ⌘-click). Space is intentionally
  // a no-op — citation spans are spans, not buttons, and Space is text-
  // selection / scroll territory in a paragraph context. The keydown
  // delegate fills in a hole the citation refoundation left open: the
  // cite span carried `tabIndex={0}` + `role="link"` from the start,
  // but no key handler ever existed, so Enter on a focused cite was a
  // silent no-op.
  const onBodyKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Enter") return;
      if (!onCitationActivate) return;
      const hit = resolveCitationFromEvent(e.target);
      if (!hit) return;
      e.preventDefault();
      hover.closeNow();
      onCitationActivate(hit.citation, "primary");
    },
    [onCitationActivate, hover, resolveCitationFromEvent],
  );

  // Fired by the popover footer's "Go to definition →" button. Same
  // dispatch as ⌘-click on the cite — clear hover state first so the
  // popover doesn't linger over the freshly-opened tab.
  const onPopoverActivate = useCallback(() => {
    if (!onCitationActivate || !hover.state || hover.state.kind !== "citation") return;
    const citation = hover.state.citation;
    hover.closeNow();
    onCitationActivate(citation, "primary");
  }, [onCitationActivate, hover]);

  const onBodyMouseOver = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!resolveCitation) return;
      const hit = resolveCitationFromEvent(e.target);
      if (!hit) return;
      const resolution = resolveCitation(hit.citation);
      if (!resolution || resolution.kind === "unresolvable") return;
      // showOrSnap: first hover waits the 400ms intent-to-open delay;
      // subsequent hovers (cite-to-cite, cite-to-defined-term) swap
      // content immediately because intent is already established.
      hover.showOrSnap({
        kind: "citation",
        citation: hit.citation,
        resolution,
        anchorElement: hit.anchor,
      });
    },
    [resolveCitation, hover, resolveCitationFromEvent],
  );

  const onBodyMouseOut = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement | null)?.closest(
        "[data-cite-kind]",
      ) as HTMLElement | null;
      if (!anchor) return;
      // mouseout fires when moving to a child; ignore intra-cite moves.
      const related = e.relatedTarget as HTMLElement | null;
      if (related && anchor.contains(related)) return;
      hover.scheduleClose();
    },
    [hover],
  );

  // Focus / blur mirror mouseover / mouseout so keyboard users see the
  // same hover preview that mouse users get via Tab.
  const onBodyFocus = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (!resolveCitation) return;
      const hit = resolveCitationFromEvent(e.target);
      if (!hit) return;
      const resolution = resolveCitation(hit.citation);
      if (!resolution || resolution.kind === "unresolvable") return;
      hover.openNow({
        kind: "citation",
        citation: hit.citation,
        resolution,
        anchorElement: hit.anchor,
      });
    },
    [resolveCitation, hover, resolveCitationFromEvent],
  );
  const onBodyBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement | null)?.closest("[data-cite-kind]");
      if (!anchor) return;
      hover.scheduleClose();
    },
    [hover],
  );

  if (error) {
    return (
      <div {...tabPanelAttrs} className="lc-doc lc-scroll" data-testid="section-view">
        <div className="lc-doc-inner">
          <div className="lc-section-error" role="alert">
            <div className="lc-section-error-title">Couldn't load this section</div>
            <div className="lc-section-error-detail">{error.detail}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div {...tabPanelAttrs} className="lc-doc lc-scroll">
        <div className="lc-doc-inner">
          <div className="lc-doc-title">No section selected</div>
        </div>
      </div>
    );
  }

  const { section, moduleId } = view;
  const onJump = (sectionId: SectionId) =>
    navigate(
      { kind: "section", ref: parseCorpusRef({ module: moduleId, section: sectionId }) },
      "primary",
    );
  const ctx: RenderCtx = {
    citations: section.citations,
    definitions: view.definitions,
    onJump,
    pendingSubsectionIds: new Set(collectDistinctLabels(section.body)),
  };

  const paragraphs = splitParagraphs(section.body);

  // Overlay mode: when a pending bill is selected as the active
  // overlay for this section, the body re-renders as either an
  // inline diff (Changes mode) or the post-amendment text (Proposed
  // mode). The two modes use different data sources:
  //
  //   • Changes  → walk baseline section.body and project the bill's
  //                diff_chunks onto it via overlayStructured(). Inline
  //                strike-through and insert highlights require chunk-
  //                anchored positions, so projection is unavoidable.
  //   • Proposed → walk the bill's parsed new_body directly. The
  //                parser already produced the post-amendment
  //                BodySegment[] at build time; the renderer just
  //                iterates it. No chunk projection, no inference
  //                about which atomic segments survived.
  //
  // Splitting modes this way eliminates a class of render-time bugs
  // where atomic-segment wrappers (citations, defined-terms) whose
  // baseline chars were deleted resurrected in Proposed because the
  // walker couldn't distinguish "deleted" from "equal" in the
  // emitted-segment stream. See PR #47 for the regression history.
  const overlayBill = activeOverlay
    ? (pendingRailBills?.find((b) => b.file_no === activeOverlay.billId) ?? null)
    : null;
  const overlayMode = activeOverlay?.mode ?? null;
  const overlayChunksForSection = overlayBill
    ? overlayBill.diff_chunks.filter((c) => c.section_id === section.id)
    : [];
  // The bill-level parse_status is too coarse: a `partial` bill can
  // have this section anchored cleanly while a sibling section is the
  // one that fell through. Check the per-section outcome instead so
  // the overlay banner reflects what's actually true for the section
  // in view.
  const overlayUnavailable =
    overlayBill !== null && !billHasDiffForSection(overlayBill, section.id);
  const overlayNewBody =
    overlayBill !== null
      ? (overlayBill.new_bodies.find((n) => n.section_id === section.id)?.body ?? null)
      : null;
  const overlayParagraphs: RenderBodySegment[][] =
    overlayBill !== null && overlayMode !== null && !overlayUnavailable
      ? overlayMode === "proposed"
        ? overlayNewBody !== null
          ? splitParagraphs(overlayNewBody)
          : []
        : splitParagraphs(overlayStructured(overlayChunksForSection, section.body, "changes"))
      : [];

  return (
    <SectionHoverContext.Provider value={hover}>
      <div
        {...tabPanelAttrs}
        ref={scrollContainerRef}
        onScroll={onScrollY ? (e) => onScrollY(e.currentTarget.scrollTop) : undefined}
        className="lc-doc lc-scroll"
        data-testid="section-view"
      >
        <div className="lc-doc-inner">
          <div className="lc-doc-title lc-section-kicker">
            {view.parents.length > 0
              ? view.parents.map((p, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: ordered breadcrumb path; index is a stable position
                  <span key={`${p.code}-${i}`}>
                    {i > 0 && <span className="lc-crumb-sep"> · </span>}
                    <Crumb crumb={p} moduleId={moduleId} navigate={navigate} />
                  </span>
                ))
              : parentsLabel}
          </div>
          <h1 className="lc-section" style={{ marginBottom: 4 }}>
            <span className="lc-section-id">§ {section.display_label}</span>
            <span style={{ marginLeft: 12 }}>{section.title}</span>
          </h1>
          {section.editorial_status !== "active" ? (
            <div className="lc-section-meta">
              <span className="lc-status-chip" data-status={section.editorial_status}>
                {section.editorial_status}
              </span>
              {section.editorial_status === "redesignated" && section.redirect_to ? (
                <button
                  type="button"
                  className="lc-redirect-link"
                  onClick={() =>
                    navigate(
                      {
                        kind: "section",
                        ref: parseCorpusRef({ module: moduleId, section: section.redirect_to! }),
                      },
                      "primary",
                    )
                  }
                >
                  See § {section.redirect_to}
                </button>
              ) : null}
            </div>
          ) : null}
          {pendingRailBills && pendingRailBills.length > 0 && onOpenBill ? (
            <SectionPendingRail
              bills={pendingRailBills}
              sectionId={section.id}
              onOpenBill={onOpenBill}
              activeOverlay={activeOverlay}
              onChangeOverlay={setActiveOverlay}
              overlayUnavailable={overlayUnavailable}
            />
          ) : null}
          {overlayBill !== null && overlayMode !== null && !overlayUnavailable ? (
            <div
              className="lc-section-body lc-section-body--overlay"
              data-overlay-mode={overlayMode}
              data-testid="section-body-overlay"
            >
              {overlayParagraphs.length > 0 ? (
                overlayParagraphs.map((segs, pi) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional within a stable overlay render
                  <p key={pi} className="lc-para">
                    {renderInline(segs, ctx, `op${pi}`)}
                  </p>
                ))
              ) : (
                // Overlay computed against an empty resulting body — the
                // bill repeals the entire section. Show a one-line
                // explainer in place of a blank reader.
                <p className="lc-para lc-overlay-empty">This section would be removed entirely.</p>
              )}
            </div>
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: the div is a pure event-delegation seam — roles live on the inner cite span (tabIndex={0} + role="link"), not the wrapping div.
            <div
              className="lc-section-body"
              onClick={onBodyClick}
              onKeyDown={onBodyKeyDown}
              onMouseOver={onBodyMouseOver}
              onMouseOut={onBodyMouseOut}
              onFocus={onBodyFocus}
              onBlur={onBodyBlur}
            >
              {paragraphs.map((segs, pi) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional within a stable section render
                <p key={pi} className="lc-para">
                  {renderInline(segs, ctx, `p${pi}`)}
                </p>
              ))}
            </div>
          )}
          {hover.state?.kind === "citation" ? (
            <CitationPopover
              resolution={hover.state.resolution}
              rawCite={hover.state.citation.display_text}
              anchorElement={hover.state.anchorElement}
              {...resolvePreview(hover.state.resolution, getCitationPreview)}
              onActivate={onCitationActivate ? onPopoverActivate : undefined}
              onPopoverEnter={hover.cancelClose}
              onPopoverLeave={hover.scheduleClose}
            />
          ) : null}
          {hover.state?.kind === "definedTerm" ? (
            <DefinedTermPopover
              definition={hover.state.definition}
              anchorElement={hover.state.anchorElement}
              onActivate={hover.state.onActivate}
              onPopoverEnter={hover.cancelClose}
              onPopoverLeave={hover.scheduleClose}
            />
          ) : null}
        </div>
      </div>
    </SectionHoverContext.Provider>
  );
}

/**
 * Pull (title, excerpt) for the popover from the resolution target. Only
 * navigate-section / navigate-structural carry a ref the lookup can hit;
 * other kinds (module-not-installed, scroll-only, navigate-appendix)
 * render from the resolution discriminator alone, so this returns an
 * empty object that spread cleanly over the popover props.
 */
function resolvePreview(
  resolution: ResolutionResult,
  getCitationPreview:
    | ((ref: CorpusRef, subsection?: string) => { title: string; excerpt?: string } | null)
    | undefined,
): { resolvedTitle?: string; bodyExcerpt?: string } {
  if (!getCitationPreview) return {};
  if (resolution.kind !== "navigate-section" && resolution.kind !== "navigate-structural") {
    return {};
  }
  const subsection = resolution.kind === "navigate-section" ? resolution.subsection : undefined;
  const preview = getCitationPreview(resolution.ref, subsection);
  if (!preview) return {};
  return {
    resolvedTitle: preview.title,
    ...(preview.excerpt ? { bodyExcerpt: preview.excerpt } : {}),
  };
}

/**
 * Distinct subsection labels appearing in body iteration order —
 * flat or nested in format children. Used as the seed for the "still
 * owed an id" set drained during render to enforce
 * first-occurrence-wins.
 */
function collectDistinctLabels(body: readonly BodySegment[]): ReadonlySet<string> {
  const result = new Set<string>();
  walkBody(body, (seg) => {
    if (seg.kind === "subsection_label") result.add(seg.label);
  });
  return result;
}

function renderInline(
  segs: readonly RenderBodySegment[],
  ctx: RenderCtx,
  keyPrefix: string,
): ReactNode[] {
  return segs.map((seg, i) => renderSegment(seg, ctx, `${keyPrefix}-${i}`));
}

function renderSegment(seg: RenderBodySegment, ctx: RenderCtx, key: string): ReactNode {
  switch (seg.kind) {
    case "text":
      return <span key={key}>{seg.text}</span>;
    case "citation": {
      const citation = ctx.citations[seg.citation_index];
      if (!citation) return <span key={key}>{seg.raw}</span>;
      return (
        <CitationLink
          key={key}
          raw={seg.raw}
          citation={citation}
          citation_index={seg.citation_index}
        />
      );
    }
    case "defined_term": {
      // Lookup keyed by def_id (build-time-resolved per occurrence).
      // The loader owns prototype-key safety (Object.create(null) on
      // the producer side; DEFINITION_ID_RE rejects every
      // Object.prototype name by construction), so a missing def_id
      // reads as `undefined` here and falls through to DefinedTerm's
      // graceful-degrade branch.
      const definition = ctx.definitions[seg.def_id];
      return <DefinedTerm key={key} raw={seg.raw} definition={definition} onJump={ctx.onJump} />;
    }
    case "subsection_label": {
      // First-occurrence-wins anchor id. Duplicate labels render
      // plain so a navigate(subsection) jump-link lands at the
      // canonical first instance. Real legal sections rarely reuse
      // subsection labels; collision-strategy upgrade is in TODOS.md.
      const emitId = ctx.pendingSubsectionIds.delete(seg.label);
      return (
        <span
          key={key}
          id={emitId ? `lc-sub-${seg.label}` : undefined}
          className="lc-subsection-label"
        >
          {seg.label}
        </span>
      );
    }
    case "format":
      return renderFormat(seg, ctx, key);
    case "paragraph_break":
      // Nested paragraph_break inside format children — the schema
      // permits it but the parser doesn't emit it. Render as nothing
      // so a regression doesn't surface as a crash.
      return null;
    case "diff_insert":
      return (
        <span key={key} className="lc-overlay-insert">
          {seg.text}
        </span>
      );
    case "diff_delete":
      return (
        <span key={key} className="lc-overlay-delete">
          {seg.text}
        </span>
      );
  }
}

function renderFormat(
  seg: Extract<BodySegment, { kind: "format" }>,
  ctx: RenderCtx,
  key: string,
): ReactNode {
  const children = renderInline(seg.children, ctx, key);
  switch (seg.style) {
    case "bold":
      return <strong key={key}>{children}</strong>;
    case "italic":
      return <em key={key}>{children}</em>;
    case "list":
      return (
        <ul key={key} className="lc-format-list">
          {children}
        </ul>
      );
    case "listItem":
      return (
        <li key={key} className="lc-format-list-item">
          {children}
        </li>
      );
  }
}
