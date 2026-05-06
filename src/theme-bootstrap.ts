// Apply persisted theme synchronously before React mounts to avoid FOUC.
// Loaded as <script type="module"> from index.html so prod CSP `script-src
// 'self'` covers it without needing 'unsafe-inline' or a per-build hash.
//
// main.ts gates mainWindow.show() on did-finish-load, which fires after all
// module scripts run, so the theme class is committed before the window
// becomes visible.
//
// Dark is the default; ignore prefers-color-scheme. Reads localStorage via
// try/catch so corrupted values fall back to the dark default transparently.
//
// LOCALSTORAGE CARVE-OUT: this is the ONE file in `src/` outside
// `src/persistence/storage.ts` that touches localStorage directly. The
// reason is FOUC avoidance — this script runs before `@/persistence` (and
// zod, and the rest of the renderer bundle) has been parsed. Running an
// async or import-heavy path here would defeat the purpose. The grep gate
// in `test/baseline.test.ts` exempts this exact file by name; do not
// extend the carve-out without revisiting that gate.
try {
  if (localStorage.getItem("legiscode.theme") === "light") {
    document.documentElement.classList.add("lc-light");
  }
} catch (_) {
  /* fall back to dark default */
}
