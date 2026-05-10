// Inline highlight + hover tooltip for a defined-term occurrence. The
// tooltip is rendered SYNCHRONOUSLY from the `definitions` prop: the
// loader pre-resolves every term in the section's body[] against the
// module-wide definitions dictionary at corpus:read time
// (electron/corpus-loader.ts joinDefinitionsForSection), so the renderer
// has zero IPC latency and zero flicker. A term may be defined in
// multiple sections — the tooltip lists every defining section, each
// clickable via `onJump` which fires `onActivate(new ref)` upstream.
//
// When `definitions` is undefined or empty the highlight renders without
// a tooltip (graceful degradation — happens if a body[] segment names a
// term that vanished from definitions.json since the section was last
// parsed; not a crash condition).

import { type KeyboardEvent, useState } from "react";
import type { SectionId } from "@/types";

export interface DefinedTermProps {
  term: string;
  definitions: ReadonlyArray<{ defined_in_section: SectionId }> | undefined;
  onJump: (sectionId: SectionId) => void;
}

export function DefinedTerm({ term, definitions, onJump }: DefinedTermProps) {
  const [open, setOpen] = useState(false);
  const hasTooltip = definitions !== undefined && definitions.length > 0;

  // No definitions → inert text. With definitions → a real <button> so
  // hover/focus/keyboard all work without bypassing biome's a11y rules.
  // aria-label pins the accessible name to the term itself, so existing
  // getByRole("button", { name: /§ ... /}) callers continue to match only
  // the inner section-jump buttons inside the tooltip.
  if (!hasTooltip) {
    return (
      <span className="lc-deftrm" data-term={term}>
        {term}
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
      data-term={term}
      aria-label={term}
      aria-haspopup="true"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={onKeyDown}
    >
      {term}
      {open ? (
        <span className="lc-deftrm-tooltip" role="tooltip">
          <span className="lc-deftrm-tooltip-label">Defined in</span>
          {definitions.map((entry) => (
            <button
              key={entry.defined_in_section}
              type="button"
              className="lc-deftrm-tooltip-link"
              onClick={(e) => {
                // Stop propagation so the click doesn't also toggle the
                // outer trigger (which would re-open the tooltip we are
                // about to navigate away from).
                e.stopPropagation();
                onJump(entry.defined_in_section);
              }}
            >
              § {entry.defined_in_section}
            </button>
          ))}
        </span>
      ) : null}
    </button>
  );
}
