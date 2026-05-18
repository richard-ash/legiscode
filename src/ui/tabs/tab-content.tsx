// Kind dispatcher for the active tab's body. Today only `section` has a
// renderer; `chat` (future, feat/ai-agent) emits a console.warn and
// renders null until #13 ships the panel. The exhaustive switch is the
// extension point — adding a new kind anywhere else in the renderer is a
// type error.
//
// Plan CQ5 (codex F9: warn + null rather than throw — a missing renderer
// shouldn't crash the user's workbench).

import type { ReactNode } from "react";
import type { CorpusRef } from "@/corpus/refs";
import { hash as refHash } from "@/corpus/refs";
import type { CorpusError, CorpusSectionView } from "@/corpus/wire";
import { SectionView } from "@/ui/center-panel/section-view/section-view";
import type { OpenItem } from "@/workbench/open-items";

export interface TabContentProps {
  item: OpenItem;
  section: CorpusSectionView | null;
  sectionError: CorpusError | null;
  parentsLabel: string;
  onActivate: (ref: CorpusRef) => void;
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
  onActivate,
  scrollContainerRef,
  onScrollY,
}: TabContentProps): ReactNode {
  switch (item.kind) {
    case "section": {
      const tabPanelId = `tabpanel-section:${refHash(item.ref)}`;
      const tabId = `tab-section:${refHash(item.ref)}`;
      return (
        <section role="tabpanel" id={tabPanelId} aria-labelledby={tabId}>
          <SectionView
            view={section}
            parentsLabel={parentsLabel}
            error={sectionError}
            onActivate={onActivate}
            scrollContainerRef={scrollContainerRef}
            onScrollY={onScrollY}
          />
        </section>
      );
    }
    case "chat": {
      // Future: feat/ai-agent (#13) replaces this with <ChatPanel />.
      console.warn(`[tabs] no renderer for kind=chat yet (chatId=${item.chatId})`);
      return null;
    }
  }
}
