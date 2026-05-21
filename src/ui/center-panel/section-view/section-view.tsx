// Section view — the centre-panel reader for a single corpus section.
// Iterates `section.body[]` (the BodySegment discriminated union shipped
// in #6.5) into React, rendering citations, defined-terms, subsection
// labels, and inline formatting without re-parsing text. Three top-level
// states:
//
//   error  →  in-section error banner replaces the body (D8 + C7).
//             App.tsx clears `view` to null on `corpus.read` ok:false so
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

import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ResolutionResult } from "@/citations/resolver";
import type { CorpusRef } from "@/corpus/refs";
import { parse as parseCorpusRef } from "@/corpus/refs";
import type { CorpusError, CorpusSectionView } from "@/corpus/wire";
import type { BodySegment, Citation, SectionId } from "@/types";
import type { OpenItem } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";
import { CitationLink } from "./citation-link";
import { CitationPopover } from "./citation-popover";
import { DefinedTerm } from "./defined-term";
import "./section-view.css";

const POPOVER_SHOW_DELAY_MS = 400;
const POPOVER_HIDE_DELAY_MS = 200;

export interface SectionViewProps {
  view: CorpusSectionView | null;
  /** Pretty parents string for the kicker — e.g. "Port Code · ARTICLE 1". */
  parentsLabel: string;
  /** Set when corpus.read returns ok:false; replaces the body with a banner (D8). */
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
}

interface RenderCtx {
  citations: ReadonlyArray<Citation>;
  definitions: CorpusSectionView["definitions"];
  onJump: (sectionId: SectionId) => void;
  /** Mutable set of subsection labels still owed an id emission (D7,
   *  D14). Pre-seeded with one entry per distinct label and drained on
   *  the first encounter in render order, so duplicate labels render
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
}: SectionViewProps) {
  const [hoverState, setHoverState] = useState<{
    citation: Citation;
    resolution: ResolutionResult;
    anchorRect: DOMRect;
  } | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

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
      if (!onCitationActivate || !view) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("[data-cite-kind]") as HTMLElement | null;
      if (!anchor) return;
      const raw = anchor.dataset.citationIndex;
      if (raw === undefined) return;
      const idx = Number(raw);
      const citation = view.section.citations[idx];
      if (!citation) return;
      e.preventDefault();
      clearTimers();
      setHoverState(null);
      onCitationActivate(citation, "primary");
    },
    [onCitationActivate, view, clearTimers],
  );

  // Fired by the popover footer's "Go to definition →" button. Same
  // dispatch as ⌘-click on the cite — clear hover state first so the
  // popover doesn't linger over the freshly-opened tab.
  const onPopoverActivate = useCallback(() => {
    if (!onCitationActivate || !hoverState) return;
    clearTimers();
    const citation = hoverState.citation;
    setHoverState(null);
    onCitationActivate(citation, "primary");
  }, [onCitationActivate, hoverState, clearTimers]);

  // Hover bridge: when the cursor crosses the 6px gap from the cite span
  // into the popover, the cite's mouseout arms a hide timer; entering the
  // popover cancels it so the user can read the excerpt and click the
  // footer button. Leaving the popover re-arms the hide timer.
  const onPopoverMouseEnter = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const onPopoverMouseLeave = useCallback(() => {
    hideTimerRef.current = setTimeout(() => {
      setHoverState(null);
    }, POPOVER_HIDE_DELAY_MS);
  }, []);

  const onBodyMouseOver = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!resolveCitation || !view) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("[data-cite-kind]") as HTMLElement | null;
      if (!anchor) return;
      const idxRaw = anchor.dataset.citationIndex;
      if (idxRaw === undefined) return;
      const idx = Number(idxRaw);
      const citation = view.section.citations[idx];
      if (!citation) return;
      clearTimers();
      const anchorRect = anchor.getBoundingClientRect();
      showTimerRef.current = setTimeout(() => {
        const resolution = resolveCitation(citation);
        if (resolution && resolution.kind !== "unresolvable") {
          setHoverState({ citation, resolution, anchorRect });
        }
      }, POPOVER_SHOW_DELAY_MS);
    },
    [resolveCitation, view, clearTimers],
  );

  const onBodyMouseOut = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("[data-cite-kind]") as HTMLElement | null;
      if (!anchor) return;
      // mouseout fires when moving to a child; ignore intra-cite moves.
      const related = e.relatedTarget as HTMLElement | null;
      if (related && anchor.contains(related)) return;
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      if (hoverState) {
        hideTimerRef.current = setTimeout(() => {
          setHoverState(null);
        }, POPOVER_HIDE_DELAY_MS);
      }
    },
    [hoverState],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && hoverState) setHoverState(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hoverState]);

  // The popover anchors to a getBoundingClientRect taken at hover time;
  // scrolling makes that snapshot stale and the popover floats over
  // unrelated content. Capture-phase listener catches scroll on any
  // ancestor scroller (scroll events don't bubble in the normal phase).
  useEffect(() => {
    if (!hoverState) return;
    function onScroll() {
      clearTimers();
      setHoverState(null);
    }
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [hoverState, clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  if (error) {
    return (
      <div className="lc-doc lc-scroll" data-testid="section-view">
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
      <div className="lc-doc lc-scroll">
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

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScrollY ? (e) => onScrollY(e.currentTarget.scrollTop) : undefined}
      className="lc-doc lc-scroll"
      data-testid="section-view"
    >
      <div className="lc-doc-inner">
        <div className="lc-doc-title">{parentsLabel}</div>
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
        {/** biome-ignore lint/a11y/useKeyWithClickEvents: the div is a pure event-delegation seam; the inner citation span carries role="link" + tabIndex. */}
        {/** biome-ignore lint/a11y/noStaticElementInteractions: same rationale — roles live on the citation span, not the wrapping div. */}
        {/** biome-ignore lint/a11y/useKeyWithMouseEvents: hover preview is a progressive enhancement; keyboard users get the same dispatch behavior via Tab + ⌘+Enter on the focused span. The mouseover path is an additive affordance, not a primary control surface. */}
        <div
          className="lc-section-body"
          onClick={onBodyClick}
          onMouseOver={onBodyMouseOver}
          onMouseOut={onBodyMouseOut}
        >
          {paragraphs.map((segs, pi) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional within a stable section render
            <p key={pi} className="lc-para">
              {renderInline(segs, ctx, `p${pi}`)}
            </p>
          ))}
        </div>
        {hoverState ? (
          <CitationPopover
            resolution={hoverState.resolution}
            rawCite={hoverState.citation.display_text}
            anchorRect={hoverState.anchorRect}
            {...resolvePreview(hoverState.resolution, getCitationPreview)}
            onActivate={onCitationActivate ? onPopoverActivate : undefined}
            onMouseEnter={onPopoverMouseEnter}
            onMouseLeave={onPopoverMouseLeave}
          />
        ) : null}
      </div>
    </div>
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
 * Distinct subsection labels appearing in body iteration order — flat or
 * nested in format children. Used as the seed for the "still owed an id"
 * set drained during render to enforce first-occurrence-wins (D7, D14).
 */
