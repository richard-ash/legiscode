// Kind dispatcher for the active tab's body. Today `section`, `bill`,
// `appendix`, and `settings` have renderers; `chat` is a placeholder
// that warns + renders null until the AI agent ships. The exhaustive
// switch is the extension point — adding a new kind anywhere else in
// the renderer is a type error. The warn-and-render-null fallback
// chooses crash-avoidance over loud failure for a missing renderer.

import type { ReactNode } from "react";
import type { ResolutionResult } from "@/citations/resolver";
import type { CorpusRef } from "@/corpus/refs";
import type { CorpusError, CorpusSectionView } from "@/corpus/wire";
import type { Bill } from "@/types";
import type { Citation } from "@/types/citation";
import { BillView } from "@/ui/center-panel/bill-view/bill-view";
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
  /** Every pending Bill row in the loaded corpus, sorted by
   *  (file_no, module_id). Used to render bill tabs by filtering to the
   *  active item's billId. Empty array when no module has pending bills. */
  sessionBills?: ReadonlyArray<Bill>;
  /** Resolves a module_id to its display name (e.g. "Police Code") for
   *  the bill kicker. Falls back to the module_id when unresolved. */
  lookupCodeLabel?: (moduleId: string) => string | null;
  /** Resolves a section ref to its display title for the AmendsChips
   *  surface in BillView. Returns null when the ref isn't loaded. */
  lookupSectionTitle?: (ref: CorpusRef) => string | null;
  /** Dispatches shell.openExternal for a bill's legistar_url. */
  onOpenLegistar?: (url: string) => void;
  /** Pending Bill rows affecting the active section, for the
   *  pending-rail above the body. Empty / undefined suppresses the rail. */
  pendingRailBills?: ReadonlyArray<Bill>;
  /** Opens a bill tab. Used by the section pending-rail rows. */
  onOpenBill?: (fileNo: string, mode: "primary" | "background") => void;
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
  sessionBills,
  lookupCodeLabel,
  lookupSectionTitle,
  onOpenLegistar,
  pendingRailBills,
  onOpenBill,
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
          pendingRailBills={pendingRailBills}
          onOpenBill={onOpenBill}
        />
      );
    }
    case "settings": {
      const identity = itemIdentity(item);
      return (
        <SettingsPage
          section={item.section}
          tabPanel={{ id: `tabpanel-${identity}`, labelledBy: `tab-${identity}` }}
          onNavigatePane={(pane) => navigate({ kind: "settings", section: pane }, "primary")}
        />
      );
    }
    case "bill": {
      const identity = itemIdentity(item);
      const billsForFileNo = (sessionBills ?? []).filter((b) => b.file_no === item.billId);
      const codeLabel = billsForFileNo[0]
        ? (lookupCodeLabel?.(billsForFileNo[0].module_id) ?? undefined)
        : undefined;
      return (
        <BillView
          bills={billsForFileNo}
          navigate={navigate}
          tabPanel={{ id: `tabpanel-${identity}`, labelledBy: `tab-${identity}` }}
          codeLabel={codeLabel}
          lookupSectionTitle={lookupSectionTitle}
          onOpenLegistar={onOpenLegistar}
        />
      );
    }
    case "chat": {
      // Placeholder until the AI agent ships a <ChatPanel />.
      console.warn(`[tabs] no renderer for kind=chat yet (chatId=${item.chatId})`);
      return null;
    }
  }
}
