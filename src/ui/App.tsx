// Root component — orchestrates corpus loading and the workbench
// openItems state. Owns: corpus IPC, BootOverlay branching for crash /
// corpus errors, persistence cold-start (legacy migration runs through
// `@/persistence` Layer 1), and the palette toggle. Workbench mutators
// (`openItem`, `openItemWithoutSwitching`) are dispatched via functional
// `setOpenItems` updates so closure-based deps stay stable.

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/app/api";
import { applyPersistedLineHeightMult } from "@/app/section-line-height";
import { type CorpusRef, corpusRefFromWire, corpusRefToWire, hash as refHash } from "@/corpus/refs";
import type {
  CorpusError,
  CorpusModuleSummary,
  CorpusSectionView,
  CorpusTreeNode,
} from "@/corpus/wire";
import { readOpenItems, writeOpenItems } from "@/persistence";
import { ActivityBar } from "@/ui/chrome/activity-bar";
import { BootOverlay } from "@/ui/chrome/boot-overlay";
import { Breadcrumb } from "@/ui/chrome/breadcrumb";
import { CommandPalette } from "@/ui/chrome/command-palette";
import { StatusBar } from "@/ui/chrome/status-bar";
import { TitleBar } from "@/ui/chrome/title-bar";
import { ThreePanel } from "@/ui/layout/three-panel";
import { FileTree } from "@/ui/left-panel/file-tree/file-tree";
import { TabEmptyState } from "@/ui/tabs/empty-state";
import { useTabKeyboardShortcuts } from "@/ui/tabs/keyboard-shortcuts";
import { TabContent } from "@/ui/tabs/tab-content";
import { buildTitleMap, TabStrip } from "@/ui/tabs/tab-strip";
import { useTabs } from "@/ui/tabs/use-tabs";
import {
  activeItem,
  emptyOpenItems,
  fromPersisted,
  type OpenItemsState,
  openItem,
  openItemWithoutSwitching,
  toPersisted,
  validateAgainstCorpus,
} from "@/workbench";

