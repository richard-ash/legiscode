// Theme state. Dark default per C7. Light is opt-in only via the Settings
// dropdown — `prefers-color-scheme` is deliberately ignored. Mutations swap
// a single class on <html> (P1) so the next paint hits the correct token
// set without an inline-style rewrite.
//
// Persistence is localStorage; feat/sqlite-state migrates to SQLite later.
// The synchronous read in src/index.html applies the class before React
// mounts, so this module only needs to publish the toggle and emit
// subscribers; it never has to fight an FOUC.

const STORAGE_KEY = "legiscode.theme";
const LIGHT_CLASS = "lc-light";

export type Theme = "dark" | "light";

type Listener = (theme: Theme) => void;
const listeners = new Set<Listener>();

export function getTheme(): Theme {
  return document.documentElement.classList.contains(LIGHT_CLASS) ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  if (theme === "light") {
    document.documentElement.classList.add(LIGHT_CLASS);
  } else {
    document.documentElement.classList.remove(LIGHT_CLASS);
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Quota / private-mode failure: theme stays in-memory only this session.
  }
  for (const fn of listeners) fn(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
