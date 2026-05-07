// Public surface of @/corpus-nav (Layer 3 of the feat/file-tree
// foundation). Pure-function primitives separated from React so tests
// run in pure Node and future filters / nav features compose without
// rewrites.

export {
  collapse,
  defaultExpansion,
  emptyExpansion,
  expand,
  isExpanded,
  toggle,
} from "./tree-model";
export type { ExpansionState } from "./tree-model";

export { __resetVisibleRowsCache, visibleRows } from "./visible-rows";
export type { Row } from "./visible-rows";

export { alwaysTrue, and, or, prefixMatch } from "./filter-predicate";
export type { Predicate } from "./filter-predicate";

export { keyboardAction } from "./keyboard-actions";
export type { Action, KeyboardState } from "./keyboard-actions";
