import { z } from "zod";
import { DefinedTermSchema, SectionIdSchema } from "./identifiers";
import { ScopeExprSchema } from "./scope";

// ─── Canonical Definition record ───────────────────────────────────────────
//
// Definition is the addressable, scoped, anchored unit of the
// definitions graph. Every defining provision earns a stable id (sha8
// of the canonical term, so adding new extraction patterns doesn't
// invalidate previously-persisted ids). Resolution is build-time and
// per-occurrence: each defined_term body segment carries a def_id
// that points into this set; the loader reads definitions-v2.json and
// projects per-section.

// DefinitionIds are <module>/<section>#<sha8-of-canonical-term>. The
// sha8 makes the id stable across pattern additions (new extraction
// patterns shouldn't renumber existing ids). The format is verifiable
// without parsing — a single regex catches the shape, and downstream
// code can split on '/' and '#' to recover the components.
//
// Examples:
//   sf-housing/h401#a1b2c3d4
//   sf-charter/c-101#deadbeef
export const DEFINITION_ID_RE = /^[a-z][a-z0-9-]*\/[a-z0-9]+(?:[._-][a-z0-9]+)*#[0-9a-f]{8}$/;
export const DefinitionIdSchema = z
  .string()
  .regex(DEFINITION_ID_RE, "must be <module>/<section>#<sha8> with lowercase hex digest");

export type DefinitionId = z.infer<typeof DefinitionIdSchema>;

// body_anchor is a char-offset range into the definer section's
// `text` field. The parser already tracks these positions at
// extraction time, so no SegmentId invention is needed. The renderer
// maps offsets back to a body segment at popover time. Bounds checks
// live in superRefine on Definition — start ≤ end is enforced here;
// end ≤ text.length and the substring-equals-term invariant land at
// the SectionFile-level validator, where both the section text and
// its Definition[] are visible together.
const BodyAnchorSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((a) => a.start <= a.end, {
    message: "body_anchor.start must be <= body_anchor.end",
  });

export type BodyAnchor = z.infer<typeof BodyAnchorSchema>;

// extracted_by tags the provenance source so coverage audits can group
// definitions by extractor. Format is one-or-more colon-separated
// lowercase-kebab tokens: most pattern extractors use three tokens
// (amlegal:pattern:shall-mean), while manifest-declared globals use
// two (manifest:declared-global). Kept as a permissive string (not
// an enum) so new extractor names can be added without a schema-
// version bump round-trip.
const EXTRACTED_BY_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;
const ExtractedBySchema = z
  .string()
  .regex(EXTRACTED_BY_RE, "must be colon-separated lowercase-kebab tokens with at least one colon");

// Definition is the canonical, addressable record. Each instance is
// what the build pipeline writes into module.definitions[]; each
// defined_term body segment carries the def_id of its resolved
// target. Cross-field invariants (term-substring match at body_anchor)
// belong at the SectionFile level where both the section text and its
// Definition[] are visible — those land alongside the module-level
// validator.
export const DefinitionSchema = z
  .object({
    id: DefinitionIdSchema,
    term: DefinedTermSchema,
    defined_in: SectionIdSchema,
    body_anchor: BodyAnchorSchema,
    excerpt: z.string().min(1),
    scope: ScopeExprSchema,
    extracted_by: ExtractedBySchema,
  })
  .strict();

export type Definition = z.infer<typeof DefinitionSchema>;

// ModuleDefinitionsSchema is the canonical Definition[] wire shape per
// module — persisted as definitions-v2.json. Uniqueness refinement
// catches extractor bugs before they corrupt the loader: the
// sha8(term) + section pair guarantees per-module uniqueness when the
// extractor is correct.
export const ModuleDefinitionsSchema = z.array(DefinitionSchema).superRefine((defs, ctx) => {
  const seen = new Set<string>();
  for (let i = 0; i < defs.length; i++) {
    const id = defs[i]?.id;
    if (id === undefined) continue;
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "id"],
        message: `duplicate Definition.id ${JSON.stringify(id)} within module`,
      });
    }
    seen.add(id);
  }
});

export type ModuleDefinitions = z.infer<typeof ModuleDefinitionsSchema>;

// formatDefinitionId composes the canonical wire form from its parts.
// The sha8 input is sha256(canonical_term).slice(0,8); callers are
// responsible for canonicalizing the term (whitespace-normalized, case
// as written) before hashing. Kept here as the single source of truth
// so the extractor and any id-shape test agree on field order and
// separator characters.
export function formatDefinitionId(moduleId: string, sectionId: string, termSha8: string): string {
  return `${moduleId}/${sectionId}#${termSha8}`;
}
