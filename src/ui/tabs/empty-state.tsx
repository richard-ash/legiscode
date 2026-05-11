// Tab strip empty state — rendered inside `.lc-center` when the user has
// closed every tab (or cold-started with a persisted-empty list per A7).
// Quiet document-register cue — Source Serif 4 title, sans-serif hint,
// `.lc-kbd` keycap for ⌘P. No fake content, no "coming soon" copy.

import type { ReactNode } from "react";

export function TabEmptyState(): ReactNode {
  return (
    <div className="lc-empty">
      <div className="lc-empty-title">No section open</div>
      <div className="lc-empty-hint">
        Open a section from the file tree, or press <kbd className="lc-kbd">⌘P</kbd> to search
      </div>
    </div>
  );
}
