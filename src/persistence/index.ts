// Public surface of @/persistence — Layer 1 of the feat/file-tree
// foundation. The single module behind the namespace is `storage.ts`;
// `feat/sqlite-state` (Phase 6) replaces the implementation without
// changing the exported names.

export {
  getStorageBackend,
  LineHeightMultSchema,
  listOwnedKeys,
  PersistedOpenItemsSchema,
  readLineHeightMult,
  readOpenItems,
  readTheme,
  removeOpenItems,
  ThemeSchema,
  writeLineHeightMult,
  writeOpenItems,
  writeTheme,
} from "./storage";
export type {
  LineHeightMult,
  PersistedOpenItem,
  PersistedOpenItems,
  Theme,
} from "./storage";
