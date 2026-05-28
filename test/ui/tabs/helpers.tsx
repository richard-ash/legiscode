// @vitest-environment jsdom
/// <reference lib="dom" />

import { useCallback, useState } from "react";
import { type CorpusRef, parse as corpusRefParse } from "@/corpus/refs";
import type { CorpusTreeNode } from "@/corpus/wire";
import { buildTitleMap, TabStrip } from "@/ui/tabs/tab-strip";
import { useTabs } from "@/ui/tabs/use-tabs";
import type { NavigationIntent } from "@/workbench/navigate";
import {
  emptyOpenItems,
  type OpenItem,
  type OpenItemsState,
  openItem,
} from "@/workbench/open-items";

export const refA = corpusRefParse({ module: "m", section: "10.04.020" });
export const refB = corpusRefParse({ module: "m", section: "10.04.040" });
export const refC = corpusRefParse({ module: "m", section: "12.01.005" });

export function makeStateWithRefs(refs: CorpusRef[]) {
  let s: OpenItemsState = emptyOpenItems();
  for (const r of refs) s = openItem(s, r);
  return s;
}

const TREE: CorpusTreeNode[] = [
  {
    id: "m",
    code: "Code",
    name: "Demo Code",
    kind: "code",
    kids: [
      {
        id: "m::10.04.020",
        code: "§ 10.04.020",
        name: "Sales tax",
        kind: "section",
        ref: { moduleId: "m", sectionId: "10.04.020" },
      },
      {
        id: "m::10.04.040",
        code: "§ 10.04.040",
        name: "Use tax",
        kind: "section",
        ref: { moduleId: "m", sectionId: "10.04.040" },
      },
      {
        id: "m::12.01.005",
        code: "§ 12.01.005",
        name: "Definitions",
        kind: "section",
        ref: { moduleId: "m", sectionId: "12.01.005" },
      },
    ],
  },
];

const TITLE_MAP = buildTitleMap(TREE);

export interface TabHostProps {
  initial: OpenItemsState;
  /** Spy on state mutations for assertions. */
  onState?: (s: OpenItemsState) => void;
}

export function TabHost({ initial, onState }: TabHostProps) {
  const [state, setState] = useState<OpenItemsState>(initial);
  const setOpenItems = useCallback(
    (update: OpenItemsState | ((prev: OpenItemsState) => OpenItemsState)) => {
      setState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        if (onState) onState(next);
        return next;
      });
    },
    [onState],
  );
  const navigate = useCallback(
    (item: OpenItem, _intent: NavigationIntent) => {
      if (item.kind !== "section") return;
      setOpenItems((prev) => openItem(prev, item.ref));
    },
    [setOpenItems],
  );
  const { close, closeOthers, closeToRight, closeAll } = useTabs({
    openItems: state,
    setOpenItems,
    navigate,
  });
  if (state.items.length === 0) return null;
  return (
    <TabStrip
      openItems={state}
      setOpenItems={setOpenItems}
      titleMap={TITLE_MAP}
      closeAt={close}
      closeOthers={closeOthers}
      closeToRight={closeToRight}
      closeAll={closeAll}
    />
  );
}
