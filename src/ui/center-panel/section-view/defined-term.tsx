// Inline highlight + hover popover for a defined-term occurrence. The
// popover is rendered SYNCHRONOUSLY from the `definition` prop:
// build-time resolution (L2a) attached a def_id to every defined_term
// body segment, and the loader projected the canonical Definition's
// renderable bits (term, excerpt, scope, defined_in) down to a per-section
// lookup map (electron/corpus-loader.ts joinDefinitionsForSection), so
// the renderer has zero IPC latency and zero flicker.
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
import { computeHoverPosition, useHoverPopover } from "./use-hover-popover";

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

interface HoverPayload {
  anchorRect: DOMRect;
}

export function DefinedTerm({ raw, definition, onJump }: DefinedTermProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hover = useHoverPopover<HoverPayload>();
  const hasTooltip = definition !== undefined;

  // Graceful-degrade: no in-scope definer projected to the wire shape →
  // render inert text with NONE of the decoration (no border-bottom, no
  // italic, no .lc-deftrm hover affordance). The schema-locked
  // §37.3 "Department" behavior — truthful UX over discoverability.
  if (!hasTooltip) {
    return <span data-term={raw}>{raw}</span>;
  }

  const open = hover.state !== null;

  const captureRect = () => {
    const el = buttonRef.current;
    if (!el) return null;
    return el.getBoundingClientRect();
  };

  const onMouseEnter = () => {
    const anchorRect = captureRect();
    if (anchorRect) hover.scheduleOpen({ anchorRect });
  };
  const onMouseLeave = () => hover.scheduleClose();

  const onFocus = () => {
    // Keyboard parity: focusing the term opens the popover without the
    // hover delay so Tab → Enter feels responsive.
    const anchorRect = captureRect();
    if (anchorRect) hover.openNow({ anchorRect });
  };
  const onBlur = () => hover.scheduleClose();

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // useHoverPopover owns Escape; Enter on the focused term navigates
    // to the definer. Space falls through to the browser's default
    // button-activate (which fires onClick → same navigation).
    if (e.key === "Enter") {
      e.preventDefault();
      hover.closeNow();
      onJump(definition.first_use_section);
    }
  };

  const onClick = () => {
    hover.closeNow();
    onJump(definition.first_use_section);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="lc-deftrm"
        data-term={definition.term}
        aria-label={definition.term}
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
      {hover.state ? (
        <DefinedTermPopover
          definition={definition}
          anchorRect={hover.state.anchorRect}
          onPopoverEnter={hover.cancelClose}
          onPopoverLeave={hover.scheduleClose}
          onActivate={() => {
            hover.closeNow();
            onJump(definition.first_use_section);
          }}
        />
      ) : null}
    </>
  );
}

interface DefinedTermPopoverProps {
  definition: DefinitionView;
  anchorRect: DOMRect;
  onPopoverEnter: () => void;
  onPopoverLeave: () => void;
  onActivate: () => void;
}

function DefinedTermPopover({
  definition,
  anchorRect,
  onPopoverEnter,
  onPopoverLeave,
  onActivate,
}: DefinedTermPopoverProps) {
  const { top, left } = computeHoverPosition(anchorRect);
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
        <span className="lc-popover-hint">Defined in</span>
        <button type="button" className="lc-popover-action" onClick={onActionClick}>
          Go to § {definition.first_use_section} →
        </button>
      </div>
    </div>
  );
}
