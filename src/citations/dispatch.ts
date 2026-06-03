// Citation-dispatch hook: bundles the build-existence / resolve /
// activate triad App used to own inline. The hook takes the inputs it
// needs (corpus, active section, indices, navigation) and returns the
// two callbacks the renderer surface consumes.
//
// Two reasons this earns its own module:
//   1. App previously owned 110 LOC of citation glue — three named
//      callbacks all coupling corpus / section / titleMap into the same
//      resolver call. Moving them here lets App stop reading like a
//      citations file.
//   2. The build-existence shape is the resolver's contract; keeping
//      its construction next to the resolver consumer (not in App)
//      makes the file you have to read when changing the cite path
//      a single one.

import { useCallback } from "react";
import { type CorpusExistence, resolve } from "@/citations/resolver";
import { findStructuralRef } from "@/citations/structural-resolver";
import { type CorpusRef, parse as parseRef, hash as refHash } from "@/corpus/refs";
import type { CorpusModuleSummary, CorpusSectionView, CorpusTreeNode } from "@/corpus/wire";
import { type ModuleId, ModuleIdSchema } from "@/types";
import type { Citation } from "@/types/citation";
import type { OpenItem } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";

export interface UseCitationDispatchInputs {
  corpus: CorpusModuleSummary | null;
  section: CorpusSectionView | null;
  installedModules: ReadonlySet<ModuleId>;
  titleMap: ReadonlyMap<string, CorpusTreeNode>;
  navigate: (item: OpenItem, intent: NavigationIntent, options?: { subsection?: string }) => void;
  requestScroll: (req: { subsection: string; targetSectionKey: string }) => void;
}

export interface CitationDispatch {
  resolveCitation: (citation: Citation) => ReturnType<typeof resolve> | null;
  onCitationActivate: (citation: Citation, intent: NavigationIntent) => void;
}

export function useCitationDispatch(inputs: UseCitationDispatchInputs): CitationDispatch {
  const { corpus, section, installedModules, titleMap, navigate, requestScroll } = inputs;

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
          // Should never fire from committed corpus data — the
          // build-time binder gate refuses to ship unbindable cites,
          // and the dispatcher upstream filters vague targets. A fire
          // here means a regression leaked one past. Loud-log only;
          // no toast in v1 — the gate is the user-facing signal.
          console.error(`[citations] unresolvable: ${result.reason}`);
          return;
        }
      }
    },
    [buildExistence, section, navigate, requestScroll],
  );

  return { resolveCitation, onCitationActivate };
}
