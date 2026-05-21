// Root component — orchestrates corpus loading and the workbench
// openItems state. Owns: corpus IPC, BootOverlay branching for crash /
// corpus errors, persistence cold-start (legacy migration runs through
// `@/persistence` Layer 1), and the palette toggle. Tab dispatch goes
// through useNavigation's `navigate(item, intent)` primitive — the legacy
// `onActivate`/`onOpenWithoutSwitching` pair retired in T7.

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { api } from "@/app/api";
import { applyPersistedLineHeightMult } from "@/app/section-line-height";
import { type CorpusExistence, resolve } from "@/citations/resolver";
import {
  type CorpusRef,
  corpusRefFromWire,
  corpusRefToWire,
  parse as parseRef,
  hash as refHash,
} from "@/corpus/refs";
import type {
  CorpusError,
  CorpusModuleSummary,
  CorpusSectionView,
  CorpusTreeNode,
} from "@/corpus/wire";
import { readOpenItems, writeOpenItems } from "@/persistence";
import { type ModuleId, ModuleIdSchema } from "@/types";
import type { Citation } from "@/types/citation";
import { ActivityBar } from "@/ui/chrome/activity-bar";
import { BootOverlay } from "@/ui/chrome/boot-overlay";
import { Breadcrumb } from "@/ui/chrome/breadcrumb";
import { CommandPalette } from "@/ui/command-palette/command-palette";
import { useCommandPalette } from "@/ui/command-palette/use-command-palette";
import { StatusBar } from "@/ui/chrome/status-bar";
import { TitleBar } from "@/ui/chrome/title-bar";
import { ThreePanel } from "@/ui/layout/three-panel";
import { FileTree } from "@/ui/left-panel/file-tree/file-tree";
import { TabEmptyState } from "@/ui/tabs/empty-state";
import { useTabKeyboardShortcuts } from "@/ui/tabs/keyboard-shortcuts";
import { TabContent } from "@/ui/tabs/tab-content";
import { buildTitleMap, TabStrip } from "@/ui/tabs/tab-strip";
import { useTabs } from "@/ui/tabs/use-tabs";
import { useNavigation } from "@/ui/use-navigation";
import {
  activeItem,
  emptyOpenItems,
  fromPersisted,
  type OpenItem,
  type OpenItemsState,
  openItem,
  toPersisted,
  validateAgainstCorpus,
} from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";

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
  const [crashed, setCrashed] = useState(false);
  const palette = useCommandPalette(corpus);

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
        palette.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette.toggle]);

  // CQ4 — `Map<RefHash, CorpusTreeNode>` keyed by `module::section`,
  // built once per corpus snapshot and threaded through TabStrip for
  // O(1) per-tab title lookup (P1).
  const titleMap = useMemo(() => buildTitleMap(corpus?.tree ?? []), [corpus]);

  // CQ4-adjacent: use the title map as the corpus-validity predicate for
  // recentlyClosed re-validation. Cheap, no second tree walk.
  const isRefInCorpus = useCallback((ref: CorpusRef) => titleMap.has(refHash(ref)), [titleMap]);

  // Set of installed module ids, derived from titleMap so the existence
  // oracle re-uses the same per-corpus walk. Used by the resolver to
  // distinguish cross-module citations into uninstalled modules
  // (unresolvable) from those into installed ones.
  const installedModules = useMemo<ReadonlySet<ModuleId>>(() => {
    const out = new Set<ModuleId>();
    for (const node of titleMap.values()) {
      if (!node.ref) continue;
      const parsed = ModuleIdSchema.safeParse(node.ref.moduleId);
      if (parsed.success) out.add(parsed.data);
    }
    return out;
  }, [titleMap]);

  // useNavigation owns the active-tab state mutators + the ⌘⌥←/→
  // keyboard listener. Per-tab history was removed in
  // feat/citation-resolution; navigate(item, intent) is the only entry
  // point the citation dispatcher needs.
  const { navigate, pendingScroll, requestScroll, consumePendingScroll } = useNavigation({
    openItems,
    setOpenItems,
  });

  const buildExistence = useCallback((): CorpusExistence | null => {
    if (!corpus || !section) return null;
    const parsed = ModuleIdSchema.safeParse(section.moduleId);
    if (!parsed.success) return null;
    const citingModule = parsed.data;
    let activeSectionRef: CorpusRef | null = null;
    try {
      activeSectionRef = parseRef({ module: citingModule, section: section.section.id });
    } catch {
      activeSectionRef = null;
    }
    return {
      citingModule,
      installedModules,
      activeSection: activeSectionRef,
      hasSection: (module, sectionId) => {
        try {
          return titleMap.has(refHash(parseRef({ module, section: sectionId })));
        } catch {
          return false;
        }
      },
      findStructural: (level, number) =>
        findStructuralRef(corpus.tree, citingModule, level, number),
    };
  }, [corpus, section, installedModules, titleMap]);

  const resolveCitation = useCallback(
    (citation: Citation) => {
      const existence = buildExistence();
      if (!existence) return null;
      return resolve(citation, existence);
    },
    [buildExistence],
  );

  // Synchronous (title, excerpt) lookup for the citation hover popover.
  // Same titleMap that powers tab titles — node carries `code`, `name`,
  // and the optional `preview` baked at corpus-load time. Returns null
  // when the ref isn't in the loaded corpus (cross-module into an
  // uninstalled module; the popover handles that case via the resolution
  // discriminator, not via preview).
  const getCitationPreview = useCallback(
    (ref: CorpusRef, subsection?: string): { title: string; excerpt?: string } | null => {
      const node = titleMap.get(refHash(ref));
      if (!node) return null;
      const title = node.name ? `${node.code} — ${node.name}` : node.code;
      // Subsection-keyed excerpt wins when the cite targets a subsection
      // and the parser-emitted label matches a pre-baked entry; else fall
      // back to the section-level preview.
      const subsectionExcerpt =
        subsection && node.subsectionPreviews ? node.subsectionPreviews[subsection] : undefined;
      const excerpt = subsectionExcerpt ?? node.preview;
      return excerpt ? { title, excerpt } : { title };
    },
    [titleMap],
  );

  const onCitationActivate = useCallback(
    (citation: Citation, intent: NavigationIntent) => {
      const existence = buildExistence();
      if (!existence) return;
      const result = resolve(citation, existence);
      switch (result.kind) {
        case "navigate-section": {
          const item: OpenItem = { kind: "section", ref: result.ref };
          navigate(item, intent, result.subsection ? { subsection: result.subsection } : undefined);
          return;
        }
        case "navigate-structural": {
          const item: OpenItem = { kind: "section", ref: result.ref };
          navigate(item, intent);
          return;
        }
        case "navigate-appendix": {
          // No appendix viewer in v1; resolver still returns the verb so
          // the consumer can drop in support without re-discriminating.
          console.warn(
            `[citations] appendix navigation not yet implemented: ${result.module}::${result.appendixId}`,
          );
          return;
        }
        case "module-not-installed": {
          // Decided 2026-05-20: ⌘-click on a not-installed module is a
          // no-op; the popover is the user-facing affordance.
          return;
        }
        case "scroll-only": {
          if (!section) return;
          requestScroll({
            subsection: result.subsection,
            targetSectionKey: `${section.moduleId}::${section.section.id}`,
          });
          return;
        }
        case "unresolvable": {
          // Phase 3 — should never fire from committed corpus data once
          // the Phase 4 gate is in place. Loud-log so dev catches drift:
          // a fired unresolvable means the build leaked an unbindable
          // cite past the gate (or a vague target reached navigate,
          // which the dispatcher upstream is supposed to filter).
          // Stays at console-level only; no toast in v1 — the gate is
          // the user-facing signal.
          console.error(`[citations] unresolvable: ${result.reason}`);
          return;
        }
      }
    },
    [buildExistence, section, navigate, requestScroll],
  );

  const {
    close: closeTabAt,
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
            closeAt={closeTabAt}
          />
          <Breadcrumb parents={section?.parents ?? []} sectionLabel={sectionLabel} />
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
                  navigate={navigate}
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
      {corpus ? <CommandPalette palette={palette} navigate={navigate} /> : null}
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

// Convert a positive integer (≤ 3999) to a Roman numeral. SF's
// chapter/article naming uses both forms — Articles tend to be Roman
// ("ARTICLE V"), chapters arabic ("CHAPTER 5") — so the structural
// resolver tries both when matching tree node prefixes.
const ROMAN_PIECES: ReadonlyArray<readonly [number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];
export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 3999) return "";
  let remaining = n;
  let out = "";
  for (const [value, symbol] of ROMAN_PIECES) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

