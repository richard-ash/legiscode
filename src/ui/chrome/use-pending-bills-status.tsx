import { useEffect } from "react";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { Icons } from "@/ui/icons";
import { usePendingBills } from "@/ui/left-panel/activity/use-pending-bills";
import { registerStatusBarItem } from "./status-bar";

// Registers a status-bar slot showing the pending-bill count when the
// corpus reports more than zero. Hides entirely at zero per
// `feedback_no_placeholder_ui` — a status bar with "0 pending" would
// imply the operator hasn't run sync yet, but jurisdictions that
// never publish pending bills (no manifest.pending_bill_source) get
// the same zero count and the same suppressed indicator.
//
// Consumes the canonical `usePendingBills` hook so the count + the
// activity panel + the section pending-rail share one source of truth
// (DRY per Section 2 lock #2).
export function usePendingBillsStatus(corpus: CorpusModuleSummary | null): void {
  const { count } = usePendingBills(corpus);
  useEffect(() => {
    if (count <= 0) return;
    const dispose = registerStatusBarItem({
      id: "pending-bills-count",
      slot: "right",
      // Lower than the existing right-slot built-ins so the badge sits
      // before "⌘P for sections" in the visual order. The built-in
      // command-palette hint doesn't register through this API; right-
      // slot priority numbers therefore just order our future
      // registered items relative to each other.
      priority: 50,
      render: () => (
        <span title={`${count} pending ${count === 1 ? "ordinance" : "ordinances"} loaded`}>
          <Icons.Bill size={11} color="var(--peach)" />
          {count} pending
        </span>
      ),
    });
    return dispose;
  }, [count]);
}
