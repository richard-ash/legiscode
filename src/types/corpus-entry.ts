import { z } from "zod";
import { AppendixSchema } from "./appendix";
import { OrdinanceHistorySchema } from "./ordinance-history";
import { ResolutionHistorySchema } from "./resolution-history";
import { SectionFileSchema } from "./section";

// CorpusEntry is the discriminated union of every kind a parser may emit
// into a module bundle. Round 12 ships four kinds: Section (the existing
// substantive code text) and three sibling kinds added to model the
// editorial content AmLegal publishes alongside.
//
// Each kind carries its own `kind` discriminator literal (e.g. Section
// has `kind: "section"`); the union dispatches on that field. Consumers
// can switch over `entry.kind` exhaustively and TypeScript will narrow.
//
// The corpus_entry_kinds field in corpus-meta.json lists which kinds
// actually appear in a given bundle, so consumers can detect kind-extension
// at meta-read time without scanning every file.
export const CorpusEntrySchema = z.discriminatedUnion("kind", [
  SectionFileSchema,
  AppendixSchema,
  OrdinanceHistorySchema,
  ResolutionHistorySchema,
]);

export type CorpusEntry = z.infer<typeof CorpusEntrySchema>;