export function App() {
  const [corpus, setCorpus] = useState<CorpusModuleSummary | null>(null);
  const [corpusError, setCorpusError] = useState<CorpusError | null>(null);
  const [openItems, setOpenItems] = useState<OpenItemsState>(emptyOpenItems);
  const [section, setSection] = useState<CorpusSectionView | null>(null);
  // Per-read error: distinct from corpusError (which is fatal — drops to
  // BootOverlay). Set when a single corpus.read returns ok:false; cleared
  // on the next successful read. Pairs with `setSection(null)` so stale
  // breadcrumb/title chrome doesn't leak past the failed section (C7).
  const [sectionError, setSectionError] = useState<CorpusError | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [crashed, setCrashed] = useState(false);

  // Detect renderer recovery — main.ts appends ?recovered=1 after crash.
  useEffect(() => {
    if (window.location.search.includes("recovered=1")) setCrashed(true);
  }, []);

  // Apply the persisted section-body line-height multiplier on cold
  // start. Cheap synchronous DOM write — runs once before the section
  // body has any content to render, so the CSS var is in place by the
  // time the first <p class="lc-para"> paints.
  useEffect(() => {
    applyPersistedLineHeightMult();
  }, []);

  // Initial corpus load + cold-start state hydration. Runs once. The
  // `?recovered=1` path short-circuits to BootOverlay, then user-clicks-
  // reload strips the query (window.location.replace below), which causes
  // a cold start that hits this same path — the migration / hydration
  // runs naturally there.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api().corpus.list();
        if (cancelled) return;
        if (!r.ok) {
          setCorpusError(r.error);
          return;
        }
        setCorpus(r.value);

        const persisted = readOpenItems();
        let state = persisted ? fromPersisted(persisted) : emptyOpenItems();
        state = validateAgainstCorpus(state, (ref) => hasRefInTree(r.value.tree, ref));
        // Seed defaultRef in two cases:
        //   (a) true cold start — no persisted value at all
        //   (b) corpus invalidation — persisted had items but
        //       validateAgainstCorpus dropped them all (e.g. corpus
        //       upgrade renumbered every section ref)
        // Preserve emptiness only when persisted was explicitly empty
        // (user closed every tab last session — that intent stands).
        const persistedExplicitlyEmpty = persisted !== null && persisted.items.length === 0;
        if (state.items.length === 0 && !persistedExplicitlyEmpty) {
          state = openItem(state, corpusRefFromWire(r.value.defaultRef));
        }
        setOpenItems(state);
      } catch (cause) {
        if (cancelled) return;
        setCorpusError({
          kind: "not_loaded",
          detail: `IPC bridge unavailable: ${describeError(cause)}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist openItems on every state change, but only after the cold-
  // start has loaded the corpus — otherwise the initial empty state
  // would clobber a freshly-migrated value before it's been read.
  useEffect(() => {
    if (corpus === null) return;
    writeOpenItems(toPersisted(openItems));
  }, [openItems, corpus]);

  // Stable string key for the active section ref — drives the section
  // read effect without re-firing when openItems mutates non-active
  // entries (e.g. open-without-switch appending a new tab).
  const activeKey = useMemo(() => {
    const active = activeItem(openItems);
    if (!active || active.kind !== "section") return null;
    return refHash(active.ref);
  }, [openItems]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeKey is the deliberate change-trigger; openItems mutations that don't change the active ref must not re-fire the section read
  useEffect(() => {
    const active = activeItem(openItems);
    if (!active || active.kind !== "section") {
      setSection(null);
      setSectionError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api().corpus.read(corpusRefToWire(active.ref));
        if (cancelled) return;
        if (r.ok) {
          setSection(r.value);
          setSectionError(null);
        } else {
          // C7: clear stale section so breadcrumb + parents kicker don't
          // render the previous section's chrome behind the in-section
          // error banner. Both pieces of state flip together.
          setSection(null);
          setSectionError(r.error);
        }
      } catch (cause) {
        if (cancelled) return;
        setCorpusError({
          kind: "not_loaded",
          detail: `IPC bridge unavailable: ${describeError(cause)}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeKey]);

  // ⌘P palette toggle. The shared typing-surface guard would suppress
  // this when focus is inside the palette's own input — ⌘P is the
  // palette's OWN toggle, so it must always preventDefault (to swallow
  // Electron's native print dialog) and fire, regardless of focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onActivate = useCallback((ref: CorpusRef) => {
    setOpenItems((prev) => openItem(prev, ref));
  }, []);

  const onOpenWithoutSwitching = useCallback((ref: CorpusRef) => {
    setOpenItems((prev) => openItemWithoutSwitching(prev, ref));
  }, []);

  // CQ4 — `Map<RefHash, CorpusTreeNode>` keyed by `module::section`,
  // built once per corpus snapshot and threaded through TabStrip for
  // O(1) per-tab title lookup (P1).
  const titleMap = useMemo(() => buildTitleMap(corpus?.tree ?? []), [corpus]);

  // CQ4-adjacent: use the title map as the corpus-validity predicate for
  // recentlyClosed re-validation. Cheap, no second tree walk.
  const isRefInCorpus = useCallback((ref: CorpusRef) => titleMap.has(refHash(ref)), [titleMap]);

  const {
    close: closeTabAt,
    reopenLast,
    saveScroll,
    useRestoreScroll,
  } = useTabs({
    openItems,
    setOpenItems,
    isValidRef: isRefInCorpus,
  });

  // Callback ref + state for SectionView's scroll container — the hook
  // needs the live DOM node, so we track it in state to trigger a
  // re-run of `useRestoreScroll` when it mounts after the corpus load.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  // Drive scroll restoration from the rendered section (not just from
  // the active tab change) so the restored scrollTop lands on the new
  // section's DOM, not the previous one's. sectionKey flips only after
  // the section read settles.
  const activeSectionRef = useMemo(() => {
    const a = activeItem(openItems);
    return a && a.kind === "section" ? a.ref : null;
  }, [openItems]);
  const sectionKey = section ? `${section.moduleId}::${section.section.id}` : null;
  useRestoreScroll(activeSectionRef, scrollEl, sectionKey);

  const onScrollY = useCallback(
    (y: number) => {
      if (activeSectionRef) saveScroll(activeSectionRef, y);
    },
    [activeSectionRef, saveScroll],
  );

  const closeActiveTab = useCallback(() => {
    if (openItems.activeIndex === null) return;
    closeTabAt(openItems.activeIndex);
  }, [openItems.activeIndex, closeTabAt]);

  useTabKeyboardShortcuts({
    openItems,
    setOpenItems,
    closeActive: closeActiveTab,
    reopenLast,
  });

  const fileLabel = useMemo(() => {
    if (!section) return "";
    return `§ ${section.section.id} — ${section.section.title}`;
  }, [section]);

  const parentsLabel = useMemo(() => {
    if (!section) return "";
    return section.parents
      .map((p) => p.code)
      .filter(Boolean)
      .join(" · ");
  }, [section]);

  const onCopyDiagnostic = useCallback(() => {
    const lines = [
      `LegisCode crash diagnostic`,
      `Time: ${new Date().toISOString()}`,
      `User-Agent: ${navigator.userAgent}`,
      crashed ? `Crash: renderer process gone` : "",
      corpusError ? `Corpus error (${corpusError.kind}): ${corpusError.detail}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    void navigator.clipboard?.writeText(lines).catch(() => {});
  }, [corpusError, crashed]);

  if (crashed) {
    return (
      <BootOverlay
        variant="crash"
        onReload={() => {
          window.location.replace(window.location.pathname);
        }}
        onCopyDiagnostic={onCopyDiagnostic}
      />
    );
  }

  if (corpusError) {
    return (
      <BootOverlay
        variant="corpus"
        error={corpusError}
        onCopyDiagnostic={onCopyDiagnostic}
        onQuit={() => window.close()}
      />
    );
  }

  // Until corpus + first section resolve, render the chrome shell with
  // empty bodies. The window stays show:false in main.ts so this state is
  // never visible to the user.
  const sectionLabel = section ? `§ ${section.section.id}` : null;
  const active = activeItem(openItems);
  const hasItems = openItems.items.length > 0;
  const center: ReactNode = (
    <div className="lc-center">
      {hasItems ? (
        <>
          <TabStrip
            openItems={openItems}
            setOpenItems={setOpenItems}
            titleMap={titleMap}
            closeAt={closeTabAt}
          />
          <Breadcrumb parents={section?.parents ?? []} sectionLabel={sectionLabel} />
          {active ? (
            <TabContent
              item={active}
              section={section}
              sectionError={sectionError}
              parentsLabel={parentsLabel}
              onActivate={onActivate}
              scrollContainerRef={setScrollEl}
              onScrollY={onScrollY}
            />
          ) : null}
        </>
      ) : (
        <TabEmptyState />
      )}
    </div>
  );

  return (
    <>
      <TitleBar
        workspaceLabel={corpus?.rootLabel ?? ""}
        fileLabel={fileLabel}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="lc-frame">
        <ActivityBar active="structure" onChange={() => {}} />
        <div className="lc-body">
          <ThreePanel
            left={
              <div className="lc-leftpanel">
                <div className="lc-leftpanel-title">
                  <span>Structure</span>
                  <span className="lc-leftpanel-title-count">{corpus?.codeCount ?? 0} codes</span>
                </div>
                <FileTree
                  // Remount once the corpus arrives so `useCorpusTree`'s
                  // useState initializer computes default expansion against
                  // the populated tree, not the boot-time empty placeholder.
                  key={corpus?.jurisdictionVersion ?? "boot"}
                  tree={corpus?.tree ?? []}
                  openItems={openItems}
                  onActivate={onActivate}
                  onOpenWithoutSwitching={onOpenWithoutSwitching}
                />
              </div>
            }
            center={center}
            right={<div className="lc-rightpanel" />}
          />
        </div>
      </div>
      <StatusBar
        rootLabel={corpus?.rootLabel ?? ""}
        jurisdictionVersion={corpus?.jurisdictionVersion ?? ""}
        codeCount={corpus?.codeCount ?? 0}
      />
      {corpus ? (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          corpus={corpus}
          onSelect={(ref) => {
            onActivate(ref);
            setPaletteOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}

function hasRefInTree(tree: readonly CorpusTreeNode[], ref: CorpusRef): boolean {
  const stack: CorpusTreeNode[] = [...tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (
      node.kind === "section" &&
      node.ref &&
      node.ref.moduleId === ref.module &&
      node.ref.sectionId === ref.section
    ) {
      return true;
    }
    if (node.kids) for (const k of node.kids) stack.push(k);
  }
  return false;
}
