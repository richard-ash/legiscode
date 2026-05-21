// Hover popover for a citation. Mirrors the 2026-05-19 mockup:
//   ┌──────────────────────────────────────┐
//   │ 🔗 CVC § 515                         │   ← header (icon + raw cite)
//   │ California Vehicle Code — Residence  │   ← resolved title
//   │ District                             │
//   ├──────────────────────────────────────┤
//   │ "Residence district" means a portion │   ← body excerpt
//   │ of highway with closely spaced …     │
//   ├──────────────────────────────────────┤
//   │ Cmd+click to open    Go to def. →    │   ← footer
//   └──────────────────────────────────────┘
//
// Body content varies by resolution result:
//   - navigate-section / -appendix / -structural → resolved label + a
//     "Cmd+click to open" / "Go to definition →" footer.
//   - module-not-installed → "{displayName} not downloaded", no footer
//     action (⌘-click is a no-op per the 2026-05-20 decision).
//   - scroll-only → "Scrolls within this section" (informational only).
//   - unresolvable → suppressed; nothing to show.

import type { ResolutionResult } from "@/citations/resolver";

export interface CitationPopoverProps {
  resolution: ResolutionResult;
  rawCite: string;
  /** Bounding rect of the cited span — popover anchors below it. */
  anchorRect: DOMRect;
  /** Resolved title for the target section (when known); used in header. */
  resolvedTitle?: string;
  /** Body excerpt — first few lines of the target section, when known. */
  bodyExcerpt?: string;
  /** Footer "Go to definition →" handler. Same dispatch as ⌘-click on
   *  the underlying cite. Omitted for non-navigable resolutions
   *  (module-not-installed, scroll-only) so the footer renders without
   *  the action button. */
  onActivate?: () => void;
  /** Cursor entered the popover. Parent cancels the pending hide timer
   *  so the popover stays open while the user reads the excerpt and
   *  reaches the "Go to definition →" button. */
  onMouseEnter?: () => void;
  /** Cursor left the popover. Parent re-arms the hide timer. */
  onMouseLeave?: () => void;
}

export function CitationPopover({
  resolution,
  rawCite,
  anchorRect,
  resolvedTitle,
  bodyExcerpt,
  onActivate,
  onMouseEnter,
  onMouseLeave,
}: CitationPopoverProps) {
  if (resolution.kind === "unresolvable") return null;

  const style: React.CSSProperties = {
    position: "fixed",
    top: anchorRect.bottom + 6,
    left: Math.max(8, anchorRect.left),
    maxWidth: 360,
  };

  return (
    <div
      className="lc-cite-popover"
      role="tooltip"
      data-resolution-kind={resolution.kind}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="lc-cite-popover-header">
        <span className="lc-cite-popover-icon" aria-hidden>
          🔗
        </span>
        <span className="lc-cite-popover-raw">{rawCite}</span>
      </div>

      {renderBody(resolution, { resolvedTitle, bodyExcerpt })}

      {renderFooter(resolution, onActivate)}
    </div>
  );
}

function renderBody(
  resolution: ResolutionResult,
  ctx: { resolvedTitle?: string; bodyExcerpt?: string },
) {
  switch (resolution.kind) {
    case "module-not-installed":
      return (
        <div className="lc-cite-popover-body">
          <div className="lc-cite-popover-title">{resolution.displayName}</div>
          <div className="lc-cite-popover-note">Not downloaded</div>
        </div>
      );
    case "scroll-only":
      return (
        <div className="lc-cite-popover-body">
          <div className="lc-cite-popover-note">
            Scrolls within this section ({resolution.subsection})
          </div>
        </div>
      );
    case "navigate-section":
    case "navigate-appendix":
    case "navigate-structural":
      return (
        <div className="lc-cite-popover-body">
          {ctx.resolvedTitle ? (
            <div className="lc-cite-popover-title">{ctx.resolvedTitle}</div>
          ) : null}
          {ctx.bodyExcerpt ? (
            <div className="lc-cite-popover-excerpt">{ctx.bodyExcerpt}</div>
          ) : null}
        </div>
      );
    case "unresolvable":
      return null;
  }
}

function renderFooter(resolution: ResolutionResult, onActivate: (() => void) | undefined) {
  switch (resolution.kind) {
    case "navigate-section":
    case "navigate-structural":
      return (
        <div className="lc-cite-popover-footer">
          <span className="lc-cite-popover-hint">⌘-click to open</span>
          {onActivate ? (
            <button
              type="button"
              className="lc-cite-popover-action"
              onClick={onActivate}
              // Tooltip role on the parent excludes interactive descendants
              // from the accessibility tree by spec, but the button still
              // receives mouse events — keyboard users have the focused
              // span + ⌘+Enter dispatch (see SectionView header comment).
            >
              Go to definition →
            </button>
          ) : null}
        </div>
      );
    case "navigate-appendix":
      // Appendix viewer is v1.1; render the hint without an action so the
      // popover discloses the cite kind without offering a dead button.
      return (
        <div className="lc-cite-popover-footer">
          <span className="lc-cite-popover-hint">⌘-click to open</span>
        </div>
      );
    case "scroll-only":
    case "module-not-installed":
    case "unresolvable":
      return null;
  }
}
