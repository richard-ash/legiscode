// Navigation intent. The seam between the citation dispatcher and the
// tab manager is a tiny pure value — the React hook in
// `src/ui/use-navigation.ts` owns the actual openItems state and the
// keyboard wiring; this file just names the intent shape.
//
// VS Code tab model: ⌘-click opens a new foreground tab; ⌘⌥← / ⌘⌥→
// switches the active tab. There is no per-tab history — to revisit
// a section you bring its tab forward.

export type NavigationIntent = "primary" | "background";
