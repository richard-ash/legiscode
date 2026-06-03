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
//                  shape matches the loader's per-section hierarchy
//                  walk; the resolver consumes it directly.
//   module       — applies to the entire module. Manifest-declared
//                  only, never inferred from prose. Definitions with
//                  module scope carry extracted_by:
//                  "manifest:declared-global".
//   cross_module — typed slot only. No extractor emits this today;
//                  reserved so a future cross-module extractor doesn't
//                  need a schema-version round-trip to land.
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
