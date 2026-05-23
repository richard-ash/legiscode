// Inline highlight + hover tooltip for a defined-term occurrence. The
// tooltip is rendered SYNCHRONOUSLY from the `definition` prop: build-time
// resolution (L2a) attached a def_id to every defined_term body segment,
// and the loader projected the canonical Definition's renderable bits
// (term, excerpt, first_use_section) down to a per-section lookup map
// (electron/corpus-loader.ts joinDefinitionsForSection), so the renderer
// has zero IPC latency and zero flicker.
//
// When `definition` is undefined the highlight renders without a tooltip
// (graceful degradation — happens if a body[] segment names a def_id that
// vanished from definitions-v2.json since the section was last parsed;
// not a crash condition).

import { type KeyboardEvent, useState } from "react";
import type { ScopeExpr, SectionId } from "@/types";

export interface DefinitionView {
  term: string;
  excerpt: string;
  scope: ScopeExpr;
  first_use_section: SectionId;
}

export interface DefinedTermProps {
  /** Surface text as written in the source (display + fallback aria-label). */
  raw: string;
  /** The pre-resolved Definition's renderable bits, or undefined if the
   *  def_id couldn't be projected (extractor/loader mismatch). */
  definition: DefinitionView | undefined;
  onJump: (sectionId: SectionId) => void;
}

export function DefinedTerm({ raw, definition, onJump }: DefinedTermProps) {
  const [open, setOpen] = useState(false);
  const hasTooltip = definition !== undefined;

  // No definition projected → inert text. With definition → a real
  // <button> so hover/focus/keyboard all work without bypassing
  // biome's a11y rules. aria-label pins the accessible name to the
  // canonical term (preferred when available, else the surface form),
  // so existing getByRole("button", { name: /§ ... /}) callers
  // continue to match only the inner section-jump button inside the
  // tooltip.
  if (!hasTooltip) {
    return (
      <span className="lc-deftrm" data-term={raw}>
        {raw}
      </span>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Escape" && open) {
      setOpen(false);
    }
  };

  return (
    <button
      type="button"
      className="lc-deftrm"
      data-term={definition.term}
      aria-label={definition.term}
      aria-haspopup="true"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={onKeyDown}
    >
      {raw}
      {open ? (
        <span className="lc-deftrm-tooltip" role="tooltip">
          <span className="lc-deftrm-tooltip-excerpt">{definition.excerpt}</span>
          <button
            type="button"
            className="lc-deftrm-tooltip-link"
            onClick={(e) => {
              // Stop propagation so the click doesn't also toggle the
              // outer trigger (which would re-open the tooltip we are
              // about to navigate away from).
              e.stopPropagation();
              onJump(definition.first_use_section);
            }}
          >
            § {definition.first_use_section}
          </button>
        </span>
      ) : null}
    </button>
  );
}
