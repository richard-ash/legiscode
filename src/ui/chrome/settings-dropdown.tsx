// Phase-1 settings dropdown (D4). 200px wide, anchored to the titlebar
// gear icon. Single binary toggle "Theme: ◉ Dark / ○ Light" — no system
// option (C7 ignores `prefers-color-scheme`). Outside-click closes; theme
// preference persists via src/app/theme.ts.

import { useEffect, useRef, useState } from "react";
import { getTheme, setTheme, subscribe, type Theme } from "@/app/theme";

export interface SettingsDropdownProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDropdown({ open, onClose }: SettingsDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [theme, setLocalTheme] = useState<Theme>(() =>
    typeof document === "undefined" ? "dark" : getTheme(),
  );

  useEffect(() => subscribe(setLocalTheme), []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer attach so the click that opened the dropdown doesn't immediately close it.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div ref={ref} className="lc-settings-dropdown" role="menu" aria-label="Settings">
      <div className="lc-settings-row">
        <span
          style={{
            color: "var(--overlay1)",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          Theme
        </span>
      </div>
      <div className="lc-settings-row">
        <label>
          <input
            type="radio"
            name="legiscode-theme"
            checked={theme === "dark"}
            onChange={() => setTheme("dark")}
          />
          Dark
        </label>
        <label>
          <input
            type="radio"
            name="legiscode-theme"
            checked={theme === "light"}
            onChange={() => setTheme("light")}
          />
          Light
        </label>
      </div>
    </div>
  );
}
