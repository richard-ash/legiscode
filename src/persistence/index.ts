// Public surface of @/persistence. The single module behind the
// namespace is `storage.ts`; a future sqlite-backed implementation
// will swap in behind the exported names.

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
