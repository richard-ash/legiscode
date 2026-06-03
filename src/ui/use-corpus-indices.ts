// Corpus-derived lookup indices, packaged as a single hook so App
// doesn't pay for four separate useMemo / useCallback declarations.
// Every index here is keyed off `corpus` and re-derives only when the
// corpus snapshot replaces — the per-tab title / preview / module
// lookups stay stable across openItems / section / palette state
// changes.

import { useCallback, useMemo } from "react";
import { type CorpusRef, hash as refHash } from "@/corpus/refs";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { type ModuleId, ModuleIdSchema } from "@/types";
import { buildPendingBillsById, buildTitleMap } from "@/ui/tabs/tab-strip";

export interface CorpusIndices {
  /** `Map<RefHash, CorpusTreeNode>` for O(1) per-tab title lookup. */
  titleMap: ReturnType<typeof buildTitleMap>;
  /** O(1) bill-title lookup for bill tabs. Bills are not tree nodes. */
  pendingBillsById: ReturnType<typeof buildPendingBillsById>;
  /** Installed module ids — the resolver uses this to gate cross-module cites. */
  installedModules: ReadonlySet<ModuleId>;
  /** Module id → display label (e.g. "Police Code"). Drives bill kicker chrome. */
  lookupCodeLabel: (moduleId: string) => string | null;
  /** Ref → section title from titleMap. */
  lookupSectionTitle: (ref: CorpusRef) => string | null;
  /** True iff the ref appears in the loaded corpus. Used to re-validate recentlyClosed. */
  isRefInCorpus: (ref: CorpusRef) => boolean;
  /** Synchronous (title, excerpt) for the citation hover popover. */
  getCitationPreview: (
    ref: CorpusRef,
    subsection?: string,
  ) => { title: string; excerpt?: string } | null;
}

export function useCorpusIndices(corpus: CorpusModuleSummary | null): CorpusIndices {
  const titleMap = useMemo(() => buildTitleMap(corpus?.tree ?? []), [corpus]);

  const pendingBillsById = useMemo(
    () => buildPendingBillsById(corpus?.pendingBills.bills ?? []),
    [corpus],
  );

  // Display-name lookup for a module id — feeds the bill kicker
  // ("Police Code · 1st Reading"). Walks the top-level tree once and
  // memoizes; module rows live at depth 1 in the jurisdiction-rooted
  // tree.
  const codeLabelByModuleId = useMemo(() => {
    const out = new Map<string, string>();
    const stack = [...(corpus?.tree ?? [])];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.kind === "code") out.set(node.id, node.code || node.name || node.id);
      if (node.kids) for (const k of node.kids) stack.push(k);
    }
    return out;
  }, [corpus]);

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

  const lookupCodeLabel = useCallback(
    (moduleId: string): string | null => codeLabelByModuleId.get(moduleId) ?? null,
    [codeLabelByModuleId],
  );

  const lookupSectionTitle = useCallback(
    (ref: CorpusRef): string | null => {
      const node = titleMap.get(refHash(ref));
      return node?.name ?? null;
    },
    [titleMap],
  );

  // Use the title map as the corpus-validity predicate for
  // recentlyClosed re-validation. Cheap, no second tree walk.
  const isRefInCorpus = useCallback((ref: CorpusRef) => titleMap.has(refHash(ref)), [titleMap]);

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

  return {
    titleMap,
    pendingBillsById,
    installedModules,
    lookupCodeLabel,
    lookupSectionTitle,
    isRefInCorpus,
    getCitationPreview,
  };
}
