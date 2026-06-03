// Public surface of @/corpus-nav. Pure-function primitives separated
// from React so tests run in pure Node and future filters / nav
// features compose without rewrites.

export type { Predicate } from "./filter-predicate";
export { alwaysTrue, and, or, prefixMatch } from "./filter-predicate";
export type { Action, KeyboardState } from "./keyboard-actions";
export { keyboardAction } from "./keyboard-actions";
export type { ExpansionState } from "./tree-model";
export {
  collapse,
  defaultExpansion,
  emptyExpansion,
  expand,
  isExpanded,
  toggle,
} from "./tree-model";
export type { Row } from "./visible-rows";
export { __resetVisibleRowsCache, visibleRows } from "./visible-rows";
