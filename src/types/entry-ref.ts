import { z } from "zod";
import { CorpusEntryKindSchema } from "./corpus-meta";
import { ModuleIdSchema } from "./identifiers";

// EntryRef is a polymorphic pointer at any CorpusEntry across any module.
// Used in references.json's cited_by arrays so that cross-module and
// cross-kind citation edges can be represented uniformly.
//
// module_id is required (not optional). The references graph spans modules
// (a Section in module A can be cited by a Section in module B via the
// editorial InterCodeLink graph), so every EntryRef carries enough context
// to resolve without external state.
export const EntryRefSchema = z
  .object({
    module_id: ModuleIdSchema,
    kind: CorpusEntryKindSchema,
    id: z.string().min(1),
  })
  .strict();

export type EntryRef = z.infer<typeof EntryRefSchema>;
