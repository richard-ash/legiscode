import { z } from "zod";

// SourceLocation pinpoints where in the source bytes a corpus entry came
// from. Used by Section, Appendix, OrdinanceHistory, ResolutionHistory,
// LegalInstrumentEntry, and Figure for skip-reason diagnostics and to power
// "show me this in the original source" UI in the future.
export const SourceLocationSchema = z
  .object({
    line: z.number().int().positive(),
    byte_offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SourceLocation = z.infer<typeof SourceLocationSchema>;
