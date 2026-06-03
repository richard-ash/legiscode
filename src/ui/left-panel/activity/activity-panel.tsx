// Session-bills activity panel. Sits in the left panel below the
// corpus tree, separated by the layout splitter.
//
// Layout (two-group):
//   - Pending group (workflow order, then introduced_at desc).
//   - Visual divider when both groups are non-empty.
//   - Enacted / terminal group (terminal_at desc, fallback to
//     introduced_at). Class B (non-code) bills render here when
//     they're terminal; pending Class B sit in the pending group.
//
// State:
//   - Empty (zero session bills) → empty state with check icon.
//   - Non-empty → vertical scroll of BillRow, one per file_no, with
//     an optional Class B "tail" of compact rows.
//   - Fetch failure (currently always false in v1; wired via prop for
//     when sync-bills next surfaces a retryable error) → hairline
//     "Last refresh failed · try again" line under the header.
//
// Keyboard nav: roving tabIndex on the rows, ArrowUp/Down crosses the
// divider transparently. Header collapse via real <button> with
// aria-expanded + aria-controls (Pass 6 a11y lock #2).

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CorpusModuleSummary } from "@/corpus/wire";
import type { BillMeta } from "@/types";
import { Icons } from "@/ui/icons";
import { BillRow, ClassBBillRow } from "./bill-row";
import { useSessionBills } from "./use-session-bills";
import "./activity.css";

export interface ActivityPanelProps {
  corpus: CorpusModuleSummary | null;
  /** Active bill file_no (for the row's `is-active` highlight). Null
   *  when no bill tab is active. */
  activeBillId: string | null;
  /** Open a bill tab. The container converts (mode) to a NavigationIntent. */
  onOpenBill: (fileNo: string, mode: "primary" | "background") => void;
  /** Open a Class B bill's Legistar URL. Same handler as the bill
   *  view's external link. */
  onOpenLegistar?: (url: string) => void;
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
  onOpenLegistar,
  lookupCodeLabel,
  collapsed,
  onToggleCollapse,
  fetchFailed = false,
  onRetry,
}: ActivityPanelProps) {
  const { pending, enactedTerminal, classBMeta } = useSessionBills(corpus);

  // Split Class B into pending vs. terminal so each cluster appears
  // alongside the matching Class A group. Class B bills with an
  // unmatched legistar_status fall through as "pending" — better than
  // hiding them from the panel entirely.
  const { pendingClassB, terminalClassB } = useMemo(() => {
    const p: BillMeta[] = [];
    const t: BillMeta[] = [];
    for (const m of classBMeta) {
      const status = m.legistar_status.toLowerCase();
      const isTerminal =
        /\bsigned\b/.test(status) ||
        /\bveto/.test(status) ||
        /\bwithdrawn\b/.test(status) ||
        /\bfailed\b/.test(status) ||
        /\beffective\b/.test(status);
      if (isTerminal) t.push(m);
      else p.push(m);
    }
    return { pendingClassB: p, terminalClassB: t };
  }, [classBMeta]);

  const totalCount = pending.length + enactedTerminal.length + classBMeta.length;
  const pendingCount = pending.length + pendingClassB.length;
  const enactedCount = enactedTerminal.length + terminalClassB.length;
  // Flat keyboard sequence: pending → enacted/terminal → terminal Class B.
  // Pending Class B rides at the end of the pending group; terminal Class
  // B rides at the end of the enacted group. file_no is unique per bill.
  const keyboardOrder = useMemo<string[]>(() => {
    const ids: string[] = [];
    for (const b of pending) ids.push(b.file_no);
    for (const m of pendingClassB) ids.push(m.file_no);
    for (const b of enactedTerminal) ids.push(b.file_no);
    for (const m of terminalClassB) ids.push(m.file_no);
    return ids;
  }, [pending, pendingClassB, enactedTerminal, terminalClassB]);

  const [focusedBillId, setFocusedBillId] = useState<string | null>(null);
  const listRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (keyboardOrder.length === 0) {
      setFocusedBillId(null);
      return;
    }
    const first = keyboardOrder[0];
    setFocusedBillId((prev) => {
      if (prev && keyboardOrder.includes(prev)) return prev;
      return first ?? null;
    });
  }, [keyboardOrder]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (keyboardOrder.length === 0) return;
      const idx = focusedBillId ? keyboardOrder.indexOf(focusedBillId) : -1;
      let nextIdx: number | null = null;
      if (e.key === "ArrowDown")
        nextIdx = idx < 0 ? 0 : Math.min(idx + 1, keyboardOrder.length - 1);
      else if (e.key === "ArrowUp") nextIdx = idx <= 0 ? 0 : idx - 1;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = keyboardOrder.length - 1;
      if (nextIdx === null) return;
      e.preventDefault();
      const nextId = keyboardOrder[nextIdx];
      if (!nextId) return;
      setFocusedBillId(nextId);
      const node = listRef.current?.querySelector<HTMLElement>(
        `[data-bill-id="${cssEscape(nextId)}"]`,
      );
      node?.focus();
    },
    [keyboardOrder, focusedBillId],
  );

  const onFocusRequest = useCallback((fileNo: string) => {
    setFocusedBillId(fileNo);
  }, []);

  // D7 header copy: "X pending · Y enacted this session". Empty segment
  // is suppressed, so a session with no terminal bills yet shows just
  // "X pending"; a session with no pending bills yet shows "Y enacted".
  const headerCount = renderHeaderCount(pendingCount, enactedCount);

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
        <span className="lc-activity-header-count">{headerCount}</span>
        <span className="lc-activity-header-grow" />
        <Icons.ChevronDown
          size={11}
          className={collapsed ? "lc-activity-header-chev is-collapsed" : "lc-activity-header-chev"}
        />
      </button>
      {fetchFailed ? <RetryLine onRetry={onRetry} /> : null}
      {totalCount === 0 ? (
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
        <ul
          id={PANEL_ID}
          ref={(el) => {
            listRef.current = el;
          }}
          className="lc-activity-list"
          aria-label="Session ordinances"
          onKeyDown={onKeyDown}
        >
          {pending.map((bill) => (
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
          {pendingClassB.map((meta) => (
            <li key={meta.file_no} className="lc-activity-list-item">
              <ClassBBillRow
                meta={meta}
                isFocused={focusedBillId === meta.file_no}
                onOpenLegistar={onOpenLegistar}
                onFocusRequest={onFocusRequest}
              />
            </li>
          ))}
          {pendingCount > 0 && enactedCount > 0 ? (
            <li className="lc-activity-divider" aria-hidden />
          ) : null}
          {enactedTerminal.map((bill) => (
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
          {terminalClassB.map((meta) => (
            <li key={meta.file_no} className="lc-activity-list-item">
              <ClassBBillRow
                meta={meta}
                isFocused={focusedBillId === meta.file_no}
                onOpenLegistar={onOpenLegistar}
                onFocusRequest={onFocusRequest}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function renderHeaderCount(pending: number, enacted: number): string {
  if (pending > 0 && enacted > 0) return `${pending} pending · ${enacted} enacted`;
  if (pending > 0) return `${pending} pending`;
  if (enacted > 0) return `${enacted} enacted`;
  return "0";
}

function EmptyState(): ReactNode {
  return (
    <div className="lc-activity-empty">
      <Icons.Section size={20} color="var(--overlay0)" />
      <div>No bills this session.</div>
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
