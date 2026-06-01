// Single row in the activity panel. One row per pending bill (deduped
// by file_no via usePendingBills). Click → open the bill tab; Enter /
// Space on a focused row do the same. Cmd/Ctrl-click opens in
// background (mirrors the file-tree contract).
//
// Roving tabIndex: only the focused row in the activity-pane carries
// `tabIndex=0`; the rest are -1. The container drives focus moves on
// ArrowUp/Down. Per Pass 6 a11y lock #3, this is a real <button> so
// the implicit role + Enter/Space semantics carry without override.

import type { KeyboardEvent, MouseEvent } from "react";
import type { Bill } from "@/types";
import { STATUS_LABEL, STATUS_TONE } from "@/ui/bill-status";

export interface BillRowProps {
  bill: Bill;
  isActive: boolean;
  isFocused: boolean;
  /** Display name for the bill's primary module — e.g. "Police Code". */
  codeLabel: string | null;
  /** The list of section ids this bill touches across modules, in
   *  display order. Rendered as a horizontal strip of chips at the
   *  bottom of the row. Empty when no module has affected_sections. */
  touches: ReadonlyArray<string>;
  onOpen: (fileNo: string, mode: "primary" | "background") => void;
  onFocusRequest: (fileNo: string) => void;
}

export function BillRow({
  bill,
  isActive,
  isFocused,
  codeLabel,
  touches,
  onOpen,
  onFocusRequest,
}: BillRowProps) {
  const tone = STATUS_TONE[bill.bill_status];
  const label = STATUS_LABEL[bill.bill_status];
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const mode = e.metaKey || e.ctrlKey ? "background" : "primary";
    onOpen(bill.file_no, mode);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const mode = e.metaKey || e.ctrlKey ? "background" : "primary";
      onOpen(bill.file_no, mode);
    }
  };
  return (
    <button
      type="button"
      className={`lc-bill-row${isActive ? " is-active" : ""}`}
      data-bill-id={bill.file_no}
      tabIndex={isFocused ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={() => onFocusRequest(bill.file_no)}
    >
      <span className="lc-bill-row-top">
        <code className="lc-bill-row-fileno">{bill.file_no}</code>
        <span className="lc-status-pill" data-s={tone}>
          {label}
        </span>
      </span>
      <span className="lc-bill-row-title">{bill.short_title}</span>
      <span className="lc-bill-row-meta">
        {codeLabel ? <span>{codeLabel}</span> : null}
        {codeLabel && bill.sponsor ? (
          <span className="lc-bill-row-meta-sep" aria-hidden>
            ·
          </span>
        ) : null}
        {bill.sponsor ? <span>{bill.sponsor}</span> : null}
        {(codeLabel || bill.sponsor) && bill.introduced_at ? (
          <span className="lc-bill-row-meta-sep" aria-hidden>
            ·
          </span>
        ) : null}
        {bill.introduced_at ? <span>{bill.introduced_at}</span> : null}
      </span>
      {touches.length > 0 ? (
        <span className="lc-bill-row-touches">
          {touches.map((sectionId) => (
            <span key={sectionId} className="lc-bill-row-touch">
              § {sectionId}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}
