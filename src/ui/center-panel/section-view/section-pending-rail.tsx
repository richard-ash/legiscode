// Section pending-rail (r11). Surfaces every pending bill that
// touches the currently-rendered section above the body. Each row is
// clickable → opens the bill tab. Peach-left-border styling marks the
// rail as a forward-looking signal distinct from the section content
// underneath.
//
// Pass 7 lock #2: no truncation, no internal scroll. Typical SF data
// shape is 1-2 affecting bills per section; revisit when a single
// section accumulates 5+.

import type { KeyboardEvent, MouseEvent } from "react";
import type { Bill } from "@/types";
import { STATUS_LABEL, STATUS_TONE } from "@/ui/bill-status";

export interface SectionPendingRailProps {
  /** Pending Bill rows whose `affected_sections` include this section.
   *  Empty array suppresses the rail entirely (Pass 2 lock — no rail
   *  for sections with no affecting bills). */
  bills: ReadonlyArray<Bill>;
  /** Dispatches the bill open. The container converts mode → intent. */
  onOpenBill: (fileNo: string, mode: "primary" | "background") => void;
}

export function SectionPendingRail({ bills, onOpenBill }: SectionPendingRailProps) {
  if (bills.length === 0) return null;
  const onClick = (fileNo: string) => (e: MouseEvent<HTMLButtonElement>) => {
    onOpenBill(fileNo, e.metaKey || e.ctrlKey ? "background" : "primary");
  };
  const onKey = (fileNo: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
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
        {bills.map((bill) => (
          <li key={bill.file_no}>
            <button
              type="button"
              className="lc-section-pending-rail-row"
              data-bill-id={bill.file_no}
              onClick={onClick(bill.file_no)}
              onKeyDown={onKey(bill.file_no)}
            >
              <code className="lc-section-pending-rail-fileno">{bill.file_no}</code>
              <span className="lc-status-pill" data-s={STATUS_TONE[bill.bill_status]}>
                {STATUS_LABEL[bill.bill_status]}
              </span>
              <span className="lc-section-pending-rail-title">{bill.short_title}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
