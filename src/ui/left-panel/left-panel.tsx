// Left-panel composition: corpus tree (top) + splitter + pending-bills
// activity panel (bottom). State for the splitter + collapse lives in
// localStorage via @/persistence so a reload restores the user's last
// split. Defaults are 0.45 (45% of left panel for activity) + expanded,
// per the IMPL-PLAN.

import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { readActivityPaneState, writeActivityPaneState } from "@/persistence";
import { Splitter } from "@/ui/layout/splitter";
import { ActivityPanel } from "@/ui/left-panel/activity/activity-panel";

const DEFAULT_HEIGHT = 0.45;
const DEFAULT_COLLAPSED = false;

export interface LeftPanelProps {
  corpus: CorpusModuleSummary | null;
  /** Top-section content (corpus tree + title chrome). */
  codesPane: ReactNode;
  /** Active bill file_no for the activity panel's row highlight. */
  activeBillId: string | null;
  onOpenBill: (fileNo: string, mode: "primary" | "background") => void;
  lookupCodeLabel?: (moduleId: string) => string | null;
}

export function LeftPanel({
  corpus,
  codesPane,
  activeBillId,
  onOpenBill,
  lookupCodeLabel,
}: LeftPanelProps) {
  // Hydrate from persistence after mount so SSR-safe boot doesn't
  // touch `window.localStorage`. Defaults apply until the first read.
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState<boolean>(DEFAULT_COLLAPSED);
  useEffect(() => {
    const persisted = readActivityPaneState();
    if (persisted) {
      setHeight(persisted.height);
      setCollapsed(persisted.collapsed);
    }
  }, []);

  const persist = useCallback((next: { height: number; collapsed: boolean }) => {
    writeActivityPaneState(next);
  }, []);

  const onSplitterChange = useCallback((next: number) => {
    setHeight(next);
  }, []);
  const onSplitterCommit = useCallback(
    (next: number) => {
      setHeight(next);
      persist({ height: next, collapsed });
    },
    [collapsed, persist],
  );

  const onToggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      persist({ height, collapsed: next });
      return next;
    });
  }, [height, persist]);

  // When collapsed, activity-pane takes exactly its 34px header; the
  // splitter is suppressed (no drag handle visible). When expanded,
  // the flex distribution honors `height`.
  const codesFlex = collapsed ? "1 1 0" : `${1 - height} 1 0`;
  const activityStyle = collapsed ? { flex: "0 0 34px" } : { flex: `${height} 1 0`, minHeight: 0 };

  return (
    <div className="lc-leftpanel">
      <div className="lc-leftpanel-codes" style={{ flex: codesFlex, minHeight: 0 }}>
        {codesPane}
      </div>
      {!collapsed ? (
        <Splitter
          value={height}
          onChange={onSplitterChange}
          onCommit={onSplitterCommit}
          ariaLabel="Resize activity pane"
        />
      ) : null}
      <div style={activityStyle} className="lc-leftpanel-activity">
        <ActivityPanel
          corpus={corpus}
          activeBillId={activeBillId}
          onOpenBill={onOpenBill}
          lookupCodeLabel={lookupCodeLabel}
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
        />
      </div>
    </div>
  );
}
