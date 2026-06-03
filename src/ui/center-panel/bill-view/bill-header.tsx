// Bill-detail header: kicker (Code · status badge) + h1 (#file_no +
// short_title) + bill-meta row (introduced date, sponsor, Open in
// Legistar). The status badge in the kicker conveys the signal — no
// duplicate pill in the meta row.
//
// `bills` is the per-module Bill rows for this file_no (the BillView
// aggregator passes them through). Header fields collapse on
// file_no, so any row is fine; we use the first plus the module
// display name from the matching tree node.

import type { CorpusRef } from "@/corpus/refs";
import type { Bill } from "@/types";
import { STATUS_LABEL, STATUS_TONE } from "@/ui/bill-status";

export interface BillHeaderProps {
  /** Any one of the per-module Bill rows for this file_no — the header
   *  fields are identical across rows of the same matter. */
  bill: Bill;
  /** Display name for the kicker, e.g. "Police Code". Resolved from
   *  the module's tree node by the BillView container. Falls back to
   *  the module_id when unresolved. */
  codeLabel: string;
  /** Opens the bill in the system default browser via
   *  shell.openExternal. The IPC handler validates the URL is http(s)
   *  before dispatch (electron/ipc/shell.ts). */
  onOpenLegistar: () => void;
}

export function BillHeader({ bill, codeLabel, onOpenLegistar }: BillHeaderProps) {
  const tone = STATUS_TONE[bill.bill_status];
  const statusLabel = STATUS_LABEL[bill.bill_status];
  return (
    <header className="lc-billheader">
      <div className="lc-billheader-kicker">
        <span className="lc-billheader-kicker-code">{codeLabel}</span>
        <span className="lc-billheader-kicker-sep" aria-hidden>
          ·
        </span>
        <span className="lc-billheader-kicker-status" data-s={tone}>
          {statusLabel}
        </span>
      </div>
      <h1 className="lc-billheader-title">
        <code className="lc-billheader-fileno">#{bill.file_no}</code>
        <span>{bill.short_title}</span>
      </h1>
      <div className="lc-billheader-meta">
        {bill.introduced_at ? (
          <span>
            Introduced <strong>{bill.introduced_at}</strong>
          </span>
        ) : null}
        {bill.introduced_at && bill.sponsor ? (
          <span className="lc-billheader-meta-sep" aria-hidden>
            ·
          </span>
        ) : null}
        {bill.sponsor ? (
          <span>
            Sponsor: <strong>{bill.sponsor}</strong>
          </span>
        ) : null}
        <button
          type="button"
          className="lc-billheader-legistar"
          onClick={onOpenLegistar}
          aria-label={`Open Ord. ${bill.file_no} in Legistar`}
        >
          Open in Legistar
        </button>
      </div>
    </header>
  );
}

/** Equality predicate for memoizing the header against bill identity.
 *  Used by the parent container to skip a re-render when only the
 *  unrelated row's per-module fields change. */
export function billHeaderKey(ref: CorpusRef): string {
  return `${ref.module}::${ref.section}`;
}
