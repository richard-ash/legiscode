import { z } from "zod";
import { ModuleIdSchema } from "./identifiers";

// ScopeExpr is the explicit, serialized scope for every canonical
// Definition record. Three discriminants:
//
//   hierarchy    — applies to every section whose hierarchy chain starts
//                  with `prefix`. Mirrors the parser's existing
//                  hierarchy_prefix semantics: definitions in
//                  §401 [Housing Code, Preface, Chapter 4 Definitions]
//                  scope to every section under that prefix. The array
//                  shape matches the loader's existing per-section
//                  hierarchy walk; L2a's resolver consumes it directly.
//   module       — applies to the entire module. Manifest-declared only,
//                  never inferred from prose — see L5 in the plan
//                  (richardash-feat-definitions-foundation-plan-20260522).
//                  Definitions with module scope carry
//                  extracted_by: "manifest:declared-global".
//   cross_module — typed slot only. No extractor emits this in the L1–L3
//                  scope; reserved so the post-L3 follow-up plan doesn't
//                  need a schema-version round-trip when it ships the
//                  cross-module extractor. Mirrors how
//                  CrossModuleTargetSchema (citation) shipped before any
//                  extractor emitted cross-module citations.
const ScopeHierarchySchema = z
  .object({
    kind: z.literal("hierarchy"),
    // prefix is the ordered hierarchy chain of the definer section
    // (e.g. ["Housing Code", "Preface", "Chapter 4 Definitions"]).
    // Empty array means "applies module-wide via hierarchy walk", which
    // is semantically equivalent to {kind:"module"} but is reserved for
    // the resolver's degenerate top-of-hierarchy case. Manifest globals
    // should emit {kind:"module"} explicitly.
    prefix: z.array(z.string().min(1)),
  })
  .strict();

const ScopeModuleSchema = z
  .object({
    kind: z.literal("module"),
  })
  .strict();

const ScopeCrossModuleSchema = z
  .object({
    kind: z.literal("cross_module"),
    module_id: ModuleIdSchema,
  })
  .strict();

export const ScopeExprSchema = z.discriminatedUnion("kind", [
  ScopeHierarchySchema,
  ScopeModuleSchema,
  ScopeCrossModuleSchema,
]);

export type ScopeExpr = z.infer<typeof ScopeExprSchema>;
