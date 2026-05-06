// Theme state. Dark default per C7. Light is opt-in only via the Settings
// dropdown — `prefers-color-scheme` is deliberately ignored. Mutations swap
// a single class on <html> (P1) so the next paint hits the correct token
// set without an inline-style rewrite.
//
// Persistence is delegated to `@/persistence` (Layer 1 — feat/file-tree).
// The synchronous FOUC-avoidance read in `src/theme-bootstrap.ts` is the
// one documented carve-out that still touches localStorage directly; see
// that file's header for why.

import { type Theme, writeTheme } from "@/persistence";

const LIGHT_CLASS = "lc-light";

export type { Theme };

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
  writeTheme(theme);
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
