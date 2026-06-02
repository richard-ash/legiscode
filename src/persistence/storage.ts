// Layer 1 — the only sanctioned localStorage call site in `src/` (with a
// documented carve-out for `src/theme-bootstrap.ts`, which has to read the
// theme synchronously before React mounts to avoid FOUC). Every other
// renderer-side persistence concern reaches through this module.
//
// Failure modes are silent-or-logged on purpose:
//   • localStorage missing (jsdom without storage, private mode) → reads
//     return null, writes no-op.
//   • corrupt JSON / schema mismatch → log + null. The caller's fallback
//     state takes over (e.g. workbench falls back to corpus.defaultRef).
//   • quota exceeded → swallow. The change stays in-memory for the
//     session; the next launch reverts to whatever was last persisted.
//
// A future SQLite-backed implementation can replace this file without
// changing the exported surface — that's the contract this module makes
// to its callers (persistence operations are a thin async-able interface
// even though localStorage is sync today).
//
// Key namespace:
//   legiscode.theme                — Theme primitive ("dark" | "light")
//   legiscode.openItems            — workbench OpenItems[] + activeIndex
//   legiscode.activeSection        — legacy single-ref (read-once + delete on migrate)
//   legiscode.section.lineHeightMult — section body line-height multiplier ("1" | "1.7")
//   legiscode.activityPane            — activity-pane splitter state ({height, collapsed})

import { z } from "zod";

const NAMESPACE = "legiscode";
const KEY_THEME = `${NAMESPACE}.theme`;
const KEY_OPEN_ITEMS = `${NAMESPACE}.openItems`;
const KEY_LEGACY_ACTIVE_SECTION = `${NAMESPACE}.activeSection`;
const KEY_LINE_HEIGHT_MULT = `${NAMESPACE}.section.lineHeightMult`;
const KEY_ACTIVITY_PANE = `${NAMESPACE}.activityPane`;

// ─── Schemas ────────────────────────────────────────────────────────────────

export const ThemeSchema = z.union([z.literal("dark"), z.literal("light")]);
export type Theme = z.infer<typeof ThemeSchema>;

const PersistedRefSchema = z.object({
  module: z.string().min(1),
  section: z.string().min(1),
});

const PersistedSectionItemSchema = z.object({
  kind: z.literal("section"),
  ref: PersistedRefSchema,
});

const PersistedSettingsItemSchema = z.object({
  kind: z.literal("settings"),
  section: z.literal("shortcuts"),
});

const PersistedBillItemSchema = z.object({
  kind: z.literal("bill"),
  billId: z.string().min(1),
});

// The `kind` discriminator lets future tab kinds (chat) plug in
// additively, and lets legacy stored payloads carrying a removed kind
// drop cleanly on read. Settings tabs persist so a reopened app keeps
// the surface open (App applies a cold-start guard so it never restores
// as the active tab). Bill tabs persist by content key; rows whose
// underlying bill aged out of the pending set drop at hydrate-time via
// `fromPersisted(_, isKnownBill)`.
const PersistedOpenItemSchema = z.discriminatedUnion("kind", [
  PersistedSectionItemSchema,
  PersistedSettingsItemSchema,
  PersistedBillItemSchema,
]);

// Strict per-item items array — the post-drop, post-remap shape that
// callers consume. Tolerant per-item parsing happens in
// parseOpenItemsJson, which drops unknown / malformed items individually
// AND remaps activeIndex through the survivor map so the user's active
// tab is preserved across schema drift instead of getting stranded on
// an index that no longer points anywhere.
export const PersistedOpenItemsSchema = z.object({
  items: z.array(PersistedOpenItemSchema),
  activeIndex: z.number().int().nullable(),
});
export type PersistedOpenItems = z.infer<typeof PersistedOpenItemsSchema>;
export type PersistedOpenItem = z.infer<typeof PersistedOpenItemSchema>;

const LegacyActiveSectionSchema = z.object({
  moduleId: z.string().min(1),
  sectionId: z.string().min(1),
});

// ─── Backend access ─────────────────────────────────────────────────────────

/**
 * Return the underlying `Storage` if available, else `undefined`. The
 * raw backend is exposed for `react-resizable-panels`' `useDefaultLayout`,
 * which manages opaque keys we don't own — the centralization rule still
 * holds because every localStorage reference in `src/` originates here.
 */
export function getStorageBackend(): Storage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage ?? undefined;
  } catch {
    // SecurityError when third-party storage is blocked.
    return undefined;
  }
}

