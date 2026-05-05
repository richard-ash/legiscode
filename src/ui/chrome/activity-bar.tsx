// Activity bar — vertical mode rail. Today the only mode whose backing
// system actually ships is `structure` (the corpus tree); search / diffs /
// ordinances / flags / history get added to ITEMS as their feature
// branches land. The rail intentionally does NOT advertise unbuilt modes:
// no placeholder icons, no fake badge counts, no "coming soon" copy.
//
// C14 wires keyboard nav: role=tablist + arrow keys + Enter to activate.
// Active state is aria-selected (canonical for role=tab; C14's earlier
// "aria-pressed" wording was from the toggle-button pattern, which
// doesn't compose with role=tab). C15 ensures every icon button has
// aria-label matching its title.
//
// `setBadge(iconId, count|null)` is exposed for downstream branches that
// own the data backing each badge — the API is registration-style, not
// default-data, so the rail starts with zero badges and only displays a
// count once real state has been published.

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { Icons, type IconProps } from "@/ui/icons";

export type ActivityMode = "structure";

export interface ActivityBarProps {
  active: ActivityMode;
  onChange: (mode: ActivityMode) => void;
}

interface ItemDef {
  id: ActivityMode;
  Icon: ComponentType<IconProps>;
  label: string;
}

const ITEMS: readonly ItemDef[] = [{ id: "structure", Icon: Icons.Tree, label: "Structure" }];

/**
 * Imperative API exposed to downstream branches that own the data backing
 * each badge. `null` clears the badge. The rail starts with no badges;
 * counts only appear once real state has been published via setBadge.
 */
export interface ActivityBarHandle {
  setBadge(id: ActivityMode, count: number | null): void;
}

export function ActivityBar({ active, onChange }: ActivityBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [badges, setBadges] = useState<Record<ActivityMode, number | null>>(() => {
    const initial: Partial<Record<ActivityMode, number | null>> = {};
    for (const it of ITEMS) initial[it.id] = null;
    return initial as Record<ActivityMode, number | null>;
  });

  // Expose setBadge on window for downstream branches (testing harness uses
  // the same hook). Once feat/ordinance-ingestion lands, replace with a
  // proper React context that emits per-id updates.
  useEffect(() => {
    const handle: ActivityBarHandle = {
      setBadge(id, count) {
        setBadges((prev) => ({ ...prev, [id]: count }));
      },
    };
    (window as unknown as { __legiscode_activityBar?: ActivityBarHandle }).__legiscode_activityBar =
      handle;
    return () => {
      delete (window as unknown as { __legiscode_activityBar?: ActivityBarHandle })
        .__legiscode_activityBar;
    };
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const idx = ITEMS.findIndex((it) => it.id === active);
      if (idx < 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = ITEMS[(idx + 1) % ITEMS.length];
        if (next) onChange(next.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = ITEMS[(idx - 1 + ITEMS.length) % ITEMS.length];
        if (next) onChange(next.id);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        // Re-activate active item (C3: same-icon → toggle in App-level wiring).
        onChange(active);
      }
    },
    [active, onChange],
  );

  return (
    <div
      ref={containerRef}
      className="lc-activitybar"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Workspace mode"
      onKeyDown={onKeyDown}
    >
      {ITEMS.map((it) => {
        const isActive = it.id === active;
        const badge = badges[it.id];
        return (
          <button
            type="button"
            key={it.id}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-label={it.label}
            title={it.label}
            className={`lc-act ${isActive ? "is-active" : ""}`}
            onClick={() => onChange(it.id)}
          >
            <it.Icon size={16} />
            {badge != null ? <span className="lc-badge">{badge}</span> : null}
          </button>
        );
      })}
      <div className="lc-spacer" />
      {/* A20: bottom Pin/Settings intentionally not rendered Phase 1. */}
    </div>
  );
}
