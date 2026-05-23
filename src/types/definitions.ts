import { z } from "zod";
import { DefinedTermSchema, SectionIdSchema } from "./identifiers";
import { ScopeExprSchema } from "./scope";

// ─── Legacy per-module definitions map (L0) ────────────────────────────────
//
// DefinitionsFile is the existing wire shape: a term → [{defined_in_section}]
// dict, one file per module, joined per-section at load time by the renderer.
// L2a will dual-write the canonical Definition[] alongside this map; L2b
// will remove DefinitionsFile entirely once every reader is cut over to
// def_id lookups. Kept here unchanged so L1 ships zero behavior delta.

export const DefinitionEntrySchema = z
  .object({
    defined_in_section: SectionIdSchema,
  })
  .strict();

// Keys are TERMS (DefinedTermSchema), not SectionIdSchema. Every term in
// the map is defined in at least one section, so the value array is
// .min(1); the same term defined across multiple sections produces an
// array length > 1.
export const DefinitionsFileSchema = z.record(
  DefinedTermSchema,
  z.array(DefinitionEntrySchema).min(1),
);

export type DefinitionEntry = z.infer<typeof DefinitionEntrySchema>;
export type DefinitionsFile = z.infer<typeof DefinitionsFileSchema>;

// ─── Canonical Definition record (L1) ──────────────────────────────────────
//
// Definition is the addressable, scoped, anchored unit the L1+ graph uses.
// Every defining provision earns a stable id (sha8 of the canonical term,
// so L3 pattern expansion doesn't invalidate L1 ids — see §9 L1 of the
// definitions-foundation plan). Resolution at L2a is build-time and
// per-occurrence: each defined_term body segment carries a def_id that
// points into this set.
//
// Fields here populate as the build pipeline gains the corresponding
// extractors (L2a writes the full record from the parser; L1 only
// establishes the schema). No runtime code reads the canonical record
// yet — the L0 DefinitionsFile path remains authoritative for tooltips
// until L2b cutover.

// DefinitionIds are <module>/<section>#<sha8-of-canonical-term>. The sha8
// makes the id stable across L3 pattern additions (adding new extraction
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

// body_anchor is a char-offset range into the definer section's `text`
// field. The parser already tracks these positions at extraction time,
// so no SegmentId invention is needed (see §9 L2 of the plan). The
// renderer maps offsets back to a body segment at popover time. Bounds
// checks live in superRefine on Definition — start ≤ end is enforced
// here; end ≤ text.length and the substring-equals-term invariant land
// at the SectionFile-level validator in L2a, where both the section
// text and its Definition[] are visible together.
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
// lowercase-kebab tokens, matching §3.1.1 of the plan: most pattern
// extractors use three tokens (amlegal:pattern:shall-mean), while
// manifest-declared globals use two (manifest:declared-global). Kept
// as a permissive string (not an enum) so the L3 pattern-expansion PR
// can add new extractor names without a schema-version bump round-trip.
const EXTRACTED_BY_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;
const ExtractedBySchema = z
  .string()
  .regex(EXTRACTED_BY_RE, "must be colon-separated lowercase-kebab tokens with at least one colon");

// Definition is the canonical, addressable record. Each instance is what
// L2a writes into module.definitions[]; each defined_term body segment
// carries the def_id of its resolved target. Cross-field invariants
// (term-substring match at body_anchor) belong at the SectionFile level
// where both the section text and its Definition[] are visible — those
// land alongside L2a as part of the module-level validator.
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
// module. L2a writes this as part of the dual-write step; L2b makes it
// the only definitions wire shape and removes DefinitionsFile. Uniqueness
// refinement catches extractor bugs before they corrupt the loader: the
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
// so the L2a extractor and any id-shape test agree on field order and
// separator characters.
export function formatDefinitionId(moduleId: string, sectionId: string, termSha8: string): string {
  return `${moduleId}/${sectionId}#${termSha8}`;
}
