// Read-only Settings surface. v1.0 ships one section — the keyboard
// shortcut reference — rendered straight from the catalog so it can never
// fall out of sync with the keys the handlers fire on. No edit controls;
// rebinding is v1.1 (`feat/shortcut-rebinding`), which reuses the same
// catalog as its data model.
//
// Layout: a search box plus two top-level groups (Commands vs In-view
// navigation) so widget arrow-nav doesn't drown the real shortcuts.
// Within each group, rows are sub-grouped by scope. The nine ⌘1–⌘9
// jump entries collapse into a single row. Pixel-level IA is a
// /plan-design-review follow-up.

import { type ReactNode, useDeferredValue, useId, useMemo, useState } from "react";
import {
  formatBinding,
  formatShortcut,
  GROUP_LABELS,
  SCOPE_LABELS,
  SHORTCUTS,
  type Shortcut,
  type ShortcutGroup,
  type ShortcutScope,
} from "@/ui/shortcuts/registry";
import type { SettingsPane } from "@/workbench/open-items";

export interface SettingsPageProps {
  section: SettingsPane;
  /** ARIA tabpanel wiring from the tab dispatcher, mirroring SectionView. */
  tabPanel?: { id: string; labelledBy: string };
}

const GROUP_ORDER: readonly ShortcutGroup[] = ["commands", "in-view"];
const SCOPE_ORDER: readonly ShortcutScope[] = [
  "global",
  "tabs",
  "palette",
  "file-tree",
  "section-view",
  "activity-bar",
];

const JUMP_ID = /^tabs\.jump-to-\d$/;

interface DisplayRow {
  readonly id: string;
  readonly label: string;
  readonly binding: string;
}

function matchesQuery(s: Shortcut, needle: string): boolean {
  if (!needle) return true;
  if (s.label.toLowerCase().includes(needle)) return true;
  if (s.keywords.some((k) => k.toLowerCase().includes(needle))) return true;
  return formatBinding(s.display).toLowerCase().includes(needle);
}

/** Collapse the ⌘1–⌘9 family into one row; pass everything else through. */
function toDisplayRows(shortcuts: readonly Shortcut[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let jumpAdded = false;
  for (const s of shortcuts) {
    if (JUMP_ID.test(s.id)) {
      if (!jumpAdded) {
        rows.push({
          id: "tabs.jump-to",
          label: "Jump to tab 1–9",
          binding: `${formatShortcut("tabs.jump-to-1")}–${formatShortcut("tabs.jump-to-9")}`,
        });
        jumpAdded = true;
      }
      continue;
    }
    rows.push({ id: s.id, label: s.label, binding: formatBinding(s.display) });
  }
  return rows;
}

interface ScopeBlock {
  readonly scope: ShortcutScope;
  readonly rows: readonly DisplayRow[];
}

interface GroupBlock {
  readonly group: ShortcutGroup;
  readonly scopes: readonly ScopeBlock[];
}

function buildGroups(needle: string): GroupBlock[] {
  const out: GroupBlock[] = [];
  for (const group of GROUP_ORDER) {
    const scopes: ScopeBlock[] = [];
    for (const scope of SCOPE_ORDER) {
      const matched = SHORTCUTS.filter(
        (s) => s.group === group && s.scope === scope && matchesQuery(s, needle),
      );
      if (matched.length === 0) continue;
      scopes.push({ scope, rows: toDisplayRows(matched) });
    }
    if (scopes.length > 0) out.push({ group, scopes });
  }
  return out;
}

export function SettingsPage({ section, tabPanel }: SettingsPageProps): ReactNode {
  const [query, setQuery] = useState("");
  // Defer the filter pass off the keystroke, same pattern as the palette.
  const deferredQuery = useDeferredValue(query);
  const searchId = useId();
  const groups = useMemo(() => buildGroups(deferredQuery.trim().toLowerCase()), [deferredQuery]);

  // Forward-compat: section is "shortcuts" today; future sections branch here.
  if (section !== "shortcuts") return null;

  const empty = groups.length === 0;
  // Spread the ARIA wiring (mirrors SectionView) so role=tabpanel +
  // aria-labelledby travel together and the static a11y lint sees a
  // consistent role/attr pair.
  const tabPanelAttrs = tabPanel
    ? { role: "tabpanel" as const, id: tabPanel.id, "aria-labelledby": tabPanel.labelledBy }
    : {};

  return (
    <div {...tabPanelAttrs} className="lc-settings-page">
      <div className="lc-settings-head">
        <h1 className="lc-settings-title">Keyboard Shortcuts</h1>
        <input
          id={searchId}
          type="search"
          className="lc-settings-search"
          placeholder="Filter shortcuts…"
          aria-label="Filter keyboard shortcuts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {empty ? (
        <div className="lc-settings-empty">No shortcuts match “{query}”</div>
      ) : (
        groups.map((g) => (
          <section key={g.group} className="lc-settings-group">
            <h2 className="lc-settings-group-title">{GROUP_LABELS[g.group]}</h2>
            {g.scopes.map((block) => (
              <section
                key={block.scope}
                className="lc-settings-scope"
                aria-label={SCOPE_LABELS[block.scope]}
              >
                <h3 className="lc-settings-scope-title">{SCOPE_LABELS[block.scope]}</h3>
                <ul className="lc-settings-entries">
                  {block.rows.map((row) => (
                    <li key={row.id} className="lc-settings-entry">
                      <span className="lc-settings-entry-label">{row.label}</span>
                      <kbd className="lc-kbd lc-settings-kbd">{row.binding}</kbd>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
