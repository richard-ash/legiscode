// Public surface of @/workbench (Layer 4 of the feat/file-tree
// foundation). Today only `open-items.ts` lives here; future per-item
// view-state (split panes, scroll position, focus restoration) is
// expected to land as sibling modules behind the same barrel.

export {
  activeItem,
  activeSectionRef,
  closeItem,
  emptyOpenItems,
  findItemIndex,
  findSectionIndex,
  fromPersisted,
  itemIdentity,
  itemsEqual,
  openItem,
  openItemWithoutSwitching,
  reorderItems,
  setActiveIndex,
  toPersisted,
  validateAgainstCorpus,
  validateRecentlyClosed,
} from "./open-items";
export type { OpenItem, OpenItemsState } from "./open-items";
