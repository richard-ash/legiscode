// Command palette — section finder (A22, ported from chrome.jsx
// `CommandPalette`). Phase 1 ships only section navigation; feat/command-
// palette (Phase 3) layers commands on top via the `commandRegistry`
// primitive (added separately when that branch lands).
//
// Triggers: ⌘P globally (wired in App.tsx), workspace-chip click, ⌘K hint.
// Layout: scrim + centered modal at top 18% of viewport, 640px wide.
// Catppuccin tokens via .lc-palette-* classes.
//
// PERF DEBT (2026-05-06): the filter at `items` runs synchronously over
// the full flattened section list on every keystroke (~11,659 items at SF
// Municipal scale) and renders every match as a real DOM `<button>`. At
// scale this is ~100s of ms per keystroke. The fix — debounce + result
// cap + virtualized list + precomputed lowercase index — is intentionally
// deferred to `feat/command-palette` (branch #10, Phase 3). See TODOS.md
// "Command palette virtualization + debounce".

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { corpusRefFromWire } from "@/corpus/refs";
import type { CorpusModuleSummary, CorpusTreeNode } from "@/corpus/wire";
import { Icons } from "@/ui/icons";
import type { OpenItem } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  corpus: CorpusModuleSummary;
  /**
   * Tab-dispatch primitive. Picking a section fires
   * `navigate({kind:"section", ref}, "primary")` — the palette doesn't
   * support background opens today (no Cmd+Enter accelerator). The wire
   * shape on the internal `PaletteItem` is wrapped into the branded
   * `CorpusRef` at the navigate boundary.
   */
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
}

interface PaletteItem {
  moduleId: string;
  sectionId: string;
  num: string;
  name: string;
  /** Path label like "Port Code · ARTICLE 1" — derived from tree position. */
  path: string;
}

export function CommandPalette({ open, onClose, corpus, navigate }: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const sections = useMemo(() => flattenSections(corpus.tree), [corpus.tree]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const items = useMemo(() => {
    const norm = q.trim().toLowerCase();
    if (!norm) return sections;
    return sections.filter((s) => `${s.num} ${s.name} ${s.path}`.toLowerCase().includes(norm));
  }, [q, sections]);

  // Reset selection on every search-string change. Biome's exhaustive-deps
  // wants the effect body to reference q if it's in deps; we use deps as a
  // change-trigger here, which is valid React but trips the rule.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps as change-trigger, intentional
  useEffect(() => setSel(0), [q]);

  if (!open) return null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = items[sel];
      if (picked) {
        // PaletteItem already exposes the wire-shape fields the helper
        // expects — pass through directly so the grep gate sees no
        // ad-hoc `{ moduleId, sectionId }` literal at this boundary.
        navigate({ kind: "section", ref: corpusRefFromWire(picked) }, "primary");
      }
      onClose();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim closes on click; keyboard is handled at dialog level
    <div className="lc-palette-scrim" onMouseDown={onClose} role="presentation">
      <div
        className="lc-palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-modal="true"
        aria-label="Go to section"
      >
        <div className="lc-palette-inputrow">
          <span className="lc-palette-ico">
            <Icons.Search size={13} />
          </span>
          <input
            ref={inputRef}
            className="lc-palette-input"
            placeholder="Go to section… (§ number or keyword)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="lc-palette-kbd">⌘P</span>
        </div>
        <div className="lc-palette-list">
          {items.length === 0 ? (
            <div className="lc-palette-empty">No sections match "{q}"</div>
          ) : (
            items.map((s, i) => (
              <button
                type="button"
                key={`${s.moduleId}::${s.sectionId}`}
                className={`lc-palette-item ${i === sel ? "is-sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  navigate({ kind: "section", ref: corpusRefFromWire(s) }, "primary");
                  onClose();
                }}
              >
                <span className="lc-palette-glyph">§</span>
                <span className="lc-palette-num">{s.num}</span>
                <span className="lc-palette-name">{s.name}</span>
                <span className="lc-palette-meta">
                  <span className="lc-palette-path">{s.path}</span>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="lc-palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> go to
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

function flattenSections(tree: readonly CorpusTreeNode[]): PaletteItem[] {
  const out: PaletteItem[] = [];
  const walk = (node: CorpusTreeNode, path: string[]): void => {
    if (node.kind === "section" && node.ref) {
      out.push({
        moduleId: node.ref.moduleId,
        sectionId: node.ref.sectionId,
        num: node.code,
        name: node.name,
        path: path.join(" · "),
      });
      return;
    }
    const nextPath = [...path, node.code];
    for (const k of node.kids ?? []) walk(k, nextPath);
  };
  for (const n of tree) walk(n, []);
  return out;
}