/** Test seam — returns the legiscode-prefixed keys present in storage. */
export function listOwnedKeys(): readonly string[] {
  const backend = getStorageBackend();
  if (!backend) return [];
  const out: string[] = [];
  for (let i = 0; i < backend.length; i++) {
    const k = backend.key(i);
    if (k?.startsWith(`${NAMESPACE}.`)) out.push(k);
  }
  return out;
}

// ─── Theme ──────────────────────────────────────────────────────────────────

/** Returns `null` when nothing is persisted or the value is unrecognized. */
export function readTheme(): Theme | null {
  const backend = getStorageBackend();
  if (!backend) return null;
  let raw: string | null;
  try {
    raw = backend.getItem(KEY_THEME);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parsed = ThemeSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[persistence] discarding unrecognized theme value: ${JSON.stringify(raw)}`);
    return null;
  }
  return parsed.data;
}

export function writeTheme(value: Theme): void {
  const backend = getStorageBackend();
  if (!backend) return;
  try {
    backend.setItem(KEY_THEME, value);
  } catch {
    // Quota / private-mode failure: theme stays in-memory only this session.
  }
}

// ─── Section line-height multiplier ─────────────────────────────────────────
//
// "1" = use the body's natural 1.75 line-height unmultiplied. "1.7" =
// accessibility option that multiplies to ~3.0 effective. The renderer's
// CSS reads this as a CSS variable on <html>; persistence here is the
// localStorage source of truth that the Settings dropdown writes through.
// Naming caveat (codex C11): the toggle is a *multiplier*, not the
// line-height value itself — comment in section-view.css mirrors this so
// future readers don't conflate "1.0" with the absolute 1.75.

export const LineHeightMultSchema = z.union([z.literal("1"), z.literal("1.7")]);
export type LineHeightMult = z.infer<typeof LineHeightMultSchema>;

export function readLineHeightMult(): LineHeightMult | null {
  const backend = getStorageBackend();
  if (!backend) return null;
  let raw: string | null;
  try {
    raw = backend.getItem(KEY_LINE_HEIGHT_MULT);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parsed = LineHeightMultSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      `[persistence] discarding unrecognized lineHeightMult value: ${JSON.stringify(raw)}`,
    );
    return null;
  }
  return parsed.data;
}

export function writeLineHeightMult(value: LineHeightMult): void {
  const backend = getStorageBackend();
  if (!backend) return;
  try {
    backend.setItem(KEY_LINE_HEIGHT_MULT, value);
  } catch {
    // Quota / private-mode failure: stays in-memory for this session.
  }
}

// ─── Activity-pane splitter state ───────────────────────────────────────────
//
// The left panel splits between the corpus file tree (top) and the
// pending-bills activity panel (bottom). `height` is the activity pane's
// share of the left panel as a fraction in [0.2, 0.8] — clamped so neither
// pane can fully starve the other while still leaving room for the future
// collapse affordance. `collapsed` snaps the activity pane to its 34px
// header; expand returns to the last persisted `height`.

export const ActivityPaneStateSchema = z.object({
  height: z.number().min(0.2).max(0.8),
  collapsed: z.boolean(),
});
export type ActivityPaneState = z.infer<typeof ActivityPaneStateSchema>;

export function readActivityPaneState(): ActivityPaneState | null {
  const backend = getStorageBackend();
  if (!backend) return null;
  const raw = safeGetItem(backend, KEY_ACTIVITY_PANE);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.warn("[persistence] discarding corrupt activityPane JSON");
    return null;
  }
  const parsed = ActivityPaneStateSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(
      `[persistence] discarding unrecognized activityPane value: ${JSON.stringify(json)}`,
    );
    return null;
  }
  return parsed.data;
}

export function writeActivityPaneState(value: ActivityPaneState): void {
  const backend = getStorageBackend();
  if (!backend) return;
  try {
    backend.setItem(KEY_ACTIVITY_PANE, JSON.stringify(value));
  } catch {
    // Quota / private-mode failure: stays in-memory for this session.
  }
}

// ─── OpenItems ──────────────────────────────────────────────────────────────

/**
 * Read the workbench OpenItems state. On first launch after upgrade,
 * migrates the legacy `legiscode.activeSection` single-ref shape into a
 * one-element openItems array using a read-old / write-new / delete-old
 * sequence. Schema mismatches log and return null so the caller falls back
 * to the empty state rather than crashing.
 */
export function readOpenItems(): PersistedOpenItems | null {
  const backend = getStorageBackend();
  if (!backend) return null;

  const raw = safeGetItem(backend, KEY_OPEN_ITEMS);
  if (raw !== null) {
    const parsed = parseOpenItemsJson(raw);
    if (parsed) return parsed;
    // Corrupt or schema-mismatched value — fall through to migration / null.
  }

  const migrated = tryMigrateLegacyActiveSection(backend);
  return migrated;
}

export function writeOpenItems(value: PersistedOpenItems): void {
  const backend = getStorageBackend();
  if (!backend) return;
  try {
    backend.setItem(KEY_OPEN_ITEMS, JSON.stringify(value));
  } catch {
    // Quota exceeded — silent.
  }
}

export function removeOpenItems(): void {
  const backend = getStorageBackend();
  if (!backend) return;
  try {
    backend.removeItem(KEY_OPEN_ITEMS);
  } catch {
    // Storage refused removal — nothing to do.
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

function safeGetItem(backend: Storage, key: string): string | null {
  try {
    return backend.getItem(key);
  } catch {
    return null;
  }
}

function parseOpenItemsJson(raw: string): PersistedOpenItems | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.warn(`[persistence] discarding corrupt openItems JSON`);
    return null;
  }
  // Validate the envelope (top-level shape) but keep items as raw unknowns
  // so the per-item tolerant drop can run below.
  const envelope = z
    .object({
      items: z.array(z.unknown()),
      activeIndex: z.number().int().nullable(),
    })
    .safeParse(json);
  if (!envelope.success) {
    console.warn(
      `[persistence] discarding openItems with schema mismatch: ${envelope.error.message}`,
    );
    return null;
  }

  // Drop unparseable items individually (future-kind entries, single
  // corrupt rows) AND track each survivor's original index so the active
  // tab can be remapped. Without the remap, dropping any item before the
  // active tab leaves activeIndex pointing past the end of the surviving
  // list, and fromPersisted opens the session with tabs present but no
  // active tab — the failure mode this layer's per-item tolerance was
  // supposed to prevent.
  const survivingItems: PersistedOpenItem[] = [];
  const survivingOriginalIndices: number[] = [];
  for (let i = 0; i < envelope.data.items.length; i++) {
    const parsed = PersistedOpenItemSchema.safeParse(envelope.data.items[i]);
    if (parsed.success) {
      survivingItems.push(parsed.data);
      survivingOriginalIndices.push(i);
    }
  }

  // Remap activeIndex through the survivor map. Exact-hit wins; if the
  // original active was itself dropped, fall back to the nearest surviving
  // item at-or-before the original (preserves "the active tab was about
  // here" semantics); if no items survive, null.
  let remappedActive: number | null = null;
  const origActive = envelope.data.activeIndex;
  if (origActive !== null && survivingItems.length > 0) {
    const exact = survivingOriginalIndices.indexOf(origActive);
    if (exact >= 0) {
      remappedActive = exact;
    } else {
      let best = 0;
      for (let i = 0; i < survivingOriginalIndices.length; i++) {
        const orig = survivingOriginalIndices[i];
        if (orig !== undefined && orig <= origActive) best = i;
        else break;
      }
      remappedActive = best;
    }
  }

  return { items: survivingItems, activeIndex: remappedActive };
}

function tryMigrateLegacyActiveSection(backend: Storage): PersistedOpenItems | null {
  const raw = safeGetItem(backend, KEY_LEGACY_ACTIVE_SECTION);
  if (raw === null) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Legacy value is corrupt — skip migration silently. Removing the
    // corrupt key would mask user data; leave it in place for an
    // operator to inspect.
    return null;
  }

  const legacy = LegacyActiveSectionSchema.safeParse(json);
  if (!legacy.success) return null;

  const migrated: PersistedOpenItems = {
    items: [
      {
        kind: "section",
        ref: { module: legacy.data.moduleId, section: legacy.data.sectionId },
      },
    ],
    activeIndex: 0,
  };

  try {
    backend.setItem(KEY_OPEN_ITEMS, JSON.stringify(migrated));
    backend.removeItem(KEY_LEGACY_ACTIVE_SECTION);
  } catch {
    // Quota / private-mode — return the migrated shape anyway so the
    // current session reflects the user's last state, even if the new
    // key didn't get persisted.
  }

  return migrated;
}
