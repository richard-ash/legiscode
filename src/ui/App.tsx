// Root component — orchestrates corpus loading and section navigation.
// Phase 1 keeps state local to this component; feat/sqlite-state will lift
// it into a real store. The App's job is glue: chrome around a three-panel
// body, IPC plumbing, and the BootOverlay fallback when corpus load fails.

import { useCallback, useEffect, useMemo, useState } from "react";
import { readActiveSection, writeActiveSection, type ActiveRef } from "@/app/active-section";
import { api } from "@/app/api";
import type {
  CorpusError,
  CorpusModuleSummary,
  CorpusSectionView,
} from "../../electron/ipc/contract";
import { ActivityBar } from "@/ui/chrome/activity-bar";
import { BootOverlay } from "@/ui/chrome/boot-overlay";
import { Breadcrumb } from "@/ui/chrome/breadcrumb";
import { CommandPalette } from "@/ui/chrome/command-palette";
import { StatusBar } from "@/ui/chrome/status-bar";
import { TitleBar } from "@/ui/chrome/title-bar";
import { SectionView } from "@/ui/center-panel/section-view";
import { ThreePanel } from "@/ui/layout/three-panel";
import { StructureTree } from "@/ui/left-panel/structure-tree";

export function App() {
  const [corpus, setCorpus] = useState<CorpusModuleSummary | null>(null);
  const [corpusError, setCorpusError] = useState<CorpusError | null>(null);
  const [active, setActive] = useState<ActiveRef | null>(null);
  const [section, setSection] = useState<CorpusSectionView | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [crashed, setCrashed] = useState(false);

  // Detect renderer recovery — main.ts appends ?recovered=1 after crash.
  useEffect(() => {
    if (window.location.search.includes("recovered=1")) setCrashed(true);
  }, []);

  // Initial corpus load. Catches thrown bridge failures (preload missing,
  // handler crash) so they surface in BootOverlay rather than dying as
  // unhandled rejections behind an empty chrome shell.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api().corpus.list();
        if (cancelled) return;
        if (r.ok) {
          setCorpus(r.value);
          const persisted = readActiveSection();
          const initial = persisted && hasRef(r.value, persisted) ? persisted : r.value.defaultRef;
          setActive(initial);
        } else {
          setCorpusError(r.error);
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
  }, []);

  // Section read on active change. Same bridge-failure guard — if read throws
  // post-boot, the renderer is broken; bail to BootOverlay rather than show
  // the previous section under a now-disconnected tree.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await api().corpus.read(active);
        if (cancelled) return;
        if (r.ok) {
          setSection(r.value);
          writeActiveSection(active);
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
  }, [active]);

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

  const onSelect = useCallback((ref: { moduleId: string; sectionId: string }) => {
    setActive(ref);
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
                <StructureTree nodes={corpus?.tree ?? []} active={active} onSelect={onSelect} />
              </div>
            }
            center={
              <div className="lc-center">
                <Breadcrumb
                  parents={section?.parents ?? []}
                  sectionLabel={section ? `§ ${section.section.id}` : null}
                />
                <SectionView view={section} parentsLabel={parentsLabel} />
              </div>
            }
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
            onSelect(ref);
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

function hasRef(corpus: CorpusModuleSummary, ref: ActiveRef): boolean {
  // Walk the tree once to verify the ref still maps to a section. If the
  // bundled corpus rotated and the persisted section disappeared, we drop
  // the persisted state and fall back to defaultRef.
  const stack = [...corpus.tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (
      node.kind === "section" &&
      node.ref &&
      node.ref.moduleId === ref.moduleId &&
      node.ref.sectionId === ref.sectionId
    ) {
      return true;
    }
    if (node.kids) for (const k of node.kids) stack.push(k);
  }
  return false;
}
