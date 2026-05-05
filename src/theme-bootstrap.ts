// Apply persisted theme synchronously before React mounts to avoid FOUC (P1).
// Loaded as <script type="module"> from index.html so prod CSP `script-src
// 'self'` covers it without needing 'unsafe-inline' or a per-build hash.
//
// main.ts gates mainWindow.show() on did-finish-load, which fires after all
// module scripts run, so the theme class is committed before the window
// becomes visible.
//
// Dark is the default (C7); ignore prefers-color-scheme. Reads localStorage
// via try/catch so corrupted values fall back to the dark default transparently.
try {
  if (localStorage.getItem("legiscode.theme") === "light") {
    document.documentElement.classList.add("lc-light");
  }
} catch (_) {
  /* fall back to dark default */
}
