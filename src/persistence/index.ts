// Public surface of @/persistence — Layer 1 of the feat/file-tree
// foundation. The single module behind the namespace is `storage.ts`;
// `feat/sqlite-state` (Phase 6) replaces the implementation without
// changing the exported names.

export {
  getStorageBackend,
  listOwnedKeys,
  PersistedOpenItemsSchema,
  readOpenItems,
  readTheme,
  removeOpenItems,
  ThemeSchema,
  writeOpenItems,
  writeTheme,
} from "./storage";
export type { PersistedOpenItem, PersistedOpenItems, Theme } from "./storage";
