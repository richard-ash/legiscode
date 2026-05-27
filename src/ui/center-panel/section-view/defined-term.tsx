// Inline highlight + hover trigger for a defined-term occurrence. The
// popover is rendered SYNCHRONOUSLY from the `definition` prop:
// build-time resolution (L2a) attached a def_id to every defined_term
// body segment, and the loader projected the canonical Definition's
// renderable bits (term, excerpt, scope, defined_in) down to a per-section
// lookup map (electron/corpus-loader.ts joinDefinitionsForSection), so
// the renderer has zero IPC latency and zero flicker.
//
// Hover state lives on the SectionView's shared `useHoverPopover`
// instance (via SectionHoverContext) — DefinedTerm doesn't own its own
// state machine. The "one popover at a time" invariant is structural:
// if a citation popover is currently visible and the user tabs to a
// defined term, the citation popover is replaced by the defined-term
// popover atomically. The popover itself renders at the lc-doc-inner
// level (outside the `<p>` that contains this button), avoiding the
// `<div>`-inside-`<p>` DOM-validity issue an inline render would
// trigger.
//
// Layout mirrors the citation popover (same `.lc-popover-*` chrome)
// so the user learns one popover anatomy. Header background is tinted
// green via `data-kind="def"` to mirror the green dashed-underline of
// the inline term — visual continuity between the inline highlight and
// the popover.
//
// Graceful degrade: when `definition` is undefined the renderer drops
// the `.lc-deftrm` class, the italic, and the dashed underline; the
// term reads as inline prose. The §37.3 "Department" case: Chapter 37
// doesn't define "Department" and no in-scope ancestor does either, so
// the build pipeline doesn't attach a def_id. Decorating the word would
// be a claim the data can't back up.

import { type KeyboardEvent, type MouseEvent, useRef } from "react";
import type { ScopeExpr, SectionId } from "@/types";
import { useSectionHover } from "./hover-context";
import { usePopoverPosition } from "./use-hover-popover";

export interface DefinitionView {
  term: string;
  excerpt: string;
  scope: ScopeExpr;
  /** Section where the term is defined. Field name is a holdover from
   *  an earlier wire shape; semantically this is the definer's section
   *  id, populated from `Definition.defined_in` in the loader. */
  first_use_section: SectionId;
}

export interface DefinedTermProps {
  /** Surface text as written in the source (display + fallback aria-label). */
  raw: string;
  /** The pre-resolved Definition's renderable bits, or undefined if the
   *  def_id couldn't be projected (extractor/loader mismatch, or no
   *  in-scope definer exists per the §37.3 graceful-degrade case). */
  definition: DefinitionView | undefined;
  onJump: (sectionId: SectionId) => void;
}

export function DefinedTerm({ raw, definition, onJump }: DefinedTermProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hover = useSectionHover();
  const hasTooltip = definition !== undefined;

  // Graceful-degrade: no in-scope definer projected to the wire shape →
  // render inert text with NONE of the decoration (no border-bottom, no
  // italic, no .lc-deftrm hover affordance). The schema-locked
  // §37.3 "Department" behavior — truthful UX over discoverability.
  if (!hasTooltip) {
    return <span>{raw}</span>;
  }

  // Open only when the shared hook is showing THIS term's popover.
  // Compare anchorElement against this button's ref so the right
  // <button> reports aria-expanded=true while the others stay false.
  const open =
    hover?.state?.kind === "definedTerm" && hover.state.anchorElement === buttonRef.current;

  const dispatchOpen = (mode: "hover" | "immediate") => {
    if (!hover) return;
    const el = buttonRef.current;
    if (!el) return;
    const payload = {
      kind: "definedTerm" as const,
      definition,
      anchorElement: el,
      onActivate: () => {
        hover.closeNow();
        onJump(definition.first_use_section);
      },
    };
    if (mode === "immediate") hover.openNow(payload);
    else hover.showOrSnap(payload);
  };

  const onMouseEnter = () => dispatchOpen("hover");
  const onMouseLeave = () => hover?.scheduleClose();

  const onFocus = () => {
    // Keyboard parity: focusing the term opens the popover without the
    // hover delay so Tab → Enter feels responsive.
    dispatchOpen("immediate");
  };
  const onBlur = () => hover?.scheduleClose();

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // useHoverPopover owns Escape; Enter on the focused term navigates
    // to the definer. Space falls through to the browser's default
    // button-activate (which fires onClick → same navigation).
    if (e.key === "Enter") {
      e.preventDefault();
      hover?.closeNow();
      onJump(definition.first_use_section);
    }
  };

  const onClick = () => {
    hover?.closeNow();
    onJump(definition.first_use_section);
  };

  // aria-label only when the visible text and canonical term diverge —
  // an inflection like "vessels" vs canonical "Vessel". When they
  // match, the button text itself is the accessible name and the
  // explicit label would duplicate (and sometimes pronounce
  // differently from) the visible text.
  const ariaLabel = raw === definition.term ? undefined : definition.term;

  return (
    <button
      ref={buttonRef}
      type="button"
      className="lc-deftrm"
      data-term={definition.term}
      aria-label={ariaLabel}
      aria-haspopup="true"
      aria-expanded={open}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {raw}
    </button>
  );
}

export interface DefinedTermPopoverProps {
  definition: DefinitionView;
  /** The button element this popover is anchored to. Position is
   *  computed from `getBoundingClientRect()` at render time so reflow
   *  between hover and open doesn't strand the popover at a stale
   *  position. */
  anchorElement: HTMLElement;
  onPopoverEnter: () => void;
  onPopoverLeave: () => void;
  onActivate: () => void;
}

/**
 * Defined-term popover. Rendered by SectionView (not DefinedTerm) so
 * the `<div>` doesn't end up nested inside the `<p>` that contains the
 * triggering button. SectionView reads the hover-popover state and
 * mounts this component when the active payload's kind is
 * "definedTerm".
 */
export function DefinedTermPopover({
  definition,
  anchorElement,
  onPopoverEnter,
  onPopoverLeave,
  onActivate,
}: DefinedTermPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const { top, left } = usePopoverPosition(anchorElement, popoverRef);
  const style: React.CSSProperties = {
    position: "fixed",
    top,
    left,
    maxWidth: 360,
  };
  const onActionClick = (e: MouseEvent<HTMLButtonElement>) => {
    // Stop the click from bubbling back to the body's onClick delegate
    // (which is purely a citation event-delegation seam, but defensive
    // against future event handlers added to the body container).
    e.stopPropagation();
    onActivate();
  };
  return (
    <div
      ref={popoverRef}
      className="lc-popover"
      role="tooltip"
      data-popover-kind="defined-term"
      style={style}
      onMouseEnter={onPopoverEnter}
      onMouseLeave={onPopoverLeave}
    >
      <div className="lc-popover-header" data-kind="def">
        <span className="lc-popover-icon" aria-hidden>
          §
        </span>
        <span className="lc-popover-raw">{definition.term}</span>
      </div>
      <div className="lc-popover-body">
        <div className="lc-popover-excerpt">{definition.excerpt}</div>
      </div>
      <div className="lc-popover-footer">
        <span className="lc-popover-hint">Click to navigate</span>
        <button type="button" className="lc-popover-action" onClick={onActionClick}>
          Go to § {definition.first_use_section} →
        </button>
      </div>
    </div>
  );
}
