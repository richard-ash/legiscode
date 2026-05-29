// Kind dispatcher for the active tab's body. Today only `section` has a
// renderer; `chat` (future, feat/ai-agent) emits a console.warn and
// renders null until #13 ships the panel. The exhaustive switch is the
// extension point — adding a new kind anywhere else in the renderer is a
// type error.
//
// Plan CQ5 (codex F9: warn + null rather than throw — a missing renderer
// shouldn't crash the user's workbench).

import type { ReactNode } from "react";
import type { ResolutionResult } from "@/citations/resolver";
import type { CorpusRef } from "@/corpus/refs";
import type { CorpusError, CorpusSectionView } from "@/corpus/wire";
import type { Citation } from "@/types/citation";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import { SettingsPage } from "@/ui/settings/settings-page";
import type { NavigationIntent } from "@/workbench/navigate";
import { itemIdentity, type OpenItem } from "@/workbench/open-items";

export interface TabContentProps {
  item: OpenItem;
  section: CorpusSectionView | null;
  sectionError: CorpusError | null;
  parentsLabel: string;
  /** Tab-dispatch primitive forwarded to SectionView for defined-term jumps
   *  and redesignated redirect links. */
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
  /** Citation dispatch — pass-through to SectionView. Optional today
   *  because not every consumer (some tests) needs to assert the seam. */
  onCitationActivate?: (citation: Citation, intent: NavigationIntent) => void;
  /** Resolves a citation for the hover popover. Pass-through to SectionView. */
  resolveCitation?: (citation: Citation) => ResolutionResult | null;
  /** Synchronous (title, excerpt) lookup keyed by the resolved target's
   *  ref — feeds the hover popover's title + body excerpt. Pass-through. */
  getCitationPreview?: (ref: CorpusRef) => { title: string; excerpt?: string } | null;
  /** Callback ref handed to SectionView's scroll container so the parent
   *  can drive per-tab scroll restoration via the use-tabs hook. */
  scrollContainerRef?: (el: HTMLElement | null) => void;
  /** Called on every scroll event for the active section. */
  onScrollY?: (y: number) => void;
}

export function TabContent({
  item,
  section,
  sectionError,
  parentsLabel,
  navigate,
  onCitationActivate,
  resolveCitation,
  getCitationPreview,
  scrollContainerRef,
  onScrollY,
}: TabContentProps): ReactNode {
  switch (item.kind) {
    case "section": {
      // Derive both ids from itemIdentity — the same source Tab uses for
      // its `id`/`aria-controls` (via tabSortableId). Building them
      // independently here previously produced `tabpanel-section:<ref>`
      // while Tab emitted `tabpanel-section::<ref>` (itemIdentity prefixes
      // `section::`), so aria-controls/aria-labelledby pointed at ids that
      // didn't exist and the tab↔panel relationship was severed for AT.
      const identity = itemIdentity(item);
      const tabPanelId = `tabpanel-${identity}`;
      const tabId = `tab-${identity}`;
      // role=tabpanel is folded onto SectionView's .lc-doc directly
      // rather than wrapping in a <section> — a wrapper element breaks
      // the .lc-center flex chain that pins TabStrip + Breadcrumb.
      return (
        <SectionView
          view={section}
          parentsLabel={parentsLabel}
          error={sectionError}
          navigate={navigate}
          onCitationActivate={onCitationActivate}
          resolveCitation={resolveCitation}
          getCitationPreview={getCitationPreview}
          scrollContainerRef={scrollContainerRef}
          onScrollY={onScrollY}
          tabPanel={{ id: tabPanelId, labelledBy: tabId }}
        />
      );
    }
    case "settings": {
      const identity = itemIdentity(item);
      return (
        <SettingsPage
          section={item.section}
          tabPanel={{ id: `tabpanel-${identity}`, labelledBy: `tab-${identity}` }}
        />
      );
    }
    case "chat": {
      // Future: feat/ai-agent (#13) replaces this with <ChatPanel />.
      console.warn(`[tabs] no renderer for kind=chat yet (chatId=${item.chatId})`);
      return null;
    }
  }
}