function collectDistinctLabels(body: readonly BodySegment[]): ReadonlySet<string> {
  const result = new Set<string>();
  const walk = (segs: readonly BodySegment[]): void => {
    for (const seg of segs) {
      if (seg.type === "subsection_label") {
        result.add(seg.label);
      } else if (seg.type === "format") {
        walk(seg.children);
      }
    }
  };
  walk(body);
  return result;
}

/**
 * Split body[] at top-level paragraph_break segments. paragraph_break is
 * a flat marker (not a wrapping Paragraph[]) per the schema. Empty
 * paragraphs are dropped — they only happen when consecutive
 * paragraph_breaks slip through the parser, and rendering an empty <p>
 * just creates ghost vertical space.
 */
function splitParagraphs(body: readonly BodySegment[]): BodySegment[][] {
  const out: BodySegment[][] = [];
  let current: BodySegment[] = [];
  for (const seg of body) {
    if (seg.type === "paragraph_break") {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(seg);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function renderInline(
  segs: readonly BodySegment[],
  ctx: RenderCtx,
  keyPrefix: string,
): ReactNode[] {
  return segs.map((seg, i) => renderSegment(seg, ctx, `${keyPrefix}-${i}`));
}

function renderSegment(seg: BodySegment, ctx: RenderCtx, key: string): ReactNode {
  switch (seg.type) {
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
      // Object.hasOwn guard: definitions arrives as a plain object after
      // IPC's JSON round-trip, so a term named "constructor" / "toString"
      // would otherwise read an inherited function from Object.prototype
      // and crash on tooltip hover.
      const entries = Object.hasOwn(ctx.definitions, seg.term)
        ? ctx.definitions[seg.term]
        : undefined;
      return <DefinedTerm key={key} term={seg.term} definitions={entries} onJump={ctx.onJump} />;
    }
    case "subsection_label": {
      // First-occurrence-wins anchor id (D7, D14). Duplicate labels
      // render plain so a navigate(subsection) jump-link lands at the
      // canonical first instance. Real legal sections rarely reuse
      // subsection labels; collision-strategy upgrade is v1.1 TODO.
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
  }
}

function renderFormat(
  seg: Extract<BodySegment, { type: "format" }>,
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
