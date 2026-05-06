// Public surface of @/workbench (Layer 4 of the feat/file-tree
// foundation). Today only `open-items.ts` lives here; future per-item
// view-state (split panes, scroll position, focus restoration) is
// expected to land as sibling modules behind the same barrel.

export {
  activeItem,
  activeSectionRef,
  closeItem,
  emptyOpenItems,
  findSectionIndex,
  fromPersisted,
  openItem,
  openItemWithoutSwitching,
  setActiveIndex,
  toPersisted,
  validateAgainstCorpus,
} from "./open-items";
export type { OpenItem, OpenItemsState } from "./open-items";
