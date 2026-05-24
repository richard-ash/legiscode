// Tiny renderer-side platform detection. Used wherever we surface a
// platform-specific affordance to the user (e.g. "⌘-click" vs
// "Ctrl-click" in the citation popover footer). Detect once at module
// load — the renderer is single-platform for its lifetime.
//
// `navigator.platform` is deprecated but still works in Electron's
// Chromium; `userAgent` is the long-term replacement. Test both so the
// detection survives Electron upgrades.

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
const platform = typeof navigator === "undefined" ? "" : navigator.platform;

export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(ua);

/** User-visible label for the primary keyboard modifier — "⌘" on macOS,
 *  "Ctrl" elsewhere. Use in strings the user reads ("⌘-click to open"),
 *  not in code that branches on the actual key event (those already
 *  read `metaKey || ctrlKey`). */
export const MOD_KEY_LABEL: "⌘" | "Ctrl" = IS_MAC ? "⌘" : "Ctrl";
