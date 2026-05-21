// Command palette presentation. Replaces the 184-LOC placeholder
// previously at `src/ui/chrome/command-palette.tsx` (a per-keystroke
// scan + render-every-match that locked the UI at ~11k sections). The
// new split:
//
//   - `useCommandPalette` (hook) owns state + ranking. Pure logic;
//     testable via renderHook without DOM.
//   - `score.ts`            owns the field-weighted scorer. Pure;
//     testable in isolation.
//   - `command-palette.tsx` (this file) is the presentational shell:
//     keyboard / mouse / scrim, @tanstack/react-virtual over ranked
//     results, a11y wiring, mode-aware empty-state copy.
//
// What's new vs the placeholder, beyond the rank-quality fix (U1):
//   - virt over ranked results, soft-cap header "Showing top 50 of M"
//   - ⌘+Enter background-tab open with selection advance (U4 / F8)
//   - aria-activedescendant + stable row ids + scrollToIndex on selection
//   - Home / End / PageUp / PageDown keyboard nav (Codex F10)
//   - focus restore on close (Codex F10)
//   - `:def` subtype filter with mode-aware empty-state copy (D5, C5)
//   - input maxLength=200 against the very-long-query lag failure mode

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { corpusRefFromWire } from "@/corpus/refs";
import { Icons } from "@/ui/icons";
import type { OpenItem } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";
import type { SearchableItem } from "./score";
import type { UseCommandPaletteResult } from "./use-command-palette";

/** Uniform row height (mirrors `.lc-palette-item` in globals.css). */
const ROW_HEIGHT_PX = 32;
/** Soft-cap header threshold — UX, not perf. */
const SOFT_CAP = 50;
/** Long-query input cap — defends against the "user pastes 10kB" lag
 *  failure mode without taking discretion from typical use. */
const INPUT_MAX_LENGTH = 200;
/** Above this row count we render via virtualizer; at or below we
 *  render every row directly. The threshold is a JSDOM guard, not a
 *  perf gate — jsdom reports zero layout, so the virtualized branch
 *  measures 0 rows visible and tests can't see them. Real corpora
 *  (~11k sections) always cross this; test fixtures stay below. */
const JSDOM_GUARD_ROW_COUNT = 100;

export interface CommandPaletteProps {
  palette: UseCommandPaletteResult;
  /** Tab-dispatch primitive. Enter fires `navigate(item, "primary")`
   *  and closes; ⌘+Enter fires `navigate(item, "background")` and
   *  advances selection while staying open. */
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
}

