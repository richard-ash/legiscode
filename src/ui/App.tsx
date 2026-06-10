// Root component — orchestrates corpus loading and the workbench
// openItems state. Owns: corpus IPC, BootOverlay branching for crash /
// corpus errors, persistence cold-start (legacy migration runs through
// `@/persistence`), and the palette toggle. Tab dispatch goes through
// useNavigation's `navigate(item, intent)` primitive.

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useChat } from "@/app/ai/use-chat";
import { api } from "@/app/api";
import { applyPersistedLineHeightMult } from "@/app/section-line-height";
import { useCitationDispatch } from "@/citations/dispatch";
import {
  type CorpusRef,
  corpusRefFromWire,
  corpusRefToWire,
  parse as parseCorpusRef,
  hash as refHash,
} from "@/corpus/refs";
import type {
  CorpusError,
  CorpusModuleSummary,
  CorpusSectionView,
  CorpusTreeNode,
} from "@/corpus/wire";
import { readOpenItems, writeOpenItems } from "@/persistence";
import type { Bill } from "@/types";
import { ChatPanel } from "@/ui/chat/chat-panel";
import { ActivityBar } from "@/ui/chrome/activity-bar";
import { BootOverlay } from "@/ui/chrome/boot-overlay";
import { Breadcrumb } from "@/ui/chrome/breadcrumb";
import { StatusBar } from "@/ui/chrome/status-bar";
import { TitleBar } from "@/ui/chrome/title-bar";
import { usePendingBillsStatus } from "@/ui/chrome/use-pending-bills-status";
import { CommandPalette } from "@/ui/command-palette/command-palette";
import { useCommandPalette } from "@/ui/command-palette/use-command-palette";
import { ThreePanel } from "@/ui/layout/three-panel";
import { useSessionBills } from "@/ui/left-panel/activity/use-session-bills";
import { FileTree } from "@/ui/left-panel/file-tree/file-tree";
import { LeftPanel } from "@/ui/left-panel/left-panel";
import { getKeySpec, matchEvent } from "@/ui/shortcuts/registry";
import { useShortcut } from "@/ui/shortcuts/use-shortcut";
import { TabEmptyState } from "@/ui/tabs/empty-state";
import { useTabKeyboardShortcuts } from "@/ui/tabs/keyboard-shortcuts";
import { TabContent } from "@/ui/tabs/tab-content";
import { TabStrip } from "@/ui/tabs/tab-strip";
import { useTabs } from "@/ui/tabs/use-tabs";
import { useCorpusIndices } from "@/ui/use-corpus-indices";
import { useNavigation } from "@/ui/use-navigation";
import {
  activeItem,
  emptyOpenItems,
  fromPersisted,
  type OpenItemsState,
  openItem,
  toPersisted,
  validateAgainstCorpus,
} from "@/workbench";

