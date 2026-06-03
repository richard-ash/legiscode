// Section pending-rail (r11 → variant B overlay). Surfaces every
// pending bill that touches the currently-rendered section above the
// body. Each row carries two distinct affordances:
//
//   1. Bill identifier (file_no) — opens the bill tab. Plain click +
//      Cmd-click background pattern, same as every other bill-open
//      surface in the app.
//
//   2. Show changes / Clear overlay button — toggles the body's
//      inline overlay. The panel itself is the variant-B locus: when
//      the overlay is on, the row gains a "VIEWING" suffix and grows
//      an explainer block below. No separate inline notice, no second
//      peach-colored chrome saying the same thing.
//
// `overlayUnavailable` is set when the active overlay bill exists but
// can't render an inline diff (parse_status !== "ok", or no spans
// anchored to this section). The toggle still fires, but the row
// surfaces a short reason instead of the explainer, and the section
// body stays in resting state — better to say "we don't know" than
// to render an unchanged body and claim it's the overlay.

import type { KeyboardEvent, MouseEvent } from "react";
import type { Bill } from "@/types";
import { STATUS_LABEL, STATUS_TONE } from "@/ui/bill-status";

export interface SectionPendingRailProps {
  /** Pending Bill rows whose `affected_sections` include this section.
   *  Empty array suppresses the rail entirely. */
  bills: ReadonlyArray<Bill>;
  /** Dispatches the bill open when a row's file-no button fires. */
  onOpenBill: (fileNo: string, mode: "primary" | "background") => void;
  /** When non-null, the matching bill row reads as the active overlay
   *  locus. Other rows render in resting state. */
  activeOverlayBillId: string | null;
  /** Toggles the overlay for a given bill. Pass null to clear. */
  onToggleOverlay: (fileNo: string | null) => void;
  /** When true AND `activeOverlayBillId` is non-null, the active row
   *  surfaces an "overlay unavailable" reason instead of the explainer.
   *  Used when the bill's parse_status isn't `ok` or no text_diff spans
   *  anchor to this section. */
  overlayUnavailable?: boolean;
}

export function SectionPendingRail({
  bills,
  onOpenBill,
  activeOverlayBillId,
  onToggleOverlay,
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
          const isActive = activeOverlayBillId === bill.file_no;
          const showExplainer = isActive && !overlayUnavailable;
          const showUnavailable = isActive && overlayUnavailable === true;
          return (
            <li
              key={bill.file_no}
              className="lc-section-pending-rail-item"
              data-overlay-active={isActive ? "true" : undefined}
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
                {isActive ? (
                  <span className="lc-section-pending-rail-viewing" aria-hidden>
                    VIEWING
                  </span>
                ) : null}
                <button
                  type="button"
                  className="lc-section-pending-rail-toggle"
                  aria-pressed={isActive}
                  aria-label={
                    isActive
                      ? `Clear overlay for Ord. ${bill.file_no}`
                      : `View this section as if Ord. ${bill.file_no} had passed`
                  }
                  onClick={() => onToggleOverlay(isActive ? null : bill.file_no)}
                >
                  {isActive ? "Clear overlay" : "Show changes"}
                </button>
              </div>
              {showExplainer ? (
                <div className="lc-section-pending-rail-explainer" role="note">
                  You're viewing this section <strong>as if Ord. {bill.file_no} had passed.</strong>{" "}
                  The current text is shown with strikethrough; proposed additions are highlighted.
                </div>
              ) : null}
              {showUnavailable ? (
                <div className="lc-section-pending-rail-unavailable" role="note">
                  We couldn't compute changes for this section under Ord. {bill.file_no}.
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
