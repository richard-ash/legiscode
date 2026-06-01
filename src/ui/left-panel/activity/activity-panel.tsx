// Pending-bills activity panel. Sits in the left panel below the
// corpus tree, separated by the layout splitter (r11).
//
// State:
//   - Empty (zero pending bills) → empty state with check icon.
//   - Non-empty → vertical scroll of BillRow, one per file_no.
//   - Fetch failure (currently always false in v1; wired via prop for
//     when sync-bills next surfaces a retryable error) → hairline
//     "Last refresh failed · try again" line under the header.
//
// Keyboard nav: roving tabIndex on the rows, ArrowUp/Down between rows,
// Enter / Space activate. Header collapse via real <button> with
// aria-expanded + aria-controls (Pass 6 a11y lock #2).

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { Icons } from "@/ui/icons";
import { BillRow } from "./bill-row";
import { usePendingBills } from "./use-pending-bills";
import "./activity.css";

export interface ActivityPanelProps {
  corpus: CorpusModuleSummary | null;
  /** Active bill file_no (for the row's `is-active` highlight). Null
   *  when no bill tab is active. */
  activeBillId: string | null;
  /** Open a bill tab. The container converts (mode) to a NavigationIntent. */
  onOpenBill: (fileNo: string, mode: "primary" | "background") => void;
  /** Resolves a module id to its display name for the bill-row meta. */
  lookupCodeLabel?: (moduleId: string) => string | null;
  /** Pane is collapsed (only the header visible). The splitter is
   *  hidden by the parent when collapsed. */
  collapsed: boolean;
  /** Toggle the collapse state. */
  onToggleCollapse: () => void;
  /** Set to true when the most-recent fetch attempt failed; the
   *  hairline "Last refresh failed" line surfaces under the header.
   *  Defaults to false. */
  fetchFailed?: boolean;
  /** Optional retry callback for the fetch-failure line. When unset
   *  the line is non-interactive. */
  onRetry?: () => void;
}

const PANEL_ID = "lc-activity-panel-list";

export function ActivityPanel({
  corpus,
  activeBillId,
  onOpenBill,
  lookupCodeLabel,
  collapsed,
  onToggleCollapse,
  fetchFailed = false,
  onRetry,
}: ActivityPanelProps) {
  const { bills, count } = usePendingBills(corpus);

  // Roving tabIndex: which row currently carries tabIndex=0. Defaults
  // to the first row; updated by ArrowUp/Down and focus events. We
  // keep this here (not in each row) so the container can dispatch
  // focus moves without re-rendering every row.
  const [focusedBillId, setFocusedBillId] = useState<string | null>(null);
  const listRef = useRef<HTMLElement | null>(null);

  // Reset focused row when bills change shape (e.g. sync reloads, a
  // bill ages out). Defaults to the first row when the panel mounts.
  useEffect(() => {
    if (bills.length === 0) {
      setFocusedBillId(null);
      return;
    }
    const first = bills[0]?.file_no;
    setFocusedBillId((prev) => {
      if (prev && bills.some((b) => b.file_no === prev)) return prev;
      return first ?? null;
    });
  }, [bills]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (bills.length === 0) return;
      const idx = focusedBillId ? bills.findIndex((b) => b.file_no === focusedBillId) : -1;
      let nextIdx: number | null = null;
      if (e.key === "ArrowDown") nextIdx = idx < 0 ? 0 : Math.min(idx + 1, bills.length - 1);
      else if (e.key === "ArrowUp") nextIdx = idx <= 0 ? 0 : idx - 1;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = bills.length - 1;
      if (nextIdx === null) return;
      e.preventDefault();
      const nextId = bills[nextIdx]?.file_no;
      if (!nextId) return;
      setFocusedBillId(nextId);
      // Drive focus to the row element so screen readers announce
      // (and the visual outline tracks the logical focus).
      const node = listRef.current?.querySelector<HTMLElement>(
        `[data-bill-id="${cssEscape(nextId)}"]`,
      );
      node?.focus();
    },
    [bills, focusedBillId],
  );

  const onFocusRequest = useCallback((fileNo: string) => {
    setFocusedBillId(fileNo);
  }, []);

  return (
    <div className={`lc-activity-pane${collapsed ? " is-collapsed" : ""}`}>
      <button
        type="button"
        className="lc-activity-header"
        aria-expanded={!collapsed}
        aria-controls={PANEL_ID}
        onClick={onToggleCollapse}
      >
        <Icons.Bill size={14} color="var(--peach)" />
        <span className="lc-activity-header-label">Activity</span>
        <span className="lc-activity-header-count">{count} pending</span>
        <span className="lc-activity-header-grow" />
        <Icons.ChevronDown
          size={11}
          className={collapsed ? "lc-activity-header-chev is-collapsed" : "lc-activity-header-chev"}
        />
      </button>
      {fetchFailed ? <RetryLine onRetry={onRetry} /> : null}
      {bills.length === 0 ? (
        <div
          id={PANEL_ID}
          ref={(el) => {
            listRef.current = el;
          }}
          className="lc-activity-list"
        >
          <EmptyState />
        </div>
      ) : (
        // biome-ignore lint/a11y/useFocusableInteractive: focus is captured by individual <button> rows via roving tabIndex; the ul is just the scroll container that observes ArrowUp/Down to dispatch focus moves.
        <ul
          id={PANEL_ID}
          ref={(el) => {
            listRef.current = el;
          }}
          className="lc-activity-list"
          aria-label="Pending ordinances"
          onKeyDown={onKeyDown}
        >
          {bills.map((bill) => (
            <li key={bill.file_no} className="lc-activity-list-item">
              <BillRow
                bill={bill}
                isActive={activeBillId === bill.file_no}
                isFocused={focusedBillId === bill.file_no}
                codeLabel={lookupCodeLabel?.(bill.module_id) ?? null}
                touches={bill.affected_sections}
                onOpen={onOpenBill}
                onFocusRequest={onFocusRequest}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState(): ReactNode {
  return (
    <div className="lc-activity-empty">
      <Icons.Section size={20} color="var(--overlay0)" />
      <div>No pending bills.</div>
    </div>
  );
}

function RetryLine({ onRetry }: { onRetry?: () => void }): ReactNode {
  if (onRetry) {
    return (
      <div className="lc-activity-retry">
        Last refresh failed ·{" "}
        <button type="button" className="lc-activity-retry-link" onClick={onRetry}>
          try again
        </button>
      </div>
    );
  }
  return <div className="lc-activity-retry">Last refresh failed</div>;
}

// Minimal CSS.escape shim for jsdom where the global may be missing.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  // Conservative replace — file_no values are digits, but downstream
  // jurisdictions could ship hyphens or letters; escape any
  // non-alphanumeric.
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