export function findStructuralRef(
  tree: readonly CorpusTreeNode[],
  module: ModuleId,
  level: "article" | "chapter" | "division" | "title",
  number: string,
): CorpusRef | null {
  const moduleRoot = tree.find((n) => n.kind === "code" && n.id === module);
  if (!moduleRoot?.kids) return null;
  const labelUpper = level.toUpperCase();
  const candidates = new Set<string>([number]);
  const asInt = Number.parseInt(number, 10);
  if (!Number.isNaN(asInt)) {
    const roman = toRoman(asInt);
    if (roman) candidates.add(roman);
  }
  // Delimited prefixes (e.g. "CHAPTER 1:" / "CHAPTER 1 ") match by
  // startsWith — the trailing delimiter prevents "CHAPTER 1" from
  // claiming "CHAPTER 10". Bare matchers (no trailing delimiter) must
  // be exact-equality matches so labels that are just the cited number
  // with no trailing prose still resolve.
  const prefixMatchers: string[] = [];
  const exactMatchers: string[] = [];
  for (const cand of candidates) {
    prefixMatchers.push(`${labelUpper} ${cand}:`);
    prefixMatchers.push(`${labelUpper} ${cand} `);
    exactMatchers.push(`${labelUpper} ${cand}`);
  }
  function firstSection(node: CorpusTreeNode): CorpusTreeNode | null {
    if (node.kind === "section" && node.ref) return node;
    if (node.kids) {
      for (const k of node.kids) {
        const r = firstSection(k);
        if (r) return r;
      }
    }
    return null;
  }
  const stack: CorpusTreeNode[] = [...moduleRoot.kids];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (
      node.kind === "chapter" &&
      (prefixMatchers.some((p) => node.code.startsWith(p)) ||
        exactMatchers.some((e) => node.code === e))
    ) {
      const leaf = firstSection(node);
      if (leaf?.ref) {
        try {
          return parseRef({ module, section: leaf.ref.sectionId });
        } catch {
          // Fall through to next match if ref parse fails.
        }
      }
    }
    if (node.kids) for (const k of node.kids) stack.push(k);
  }
  return null;
}
