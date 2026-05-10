// Section body line-height multiplier — applied as the
// `--section-line-height-mult` CSS variable on <html>. The renderer's
// section-view.css reads it as `line-height: calc(1.75 * var(...))`
// so the swap happens in CSS without re-rendering React.
//
// Default is "1" (natural 1.75 line-height unmultiplied). The Settings
// dropdown's toggle flips between "1" and "1.7"; the latter yields ~3.0
// effective line-height for accessibility-tuned readers.
//
// No FOUC bootstrap (vs theme.ts): the multiplier only affects the
// section body, which doesn't render until corpus:read returns. The
// brief delay between page load and first apply is invisible.

import { type LineHeightMult, readLineHeightMult, writeLineHeightMult } from "@/persistence";

const CSS_VAR = "--section-line-height-mult";
const DEFAULT: LineHeightMult = "1";

type Listener = (mult: LineHeightMult) => void;
const listeners = new Set<Listener>();

export type { LineHeightMult };

export function getLineHeightMult(): LineHeightMult {
  if (typeof document === "undefined") return DEFAULT;
  const current = document.documentElement.style.getPropertyValue(CSS_VAR).trim();
  if (current === "1" || current === "1.7") return current;
  return readLineHeightMult() ?? DEFAULT;
}

export function setLineHeightMult(mult: LineHeightMult): void {
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty(CSS_VAR, mult);
  }
  writeLineHeightMult(mult);
  for (const fn of listeners) fn(mult);
}

/**
 * Apply the persisted multiplier to <html> on cold start. Idempotent —
 * safe to call from a React effect without guarding. App.tsx invokes
 * this once on mount.
 */
export function applyPersistedLineHeightMult(): void {
  const persisted = readLineHeightMult() ?? DEFAULT;
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty(CSS_VAR, persisted);
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