export function App() {
  const [corpus, setCorpus] = useState<CorpusModuleSummary | null>(null);
  const [corpusError, setCorpusError] = useState<CorpusError | null>(null);
  const [openItems, setOpenItems] = useState<OpenItemsState>(emptyOpenItems);
  const [section, setSection] = useState<CorpusSectionView | null>(null);
  // Per-read error: distinct from corpusError (which is fatal — drops
  // to BootOverlay). Set when a single corpus.read returns ok:false;
  // cleared on the next successful read. Pairs with `setSection(null)`
  // so stale breadcrumb/title chrome doesn't leak past the failed
  // section.
  const [sectionError, setSectionError] = useState<CorpusError | null>(null);
  const [crashed, setCrashed] = useState(false);
  const palette = useCommandPalette(corpus);
  usePendingBillsStatus(corpus);

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
        const knownBills = new Set(r.value.sessionBills.bills.map((b) => b.file_no));
        let state = persisted
          ? fromPersisted(persisted, (billId) => knownBills.has(billId))
          : emptyOpenItems();
        state = validateAgainstCorpus(state, (ref) => hasRefInTree(r.value.tree, ref));
        // Boot into law: ensure the active tab is a section. One condition
        // covers every cold-start path where it isn't —
        //   (a) true cold start (no persisted value, no items),
        //   (b) corpus invalidation that dropped every section,
        //   (c) a persisted Settings tab left active, and
        //   (d) invalidation that dropped the active section but left a
        //       Settings tab, leaving items non-empty with activeIndex null.
        // openItem focuses the default section, opening it if absent; a
        // surviving Settings tab stays open but unfocused. Emptiness is
        // preserved only when persisted was explicitly empty (the user
        // closed every tab last session — that intent stands).
        const persistedExplicitlyEmpty = persisted !== null && persisted.items.length === 0;
        if (!persistedExplicitlyEmpty && activeItem(state)?.kind !== "section") {
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
          // Clear stale section so breadcrumb + parents kicker don't
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
  // palette's OWN toggle, so it stays bespoke (no guard) and always
  // preventDefaults (to swallow Electron's native print dialog) and
  // fires, regardless of focus. The key spec still comes from the catalog
  // so its displayed label can't drift.
  useEffect(() => {
    const spec = getKeySpec("global.open-palette");
    const onKey = (e: KeyboardEvent) => {
      if (!matchEvent(e, spec)) return;
      e.preventDefault();
      palette.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette.toggle]);

  const {
    titleMap,
    sessionBillsById,
    installedModules,
    lookupCodeLabel,
    lookupSectionTitle,
    isRefInCorpus,
    getCitationPreview,
  } = useCorpusIndices(corpus);

  const onOpenLegistar = useCallback((url: string) => {
    // Fire-and-forget. The main-side handler validates http(s) before
    // dispatching to shell.openExternal; renderer failure logging is
    // intentionally minimal (the user will notice the browser didn't
    // open faster than any toast we could surface).
    void api()
      .shell.openExternal({ url })
      .catch((err) => {
        console.warn("[bill] shell.openExternal failed", err);
      });
  }, []);

  const sessionBillsView = useSessionBills(corpus);

  // useNavigation owns the active-tab state mutators + the ⌘⌥←/→
  // keyboard listener. navigate(item, intent) is the only entry
  // point the citation dispatcher needs.
  const { navigate, pendingScroll, requestScroll, consumePendingScroll } = useNavigation({
    openItems,
    setOpenItems,
  });

  const onOpenBill = useCallback(
    (fileNo: string, mode: "primary" | "background") => {
      navigate({ kind: "bill", billId: fileNo }, mode === "background" ? "background" : "primary");
    },
    [navigate],
  );

  // ⌘, opens (or focuses, via the settings::shortcuts identity) the
  // Settings tab. Routed through the catalog hook so it shares the
  // typing-surface guard and its label can't drift.
  const openSettings = useCallback(() => {
    navigate({ kind: "settings", section: "shortcuts" }, "primary");
  }, [navigate]);
  useShortcut("global.open-settings", openSettings);

  const { resolveCitation, onCitationActivate } = useCitationDispatch({
    corpus,
    section,
    installedModules,
    titleMap,
    navigate,
    requestScroll,
  });

  const {
    close: closeTabAt,
    closeOthers: closeOthersAt,
    closeToRight: closeToRightAt,
    closeAll: closeAllTabs,
    reopenLast,
    saveScroll,
    useRestoreScroll,
  } = useTabs({
    openItems,
    setOpenItems,
    isValidRef: isRefInCorpus,
    navigate,
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

  // Subsection scroll target — runs AFTER useRestoreScroll so a citation
  // jump like "§ 1.2(a)(2)" overrides the per-section scrollTop restore.
  // The pendingScroll.targetSectionKey gate is load-bearing: a citation
  // click sets pendingScroll synchronously but the new section's body
  // mounts only after the corpus.read IPC roundtrip. Without the gate,
  // the effect would fire against the previous section's DOM, miss the
  // anchor, and consume the pending scroll before the new section ever
  // had a chance. CSS.escape on the subsection label is required since
  // labels carry parens and digits (e.g. "(a)", "(2)") that aren't
  // valid in a raw CSS id selector.
  useLayoutEffect(() => {
    if (!pendingScroll || !scrollEl || !sectionKey) return;
    if (pendingScroll.targetSectionKey !== sectionKey) return;
    const el = scrollEl.querySelector(
      `#${CSS.escape(`lc-sub-${pendingScroll.subsection}`)}`,
    ) as HTMLElement | null;
    if (el) {
      const containerRect = scrollEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      scrollEl.scrollTop = scrollEl.scrollTop + (elRect.top - containerRect.top) - 16;
    }
    consumePendingScroll();
  }, [pendingScroll, sectionKey, scrollEl, consumePendingScroll]);

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
    closeAll: closeAllTabs,
    reopenLast,
  });

  const fileLabel = useMemo(() => {
    if (!section) return "";
    return `§ ${section.section.display_label} — ${section.section.title}`;
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
  const sectionLabel = section ? `§ ${section.section.display_label}` : null;
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
            sessionBillsById={sessionBillsById}
            closeAt={closeTabAt}
            closeOthers={closeOthersAt}
            closeToRight={closeToRightAt}
            closeAll={closeAllTabs}
          />
          {active?.kind === "section" ? (
            <Breadcrumb
              parents={section?.parents ?? []}
              sectionLabel={sectionLabel}
              moduleId={section?.moduleId}
              navigate={navigate}
            />
          ) : null}
          {active ? (
            <TabContent
              item={active}
              section={section}
              sectionError={sectionError}
              parentsLabel={parentsLabel}
              navigate={navigate}
              onCitationActivate={onCitationActivate}
              resolveCitation={resolveCitation}
              getCitationPreview={getCitationPreview}
              scrollContainerRef={setScrollEl}
              onScrollY={onScrollY}
              sessionBills={corpus?.sessionBills.bills}
              lookupCodeLabel={lookupCodeLabel}
              lookupSectionTitle={lookupSectionTitle}
              onOpenLegistar={onOpenLegistar}
              pendingRailBills={pendingRailBillsForSection(sessionBillsView, section)}
              onOpenBill={onOpenBill}
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
        onOpenPalette={() => {
          if (!palette.open) palette.toggle();
        }}
        onOpenShortcuts={openSettings}
      />
      <div className="lc-frame">
        <ActivityBar active="structure" onChange={() => {}} />
        <div className="lc-body">
          <ThreePanel
            left={
              <LeftPanel
                corpus={corpus}
                activeBillId={active?.kind === "bill" ? active.billId : null}
                onOpenBill={onOpenBill}
                lookupCodeLabel={lookupCodeLabel}
                codesPane={
                  <>
                    <div className="lc-leftpanel-title">
                      <span>Structure</span>
                      <span className="lc-leftpanel-title-count">
                        {corpus?.codeCount ?? 0} codes
                      </span>
                    </div>
                    <FileTree
                      // Remount once the corpus arrives so `useCorpusTree`'s
                      // useState initializer computes default expansion against
                      // the populated tree, not the boot-time empty placeholder.
                      key={corpus?.jurisdictionVersion ?? "boot"}
                      tree={corpus?.tree ?? []}
                      openItems={openItems}
                      navigate={navigate}
                    />
                  </>
                }
              />
            }
            center={center}
            right={
              <RightChatSurface
                section={section}
                onOpenAiSettings={() => navigate({ kind: "settings", section: "ai" }, "primary")}
                onCitationClick={(ref) => navigateToWireRef(ref, navigate)}
                onBillClick={(fileNo) => navigate({ kind: "bill", billId: fileNo }, "primary")}
              />
            }
          />
        </div>
      </div>
      <StatusBar
        rootLabel={corpus?.rootLabel ?? ""}
        jurisdictionVersion={corpus?.jurisdictionVersion ?? ""}
        codeCount={corpus?.codeCount ?? 0}
      />
      {corpus ? <CommandPalette palette={palette} navigate={navigate} /> : null}
    </>
  );
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}

// Helper: AiCorpusContextRef → workbench navigate. Avoids reshaping
// through `{moduleId, sectionId}` (which the baseline grep gate
// reserves for boundary helpers) by calling refs.parse directly.
function navigateToWireRef(
  ref: { module_id: string; section_id: string },
  navigate: ReturnType<typeof useNavigation>["navigate"],
): void {
  const corpusRef = parseCorpusRef({ module: ref.module_id, section: ref.section_id });
  navigate({ kind: "section", ref: corpusRef }, "primary");
}

interface RightChatSurfaceProps {
  /** Currently-focused section. Null when the active tab is a Bill,
   *  Settings, or empty workbench. The chat panel stays mounted either
   *  way — only the anchor it carries with each send changes. */
  section: CorpusSectionView | null;
  onOpenAiSettings: () => void;
  onCitationClick: (ref: { module_id: string; section_id: string }) => void;
  onBillClick: (fileNo: string) => void;
}

/**
 * Adapter that bridges the global chat hook to the right pane. Per
 * [[feedback_global_chat_not_per_section]] the chat is one thread; the
 * active section is per-send context, never a remount key.
 */
function RightChatSurface({
  section,
  onOpenAiSettings,
  onCitationClick,
  onBillClick,
}: RightChatSurfaceProps): ReactNode {
  const [hasApiKey, setHasApiKey] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Defensive try around api(): in jsdom tests the bridge may be torn
    // down mid-effect when components remount; treat as "no key".
    try {
      void api()
        .ai.hasApiKey({ provider_id: "anthropic" })
        .then((result) => {
          if (!cancelled) setHasApiKey(result.has_key);
        })
        .catch(() => {
          if (!cancelled) setHasApiKey(false);
        });
    } catch {
      if (!cancelled) setHasApiKey(false);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const chat = useChat();

  const anchor = section
    ? { module_id: section.moduleId, section_id: section.section.id }
    : undefined;
  const anchorLabel = section ? `§ ${section.section.display_label}` : null;
  const anchorModule = section?.moduleId ?? "";

  return (
    <ChatPanel
      chat={chat}
      anchor={anchor}
      anchorLabel={anchorLabel}
      anchorModule={anchorModule}
      hasApiKey={hasApiKey}
      onOpenSettings={onOpenAiSettings}
      onCitationClick={onCitationClick}
      onBillClick={onBillClick}
    />
  );
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

/**
 * Filter `bySection` (sectionId → bill rows across modules) down to
 * only those rows whose `module_id` matches the active section's
 * module. Without this, a bill affecting "1.0" in sf-admin would
 * surface on a section "1.0" in sf-police — wrong, because those are
 * different legal targets.
 *
 * Rail-eligibility (status filter) is decided at the hook level
 * `useSessionBills.bySection` — currently PENDING_STATES plus enacted.
 * Vetoed, withdrawn, and failed bills never enter the rail because
 * they won't affect the section's text. Enacted bills stay on the
 * rail forever until they age out by other means — the
 * AmLegal-absorption signal that would drop them once the canonical
 * code reflects the change is deferred (TODOS.md, T4 originally).
 * Trigger to revisit: signed-bill clutter on a high-traffic section
 * (Police Code §96, Planning Code 309, etc.) OR users complaining
 * about reading stale section text without realizing a signed
 * amendment exists.
 */
function pendingRailBillsForSection(
  view: ReturnType<typeof useSessionBills>,
  section: CorpusSectionView | null,
): ReadonlyArray<Bill> | undefined {
  if (!section) return undefined;
  const rows = view.bySection.get(section.section.id);
  if (!rows || rows.length === 0) return undefined;
  const filtered = rows.filter((b) => b.module_id === section.moduleId);
  return filtered.length > 0 ? filtered : undefined;
}
