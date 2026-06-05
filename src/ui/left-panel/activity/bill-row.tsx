// Single row in the activity panel. One row per session bill (deduped
// by file_no via useSessionBills). Click → open the bill tab; Enter /
// Space on a focused row do the same. Cmd/Ctrl-click opens in
// background (mirrors the file-tree contract).
//
// Roving tabIndex: only the focused row in the activity-pane carries
// `tabIndex=0`; the rest are -1. The container drives focus moves on
// ArrowUp/Down. Per Pass 6 a11y lock #3, this is a real <button> so
// the implicit role + Enter/Space semantics carry without override.
//
// React.memo'd per D8.1: the parent re-renders on every keyboard nav
// (focusedBillId changes) but most rows' props are identical between
// renders. Memo prevents N row diff passes per arrow keystroke.

import { type KeyboardEvent, type MouseEvent, memo } from "react";
import type { Bill, BillMeta } from "@/types";
import { STATUS_LABEL, STATUS_TONE } from "@/ui/bill-status";

export interface BillRowProps {
  bill: Bill;
  isActive: boolean;
  isFocused: boolean;
  /** Display name for the bill's primary module — e.g. "Police Code". */
  codeLabel: string | null;
  /** The list of section ids this bill touches across modules, in
   *  display order. Rendered as a horizontal strip of chips at the
   *  bottom of the row. Empty when no module has touched sections. */
  touches: ReadonlyArray<string>;
  onOpen: (fileNo: string, mode: "primary" | "background") => void;
  onFocusRequest: (fileNo: string) => void;
}

function BillRowImpl({
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

export const BillRow = memo(BillRowImpl);
BillRow.displayName = "BillRow";

// Class B (non-code) bill row — backed by BillMeta only (no parsed
// body, no section_outcomes, no module_id). Click opens Legistar in
// the platform browser; there's no per-bill detail tab to render
// because the renderer has no parsed text to show. Per the v1.0
// deferral, full Class B parsing is a follow-up (TODOS.md).
export interface ClassBBillRowProps {
  meta: BillMeta;
  isFocused: boolean;
  onOpenLegistar?: (url: string) => void;
  onFocusRequest: (fileNo: string) => void;
}

function ClassBBillRowImpl({
  meta,
  isFocused,
  onOpenLegistar,
  onFocusRequest,
}: ClassBBillRowProps) {
  const onClick = () => onOpenLegistar?.(meta.legistar_url);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpenLegistar?.(meta.legistar_url);
    }
  };
  return (
    <button
      type="button"
      className="lc-bill-row is-class-b"
      data-bill-id={meta.file_no}
      tabIndex={isFocused ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={() => onFocusRequest(meta.file_no)}
      title="Non-code ordinance — opens on Legistar"
    >
      <span className="lc-bill-row-top">
        <code className="lc-bill-row-fileno">{meta.file_no}</code>
        <span className="lc-status-pill" data-s="overlay0">
          Non-code
        </span>
      </span>
      <span className="lc-bill-row-title">{meta.short_title}</span>
      <span className="lc-bill-row-meta">
        {meta.sponsor ? <span>{meta.sponsor}</span> : null}
        {meta.sponsor && meta.introduced_at ? (
          <span className="lc-bill-row-meta-sep" aria-hidden>
            ·
          </span>
        ) : null}
        {meta.introduced_at ? <span>{meta.introduced_at}</span> : null}
      </span>
    </button>
  );
}

export const ClassBBillRow = memo(ClassBBillRowImpl);
ClassBBillRow.displayName = "ClassBBillRow";