export function CommandPalette({ palette, navigate }: CommandPaletteProps) {
  const { open, q, mode, results, isStale, setQ, close } = palette;
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<Element | null>(null);
  const listboxId = useId();
  const [selectedIndexRaw, setSelectedIndex] = useState(0);
  // Clamp at render so a results-shrink can never expose a stale index
  // through `aria-activedescendant`. The post-render `useEffect` below
  // re-syncs state for the next interaction, but THIS render must point
  // at a row that actually exists.
  const selectedIndex = results.length === 0 ? 0 : Math.min(selectedIndexRaw, results.length - 1);

  // Capture the previously-focused element when the palette opens so
  // Esc / scrim close can restore focus (Codex F10). Also moves input
  // focus on open via rAF so the autofocus survives the scrim mount.
  useEffect(() => {
    if (!open) return;
    previousActiveElementRef.current = document.activeElement;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Re-sync the persisted state when results shrink, so the next
  // interaction starts from the clamped value (not the stale raw one).
  // The render itself already uses `selectedIndex`, the clamped value
  // — this effect just keeps state honest for follow-up handlers.
  useEffect(() => {
    if (selectedIndexRaw >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, selectedIndexRaw]);

  // Reset selection to top on q change. Biome's exhaustive-deps would
  // ask us to depend on `q` and reference it in the effect body; deps
  // are a deliberate change-trigger here (C6 — pattern preserved).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps-as-change-trigger, intentional
  useEffect(() => setSelectedIndex(0), [q]);

  // Virtualizer over `results`. Below the JSDOM guard we skip the
  // virtualized branch entirely so tests (which run under jsdom and
  // see zero layout) can still find rendered rows.
  const useVirt = results.length > JSDOM_GUARD_ROW_COUNT;
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
    getItemKey: (i) => rowKey(results[i], i),
  });

  // Keep the selected row in view as the user arrows / pages through
  // a long result list (Codex F10). useLayoutEffect so the scroll
  // adjustment lands before paint. `virtualizer` is intentionally
  // excluded from deps — the hook returns a fresh instance every
  // render, so including it would re-fire scrollToIndex on every
  // render rather than on actual selection changes. We read the live
  // instance via the ref carried inside `virtualizer` at call time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer instance changes per render; we want selection-driven scrolls only
  useLayoutEffect(() => {
    if (!useVirt) return;
    if (results.length === 0) return;
    virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, useVirt, results.length]);

  const onClose = useCallback(() => {
    close();
    const prev = previousActiveElementRef.current;
    if (prev instanceof HTMLElement) prev.focus();
  }, [close]);

  const handlePick = useCallback(
    (item: SearchableItem, intent: NavigationIntent) => {
      const openItem = toOpenItem(item);
      if (!openItem) return;
      navigate(openItem, intent);
    },
    [navigate],
  );

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const visibleWindow = visiblePageSize(scrollRef.current);
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((s) => Math.min(results.length - 1, s + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((s) => Math.max(0, s - 1));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setSelectedIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setSelectedIndex(Math.max(0, results.length - 1));
        return;
      }
      if (e.key === "PageDown") {
        e.preventDefault();
        setSelectedIndex((s) => Math.min(results.length - 1, s + visibleWindow));
        return;
      }
      if (e.key === "PageUp") {
        e.preventDefault();
        setSelectedIndex((s) => Math.max(0, s - visibleWindow));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (results.length === 0) return;
        const picked = results[selectedIndex];
        if (!picked) return;
        if (e.metaKey || e.ctrlKey) {
          // ⌘+Enter — background open, selection advances by 1, palette
          // STAYS open (Codex F8). Selection advance happens regardless
          // of whether the item was already open (the "already open"
          // case still wants the visual feedback).
          handlePick(picked, "background");
          setSelectedIndex((s) => Math.min(results.length - 1, s + 1));
          return;
        }
        handlePick(picked, "primary");
        onClose();
      }
    },
    [handlePick, onClose, results, selectedIndex],
  );

  if (!open) return null;

  const showSoftCap = results.length > SOFT_CAP;
  const empty = results.length === 0;
  const emptyCopy =
    mode === "defined-term"
      ? `No defined terms match "${stripDefPrefix(q)}"`
      : `No sections match "${q}"`;
  const placeholder =
    mode === "defined-term" ? "Find defined term…" : "Go to section… (§ number or keyword)";
  const activeRowId = empty
    ? undefined
    : rowDomId(listboxId, results[selectedIndex], selectedIndex);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim closes on click; keyboard is handled at dialog level
    <div className="lc-palette-scrim" onMouseDown={onClose} role="presentation">
      <div
        className={`lc-palette${isStale ? " is-stale" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "defined-term" ? "Find defined term" : "Go to section"}
      >
        <div className="lc-palette-inputrow">
          <span className="lc-palette-ico">
            <Icons.Search size={13} />
          </span>
          <input
            ref={inputRef}
            className="lc-palette-input"
            placeholder={placeholder}
            value={q}
            maxLength={INPUT_MAX_LENGTH}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={activeRowId}
            aria-autocomplete="list"
          />
          <span className="lc-palette-kbd">⌘P</span>
        </div>
        {showSoftCap ? (
          // No aria-live — the count changes on every keystroke; an
          // announcement per keystroke turns into screen-reader spam.
          // The visible header is sufficient for sighted users; AT
          // users navigate via the listbox + aria-activedescendant.
          <div className="lc-palette-cap">
            Showing top {SOFT_CAP} of {results.length} matches
          </div>
        ) : null}
        <div
          className="lc-palette-list"
          ref={scrollRef}
          id={listboxId}
          role="listbox"
          aria-label={mode === "defined-term" ? "Defined-term matches" : "Section matches"}
        >
          {empty ? (
            <div className="lc-palette-empty">{emptyCopy}</div>
          ) : useVirt ? (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((virtItem) => {
                const item = results[virtItem.index];
                if (!item) return null;
                return (
                  <Row
                    key={virtItem.key}
                    domId={rowDomId(listboxId, item, virtItem.index)}
                    item={item}
                    selected={virtItem.index === selectedIndex}
                    onHover={() => setSelectedIndex(virtItem.index)}
                    onPick={() => {
                      handlePick(item, "primary");
                      onClose();
                    }}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${virtItem.size}px`,
                      transform: `translateY(${virtItem.start}px)`,
                    }}
                  />
                );
              })}
            </div>
          ) : (
            results.map((item, i) => (
              <Row
                key={rowKey(item, i)}
                domId={rowDomId(listboxId, item, i)}
                item={item}
                selected={i === selectedIndex}
                onHover={() => setSelectedIndex(i)}
                onPick={() => {
                  handlePick(item, "primary");
                  onClose();
                }}
              />
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
            <kbd>⌘</kbd>
            <kbd>↵</kbd> background
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  domId: string;
  item: SearchableItem;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
  style?: React.CSSProperties;
}

function Row({ domId, item, selected, onHover, onPick, style }: RowProps) {
  const onMouseDown = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      onPick();
    },
    [onPick],
  );
  if (item.kind === "section") {
    return (
      <button
        type="button"
        id={domId}
        role="option"
        aria-selected={selected}
        className={`lc-palette-item ${selected ? "is-sel" : ""}`}
        onMouseEnter={onHover}
        onMouseDown={onMouseDown}
        style={style}
      >
        <span className="lc-palette-glyph">§</span>
        <span className="lc-palette-num">{stripSectionSigil(item.num)}</span>
        <span className="lc-palette-name">{item.name}</span>
        <span className="lc-palette-meta">
          <span className="lc-palette-path">{item.path}</span>
        </span>
      </button>
    );
  }
  // defined-term row
  const moreCount = item.definers.length > 1 ? item.definers.length - 1 : 0;
  return (
    <button
      type="button"
      id={domId}
      role="option"
      aria-selected={selected}
      className={`lc-palette-item lc-palette-item-def ${selected ? "is-sel" : ""}`}
      onMouseEnter={onHover}
      onMouseDown={onMouseDown}
      style={style}
    >
      <span className="lc-palette-glyph">¶</span>
      <span className="lc-palette-name">{item.term}</span>
      <span className="lc-palette-meta">
        <span className="lc-palette-path">
          {item.moduleId}
          {moreCount > 0 ? ` · +${moreCount} more` : ""}
        </span>
      </span>
    </button>
  );
}

