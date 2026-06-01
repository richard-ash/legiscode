// Public surface of @/persistence — Layer 1 of the feat/file-tree
// foundation. The single module behind the namespace is `storage.ts`;
// `feat/sqlite-state` (Phase 6) replaces the implementation without
// changing the exported names.

export type {
  ActivityPaneState,
  LineHeightMult,
  PersistedOpenItem,
  PersistedOpenItems,
  Theme,
} from "./storage";
export {
  ActivityPaneStateSchema,
  getStorageBackend,
  LineHeightMultSchema,
  listOwnedKeys,
  PersistedOpenItemsSchema,
  readActivityPaneState,
  readLineHeightMult,
  readOpenItems,
  readTheme,
  removeOpenItems,
  ThemeSchema,
  writeActivityPaneState,
  writeLineHeightMult,
  writeOpenItems,
  writeTheme,
} from "./storage";
