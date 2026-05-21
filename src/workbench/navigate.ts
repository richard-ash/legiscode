// Navigation intent. The seam between the citation dispatcher and the
// tab manager is a tiny pure value — the React hook in
// `src/ui/use-navigation.ts` owns the actual openItems state and the
// keyboard wiring; this file just names the intent shape.
//
// Per-tab history was removed in feat/citation-resolution (2026-05-20)
// in favor of the VS Code tab model: ⌘-click opens a new foreground tab,
// ⌘⌥← / ⌘⌥→ switches the active tab. History inside a tab is no longer
// a thing — to revisit a section you bring its tab forward.

export type NavigationIntent = "primary" | "background";