function rowKey(item: SearchableItem | undefined, fallbackIdx: number): string {
  if (!item) return `idx-${fallbackIdx}`;
  if (item.kind === "section") return `section-${item.moduleId}-${item.sectionId}`;
  return `def-${item.moduleId}-${item.term}`;
}

function rowDomId(listboxId: string, item: SearchableItem | undefined, idx: number): string {
  return `${listboxId}-${rowKey(item, idx)}`;
}

function stripSectionSigil(num: string): string {
  return num.replace(/^§\s*/, "");
}

function stripDefPrefix(q: string): string {
  return q.startsWith(":def ") ? q.slice(":def ".length) : q;
}

function toOpenItem(item: SearchableItem): OpenItem | null {
  // `corpusRefFromWire` validates the wire-shape ids and throws on
  // garbage. The schema-validated trust boundary is upstream
  // (corpus-loader), so a throw here would mean a real bug — but if
  // one ever slipped past, we'd rather no-op the click than crash the
  // renderer mid-navigate. Return null on parse failure; the keyboard
  // and mouse handlers already branch on null.
  try {
    if (item.kind === "section") {
      return {
        kind: "section",
        ref: corpusRefFromWire({ moduleId: item.moduleId, sectionId: item.sectionId }),
      };
    }
    // defined-term picks navigate to the first definer in the module.
    // Multi-definer disambiguation within a module is a deferred TODO
    // (feat/section-view-polish #19); v1 takes the first.
    const firstDefiner = item.definers[0];
    if (!firstDefiner) return null;
    return {
      kind: "section",
      ref: corpusRefFromWire({ moduleId: item.moduleId, sectionId: firstDefiner }),
    };
  } catch (cause) {
    console.warn(`[command-palette] dropped malformed item (${item.kind}):`, cause);
    return null;
  }
}

/** Visible-row count for PageUp / PageDown jumps. Defaults to 10 when
 *  the container hasn't measured yet (jsdom, or first paint). */
function visiblePageSize(container: HTMLElement | null): number {
  if (!container) return 10;
  const h = container.clientHeight || 0;
  if (h === 0) return 10;
  return Math.max(1, Math.floor(h / ROW_HEIGHT_PX));
}
