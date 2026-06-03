import { useEffect } from "react";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { Icons } from "@/ui/icons";
import { useSessionBills } from "@/ui/left-panel/activity/use-session-bills";
import { registerStatusBarItem } from "./status-bar";

// Registers a status-bar slot showing the pending-bill count when the
// corpus reports more than zero. Hides entirely at zero per
// `feedback_no_placeholder_ui` — a status bar with "0 pending" would
// imply the operator hasn't run sync yet, but jurisdictions that
// never publish bills (no manifest.bill_source) get the same zero
// count and the same suppressed indicator.
//
// Deliberately reads the `pending` slice only — the status bar
// answers "what's in flight" per design D7, NOT the session count.
// The Activity panel header is where the "X pending · Y enacted"
// breakdown lives.
export function usePendingBillsStatus(corpus: CorpusModuleSummary | null): void {
  const { pending } = useSessionBills(corpus);
  const count = pending.length;
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
