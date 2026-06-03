// Custom titlebar. Brand mark on the left, workspace chip in the
// centre (⌘P entry), settings dropdown on the right. The sync
// indicator, Bell, and Share affordances are intentionally hidden
// until their backing systems ship. macOS draws OS traffic lights
// through `titleBarStyle: 'hiddenInset'`; CSS leaves padding for
// them. Windows 11+ uses `titleBarOverlay` for window controls.

import { useState } from "react";
import { SettingsDropdown } from "@/ui/chrome/settings-dropdown";
import { Icons } from "@/ui/icons";
import { formatShortcut } from "@/ui/shortcuts/registry";

export interface TitleBarProps {
  /** Display label inside the workspace chip — e.g. "SF Municipal Code". */
  workspaceLabel: string;
  /** Right-hand fragment in the chip — currently the active section line. */
  fileLabel: string;
  /** Open the section-finder palette (⌘P). */
  onOpenPalette: () => void;
  /** Open the Settings → Keyboard Shortcuts tab (⌘,). */
  onOpenShortcuts: () => void;
}

export function TitleBar({
  workspaceLabel,
  fileLabel,
  onOpenPalette,
  onOpenShortcuts,
}: TitleBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const paletteKey = formatShortcut("global.open-palette");

  return (
    <div className="lc-titlebar" data-testid="titlebar">
      <div className="lc-brand">
        <BrandMark />
        <span className="lc-brand-name">
          <b>LegisCode</b>
        </span>
      </div>
      <div className="lc-titlebar-center">
        <button
          type="button"
          className="lc-workspace-chip"
          onClick={onOpenPalette}
          title={`Go to section… (${paletteKey})`}
          aria-label={`Open section finder (${paletteKey})`}
        >
          <span className="lc-dot" aria-hidden />
          <span data-testid="workspace-label">{workspaceLabel}</span>
          <span style={{ opacity: 0.5, margin: "0 2px" }}>/</span>
          <span style={{ color: "var(--overlay1)" }}>{fileLabel}</span>
          <span className="lc-chip-kbd">{paletteKey}</span>
        </button>
      </div>
      <div className="lc-titlebar-right">
        <div className="lc-settings-anchor">
          <button
            type="button"
            className="lc-icon-btn"
            title="Settings"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            aria-haspopup="menu"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Icons.Settings size={14} />
          </button>
          <SettingsDropdown
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onOpenShortcuts={onOpenShortcuts}
          />
        </div>
      </div>
    </div>
  );
}

function BrandMark() {
  return (
    <span className="lc-brand-mark" aria-hidden>
      <svg
        width={16}
        height={16}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        role="presentation"
        aria-hidden
      >
        <path d="M8 1.5v13M3.5 4h9M4.5 4 2 9h5zM11.5 4 9 9h5z" />
        <path d="M2 9a2.5 2 0 0 0 5 0M9 9a2.5 2 0 0 0 5 0" fill="none" />
        <path d="M4 14.5h8" />
      </svg>
    </span>
  );
}
