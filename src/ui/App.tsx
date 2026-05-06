// Root component — orchestrates corpus loading and the workbench
// openItems state. Owns: corpus IPC, BootOverlay branching for crash /
// corpus errors, persistence cold-start (legacy migration runs through
// `@/persistence` Layer 1), and the palette toggle. Workbench mutators
// (`openItem`, `openItemWithoutSwitching`) are dispatched via functional
// `setOpenItems` updates so closure-based deps stay stable.

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/app/api";
import { type CorpusRef, corpusRefFromWire, corpusRefToWire, hash as refHash } from "@/corpus/refs";
import type {
  CorpusError,
  CorpusModuleSummary,
  CorpusSectionView,
  CorpusTreeNode,
} from "@/corpus/wire";
import { readOpenItems, writeOpenItems } from "@/persistence";
import { SectionView } from "@/ui/center-panel/section-view";
import { ActivityBar } from "@/ui/chrome/activity-bar";
import { BootOverlay } from "@/ui/chrome/boot-overlay";
import { Breadcrumb } from "@/ui/chrome/breadcrumb";
import { CommandPalette } from "@/ui/chrome/command-palette";
import { StatusBar } from "@/ui/chrome/status-bar";
import { TitleBar } from "@/ui/chrome/title-bar";
import { ThreePanel } from "@/ui/layout/three-panel";
import { FileTree } from "@/ui/left-panel/file-tree/file-tree";
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [crashed, setCrashed] = useState(false);

  // Detect renderer recovery — main.ts appends ?recovered=1 after crash.
  useEffect(() => {
    if (window.location.search.includes("recovered=1")) setCrashed(true);
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
        if (state.items.length === 0) {
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
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api().corpus.read(corpusRefToWire(active.ref));
        if (cancelled) return;
        if (r.ok) setSection(r.value);
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

  // ⌘P palette toggle.
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
  const center: ReactNode = (
    <div className="lc-center">
      <Breadcrumb parents={section?.parents ?? []} sectionLabel={sectionLabel} />
      <SectionView view={section} parentsLabel={parentsLabel} />
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
