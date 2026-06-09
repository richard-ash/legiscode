// Section pending-rail with the three-mode segmented control.
// Surfaces every pending bill that touches the currently-rendered
// section above the body. Each row carries two distinct affordances:
//
//   1. Bill identifier (file_no) — opens the bill tab. Plain click +
//      Cmd-click background pattern, same as every other bill-open
//      surface in the app.
//
//   2. Original · Changes · Proposed segmented control — picks the
//      render mode for the section body below. Replaces the old
//      binary toggle ("Show changes" / "Clear overlay"): readers
//      have three distinct questions about a pending bill —
//      "what does the section read today?", "what would the bill
//      change?", "what would the section read if it passed?" — and
//      this control answers each one without forcing a separate
//      mental model switch.
//
// Only one row can be active at a time. When a row is active, the
// other rows' segmented controls reset visually to Original (the
// active row's mode reads through the activeOverlay prop). The panel
// grows an explainer block under the active row whose copy depends on
// the active mode.
//
// The segmented control's two non-Original buttons (Changes,
// Proposed) are suppressed per-row when the bill can't render an
// inline diff for THIS section (parse_status !== "ok" OR no diff
// chunks attached to section_id). Affordance promises align with
// capability — a "Changes" button should only appear when changes can
// actually be shown. The row still renders the file_no + status +
// title so the reader can open the bill and see why the diff isn't
// available (status pill + bill-view manual-review banner explain the
// cause).
//
// `overlayUnavailable` covers the defensive case where an overlay
// somehow activated on a row that the per-row gate would now hide
// (e.g. corpus rebuild after the control was clicked). The active
// row surfaces a short reason and the section body stays resting.

import type { KeyboardEvent, MouseEvent } from "react";
import type { Bill, SectionId } from "@/types";
import { STATUS_LABEL, STATUS_TONE } from "@/ui/bill-status";
import { billHasDiffForSection } from "@/ui/diff/bill-section-diff";
import { PerSectionBanner } from "@/ui/diff-view/banner";

export type OverlayMode = "changes" | "proposed";

export interface ActiveOverlay {
  billId: string;
  mode: OverlayMode;
}

export interface SectionPendingRailProps {
  /** Pending Bill rows whose `section_outcomes` include this section.
   *  Empty array suppresses the rail entirely. */
  bills: ReadonlyArray<Bill>;
  /** The section currently in view. Used to decide per-row whether
   *  the bill has a renderable diff for this section. */
  sectionId: SectionId;
  /** Dispatches the bill open when a row's file-no button fires. */
  onOpenBill: (fileNo: string, mode: "primary" | "background") => void;
  /** When non-null, the matching bill row reads as the active overlay
   *  locus. Other rows render in resting state ("Original" pressed,
   *  no highlight). */
  activeOverlay: ActiveOverlay | null;
  /** Mutates the active-overlay state. Pass null to clear (returns
   *  the section to Original). */
  onChangeOverlay: (next: ActiveOverlay | null) => void;
  /** When true AND `activeOverlay` is non-null, the active row
   *  surfaces an "overlay unavailable" reason instead of the
   *  explainer. Used when the bill's parse_status isn't `ok` or no
   *  diff chunks attach to this section. */
  overlayUnavailable?: boolean;
}

