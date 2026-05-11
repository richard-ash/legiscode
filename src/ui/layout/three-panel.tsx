// Three-panel IDE layout backed by `react-resizable-panels` v4 (Group +
// Panel + Separator). Layouts persist via `useDefaultLayout` against the
// raw `Storage` backend exposed by `@/persistence` (Layer 1 —
// feat/file-tree). The library owns its own opaque key namespace; routing
// it through `getStorageBackend()` keeps the centralization invariant
// while letting the library manage its keys without a custom adapter.
// Defaults match DESIGN.md: 240px left, 320px right, fluid center.
// Keyboard toggles ⌘B (left) and ⌘⌥B (right) collapse panels via the
// imperative API.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { getStorageBackend } from "@/persistence";
import { shouldHandleGlobalShortcut } from "@/ui/tabs/should-handle-shortcut";

const LAYOUT_ID = "legiscode-three-panel";
const PANEL_IDS = ["left", "center", "right"];

export interface ThreePanelProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

export function ThreePanel({ left, center, right }: ThreePanelProps) {
  const leftRef = usePanelRef();
  const rightRef = usePanelRef();
  const [storage, setStorage] = useState<Storage | undefined>(undefined);
  useEffect(() => {
    setStorage(getStorageBackend());
  }, []);

  const layout = useDefaultLayout({
    id: LAYOUT_ID,
    panelIds: PANEL_IDS,
    storage,
  });

  const toggle = useCallback((handle: typeof leftRef) => {
    const cur = handle.current;
    if (!cur) return;
    if (cur.isCollapsed()) cur.expand();
    else cur.collapse();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!(e.key === "b" || e.key === "B")) return;
      if (!shouldHandleGlobalShortcut(e)) return;
      if (!e.altKey) {
        e.preventDefault();
        toggle(leftRef);
      } else {
        e.preventDefault();
        toggle(rightRef);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, leftRef, rightRef]);

  return (
    <Group
      orientation="horizontal"
      className="lc-panel-group"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <Panel
        id="left"
        panelRef={leftRef}
        defaultSize="20%"
        minSize="12%"
        maxSize="40%"
        collapsible
        collapsedSize={0}
      >
        {left}
      </Panel>
      <Separator className="lc-resize-handle" />
      <Panel id="center" defaultSize="56%" minSize="30%">
        {center}
      </Panel>
      <Separator className="lc-resize-handle" />
      <Panel
        id="right"
        panelRef={rightRef}
        defaultSize="24%"
        minSize="14%"
        maxSize="42%"
        collapsible
        collapsedSize={0}
      >
        {right}
      </Panel>
    </Group>
  );
}
