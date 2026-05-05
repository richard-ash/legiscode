// Last-opened section persistence. Phase 1 stores a `(moduleId, sectionId)`
// pair in localStorage so subsequent launches restore the last view. Migrates
// to SQLite via `feat/sqlite-state` in Phase 6 — keeping the API tiny here
// makes that swap a one-file change.

const STORAGE_KEY = "legiscode.activeSection";

export interface ActiveRef {
  moduleId: string;
  sectionId: string;
}

export function readActiveSection(): ActiveRef | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveRef>;
    if (typeof parsed.moduleId === "string" && typeof parsed.sectionId === "string") {
      return { moduleId: parsed.moduleId, sectionId: parsed.sectionId };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeActiveSection(ref: ActiveRef): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ref));
  } catch {
    // localStorage unavailable — restoration silently degrades to default.
  }
}