export function SectionPendingRail({
  bills,
  sectionId,
  onOpenBill,
  activeOverlay,
  onChangeOverlay,
  overlayUnavailable,
}: SectionPendingRailProps) {
  if (bills.length === 0) return null;

  const onClickFileno = (fileNo: string) => (e: MouseEvent<HTMLButtonElement>) => {
    onOpenBill(fileNo, e.metaKey || e.ctrlKey ? "background" : "primary");
  };
  const onKeyFileno = (fileNo: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpenBill(fileNo, e.metaKey || e.ctrlKey ? "background" : "primary");
    }
  };

  return (
    <aside
      className="lc-section-pending-rail"
      aria-label="Pending ordinances affecting this section"
    >
      <div className="lc-section-pending-rail-label">
        <span aria-hidden>⏵</span>{" "}
        {bills.length === 1 ? "1 pending ordinance" : `${bills.length} pending ordinances`}{" "}
        affecting this section
      </div>
      <ul className="lc-section-pending-rail-list">
        {bills.map((bill) => {
          const isActiveBill = activeOverlay?.billId === bill.file_no;
          const hasDiff = billHasDiffForSection(bill, sectionId);
          // The Changes / Proposed buttons require a renderable
          // outcome. An active row keeps its segmented control
          // visible even if hasDiff degrades after a corpus reload —
          // otherwise the reader couldn't return to Original.
          const showModeButtons = hasDiff || isActiveBill;
          const activeMode: "original" | OverlayMode = isActiveBill
            ? activeOverlay.mode
            : "original";
          const showExplainer = isActiveBill && !overlayUnavailable && activeMode !== "original";
          const showUnavailable = isActiveBill && overlayUnavailable === true;
          return (
            <li
              key={bill.file_no}
              className="lc-section-pending-rail-item"
              data-overlay-active={isActiveBill && activeMode !== "original" ? "true" : undefined}
            >
              <div className="lc-section-pending-rail-row">
                <button
                  type="button"
                  className="lc-section-pending-rail-fileno"
                  data-bill-id={bill.file_no}
                  onClick={onClickFileno(bill.file_no)}
                  onKeyDown={onKeyFileno(bill.file_no)}
                  aria-label={`Open Ord. ${bill.file_no}`}
                >
                  {bill.file_no}
                </button>
                <span className="lc-status-pill" data-s={STATUS_TONE[bill.bill_status]}>
                  {STATUS_LABEL[bill.bill_status]}
                </span>
                <span className="lc-section-pending-rail-title">{bill.short_title}</span>
                {isActiveBill && activeMode !== "original" ? (
                  <span className="lc-section-pending-rail-viewing" aria-hidden>
                    {activeMode === "changes" ? "VIEWING CHANGES" : "VIEWING PROPOSED"}
                  </span>
                ) : null}
                {showModeButtons ? (
                  // biome-ignore lint/a11y/useSemanticElements: segmented-control button group, not a form fieldset
                  <div
                    className="lc-mode-tabs"
                    role="group"
                    aria-label={`View mode for Ord. ${bill.file_no}`}
                  >
                    <button
                      type="button"
                      className="lc-mode-tab"
                      aria-pressed={activeMode === "original"}
                      onClick={() =>
                        // Clearing the overlay is global: any
                        // non-Original row resets to null. When the
                        // user clicks Original on the active row, we
                        // null the state; when they click Original on
                        // a non-active row (which is still possible
                        // when activeOverlay is null and they're just
                        // confirming the resting state), it's a no-op.
                        onChangeOverlay(isActiveBill ? null : activeOverlay)
                      }
                    >
                      Original
                    </button>
                    <button
                      type="button"
                      className="lc-mode-tab"
                      aria-pressed={activeMode === "changes"}
                      onClick={() => onChangeOverlay({ billId: bill.file_no, mode: "changes" })}
                    >
                      Changes
                    </button>
                    <button
                      type="button"
                      className="lc-mode-tab"
                      aria-pressed={activeMode === "proposed"}
                      onClick={() => onChangeOverlay({ billId: bill.file_no, mode: "proposed" })}
                    >
                      Proposed
                    </button>
                  </div>
                ) : null}
              </div>
              {showExplainer ? (
                <div className="lc-section-pending-rail-explainer" role="note">
                  {activeMode === "changes" ? (
                    <>
                      You're viewing the changes <strong>Ord. {bill.file_no}</strong> would make.{" "}
                      Deletions are struck through; additions are highlighted.
                    </>
                  ) : (
                    <>
                      You're viewing this section{" "}
                      <strong>as if Ord. {bill.file_no} had passed.</strong> No diff marks — this is
                      the post-amendment text.
                    </>
                  )}
                </div>
              ) : null}
              {showUnavailable ? (
                <div className="lc-section-pending-rail-unavailable">
                  {(() => {
                    const outcome = bill.section_outcomes.find((o) => o.section_id === sectionId);
                    if (!outcome || outcome.status === "anchored") {
                      return (
                        <span role="note">
                          We couldn't compute changes for this section under Ord. {bill.file_no}.
                        </span>
                      );
                    }
                    return (
                      <PerSectionBanner
                        status={outcome.status}
                        fileNo={bill.file_no}
                        sectionId={sectionId}
                        detailOverride={outcome.detail ?? undefined}
                      />
                    );
                  })()}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
