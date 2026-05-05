// Status bar. Phase 1 ships hardcoded slots (corpus version, code count,
// ⌘K hint) plus a `register({ id, slot, priority, render })` API that
// downstream branches use to add ordinance/diff/flag indicators without
// touching this file (A10).
//
// Ordering rules:
//   • Slots are 'left' | 'center' | 'right'; built-in slots render first.
//   • Within a slot, lower `priority` renders first.
//   • Tie-break is stable: registration order preserved at equal priority.
//   • register() returns a deregister function; calling it removes the slot.

import { type ReactNode, useEffect, useState } from "react";
import { Icons } from "@/ui/icons";

export interface StatusBarItem {
  id: string;
  slot: "left" | "center" | "right";
  priority: number;
  render: () => ReactNode;
}

interface RegisteredItem extends StatusBarItem {
  /** Monotonic insertion counter — backs the stable-on-tie ordering. */
  seq: number;
}

const items = new Map<string, RegisteredItem>();
const listeners = new Set<() => void>();
let seqCounter = 0;

export function registerStatusBarItem(item: StatusBarItem): () => void {
  seqCounter += 1;
  items.set(item.id, { ...item, seq: seqCounter });
  for (const fn of listeners) fn();
  return () => {
    items.delete(item.id);
    for (const fn of listeners) fn();
  };
}

function listItems(slot: StatusBarItem["slot"]): RegisteredItem[] {
  return [...items.values()]
    .filter((i) => i.slot === slot)
    .sort((a, b) => a.priority - b.priority || a.seq - b.seq);
}

export interface StatusBarProps {
  /** "SF Municipal Code v2026.04" — the C13 / status canary slot. */
  rootLabel: string;
  jurisdictionVersion: string;
  /** Number of code modules indexed (e.g. 18). */
  codeCount: number;
}

export function StatusBar({ rootLabel, jurisdictionVersion, codeCount }: StatusBarProps) {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <div className="lc-statusbar" role="status" aria-label="Status bar">
      <span className="lc-sb-item">
        <span className="lc-sb-dot lc-green" aria-hidden />
        {rootLabel} v{jurisdictionVersion}
      </span>
      <span className="lc-sb-item">
        <Icons.Book size={11} />
        {codeCount} codes indexed
      </span>
      {listItems("left").map((item) => (
        <span key={item.id} className="lc-sb-item">
          {item.render()}
        </span>
      ))}
      <span className="lc-sb-sep" />
      {listItems("center").map((item) => (
        <span key={item.id} className="lc-sb-item">
          {item.render()}
        </span>
      ))}
      <span className="lc-sb-item" style={{ color: "var(--overlay1)" }}>
        <Icons.Command size={10} />
        ⌘P for sections
      </span>
      {listItems("right").map((item) => (
        <span key={item.id} className="lc-sb-item">
          {item.render()}
        </span>
      ))}
    </div>
  );
}
