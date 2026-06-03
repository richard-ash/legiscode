import { z } from "zod";
import { CitationSchema } from "./citation";
import { type DefinitionId, DefinitionIdSchema } from "./definitions";
import { SectionIdSchema } from "./identifiers";

// editorial_status captures AmLegal's per-section publication state.
// "active" is the default (an enacted, in-force section). "reserved" means
// a section number is reserved for future use but currently has no body.
// "repealed" and "redesignated" mark tombstones — the section number still
// exists in the corpus but its substance moved elsewhere or was deleted.
// Combined with redirect_to, this lets the UI render the right "what
// happened to §X?" affordances rather than silently dropping the section.
export const SectionEditorialStatusSchema = z
  .enum(["active", "reserved", "repealed", "redesignated"])
  .default("active");

// ─── BodySegment discriminated union ────────────────────────────────────────
//
// `body` is the structured representation of a section's prose. The flat
// `text` field stays alongside it (search and ripgrep run against `text`;
// the renderer iterates `body` to lay out citations, definitions, formatting,
// and paragraph breaks). Both come from the same parser pass so they cannot
// drift — the body-text-roundtrip invariant test in test/parser/ enforces
// that re-flattening `body[]` reproduces `text` byte-for-byte.
//
// The shape is a discriminated union over `type`. Six variants:
//
//   text             — raw prose between annotations.
//   citation         — a recognized statutory reference. Carries `raw`
//                      (the verbatim cited string from `text`) and
//                      `citation_index` pointing into the section's
//                      `citations[]` so the renderer resolves
//                      (kind, target) without re-parsing.
//   defined_term     — an OCCURRENCE of any term in the module-wide
//                      definitions dictionary (NOT just terms defined
//                      in this section). The renderer hyperlinks each
//                      occurrence to the section that defines it. The
//                      module-wide lookup is built in pipeline.ts Pass 2
//                      before body[] is built in Pass 3, so cross-section
//                      definition references work.
//   subsection_label — paragraph-leading "(a)", "(b)(2)" markers parsed
//                      out of the body so the renderer can apply hanging
//                      indents without re-running the regex per render.
//   paragraph_break  — inline marker for paragraph boundaries. Flat —
//                      not a nested Paragraph[] wrapper. Renderer
//                      iterates once.
//   format           — inline run with a CSS-bearing style: bold,
//                      italic, list, listItem. Recursive: format
//                      children may themselves be format, citation,
//                      defined_term, etc. Format spans nest INSIDE
//                      citation/defined_term spans.
//
// ─── Overlap precedence ───────────────────────────────────────────────────
//
// When a substring of `text` matches multiple annotation types, precedence
// is strict: citation > defined_term. A single overlap arbiter
// (parser/recognize.ts:arbitrate) tiles term and citation spans together to
// enforce this; it replaced the earlier ad-hoc referee that lived inline
// in the body builder. Format spans nest inside whichever non-format span won.
//
//   text:   "see Section 1.01 ('Person')"
//                ^citation match^  ^defined_term^
//
//                              │
//                              ▼
//
//                    sort matches by start
//                              │
//                              ▼
//
//                    for each match:
//                      overlaps prior emit?
//                      ├─ prior is citation?
//                      │    skip me
//                      ├─ prior is defined_term?
//                      │    I'm citation? replace prior
//                      │    I'm defined_term? skip me
//                      └─ no overlap?
//                           emit
//
//                    citation classify failure on a span?
//                      emit raw {type:"text"} segment
//                      (NOT a defined_term fallback)
//
//                              │
//                              ▼
//
//                    BodySegment[]:
//                      text "see "
//                      citation "Section 1.01" (citation_index: 0)
//                      text " ('"
//                      defined_term "Person"
//                      text "')"
//
// Format wrapping example — `<b>§ 1.01</b>` becomes:
//   format(bold) > citation > text "§ 1.01"
// not:
//   citation > format(bold) > text "§ 1.01"
// The renderer picks up `format.style` and applies CSS to the citation
// child as a unit; reversed nesting would split the citation into two
// segments (one bolded, one not) and break click handling on the link.

const TextSegmentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const CitationSegmentSchema = z
  .object({
    type: z.literal("citation"),
    raw: z.string(),
    citation_index: z.number().int().nonnegative(),
  })
  .strict();

// DefinedTermSegment carries the per-occurrence resolution computed
// at build time: `raw` (surface form as written) and `def_id` (the
// resolved canonical Definition) are required. bodyToText emits
// `raw` and the renderer keys popover lookup off `def_id`.
//
// candidates_dropped lives on the segment, not on Definition, because
// runner-up resolution candidates vary by reader location: the same
// term may resolve to definer A in subtree X (with B dropped) and to
// B in subtree Y (with A dropped). A global field on Definition would
// conflate unrelated resolution contexts.
const DefinedTermSegmentSchema = z
  .object({
    type: z.literal("defined_term"),
    raw: z.string().min(1),
    def_id: DefinitionIdSchema,
    candidates_dropped: z.array(DefinitionIdSchema).optional(),
  })
  .strict();

const SubsectionLabelSegmentSchema = z
  .object({
    type: z.literal("subsection_label"),
    label: z.string(),
  })
  .strict();

const ParagraphBreakSegmentSchema = z
  .object({
    type: z.literal("paragraph_break"),
  })
  .strict();

// FormatSegment is structurally recursive: a format node's children may
// themselves contain format nodes. z.lazy is the standard zod recursion
// pattern. Children must be non-empty: walkRboxText drops zero-content
// spans (`<b></b>`) and normalizeBodyTextWithSpans drops spans whose
// raw positions all collapsed away, so a format wrapper with empty
// children would indicate a parser regression.
type FormatSegment = {
  type: "format";
  style: "bold" | "italic" | "list" | "listItem";
  children: BodySegment[];
};

type BodySegment =
  | { type: "text"; text: string }
  | { type: "citation"; raw: string; citation_index: number }
  | {
      type: "defined_term";
      raw: string;
      def_id: DefinitionId;
      candidates_dropped?: DefinitionId[];
    }
  | { type: "subsection_label"; label: string }
  | { type: "paragraph_break" }
  | FormatSegment;

const FormatSegmentSchema: z.ZodType<FormatSegment> = z.lazy(() =>
  z
    .object({
      type: z.literal("format"),
      style: z.enum(["bold", "italic", "list", "listItem"]),
      children: z.array(BodySegmentSchema).min(1),
    })
    .strict(),
);

const BodySegmentSchema: z.ZodType<BodySegment> = z.lazy(() =>
  z.union([
    TextSegmentSchema,
    CitationSegmentSchema,
    DefinedTermSegmentSchema,
    SubsectionLabelSegmentSchema,
    ParagraphBreakSegmentSchema,
    FormatSegmentSchema,
  ]),
);

// Walk a body[] tree (recursing into format.children) and visit every
// citation segment so the section-level superRefine can verify each
// citation_index points at a real entry in `citations[]`. Pure traversal
// helper — bound to BodySegmentSchema so segment shapes are already
// validated before this runs.
function forEachCitationSegment(
  segments: readonly BodySegment[],
  visit: (
    segment: { type: "citation"; raw: string; citation_index: number },
    path: (string | number)[],
  ) => void,
  path: (string | number)[] = [],
): void {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const here = [...path, i];
    if (seg.type === "citation") {
      visit(seg, here);
    } else if (seg.type === "format") {
      forEachCitationSegment(seg.children, visit, [...here, "children"]);
    }
  }
}

// Re-flatten a body[] tree into the raw text it represents. The schema
// asserts `bodyToText(body) === text` at the trust boundary so a stale
// or hand-edited section file cannot put the renderer (which iterates
// body[]) and search/export (which scan text) into disagreement. The
// flatten rules mirror the parser's emit order; the body-text-roundtrip
// test in test/parser/ pins the same invariant against real corpus
// output. Exported so test code uses the same definition rather than
// duplicating it.
export function bodyToText(segments: readonly BodySegment[]): string {
  let out = "";
  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        out += seg.text;
        break;
      case "citation":
        out += seg.raw;
        break;
      case "defined_term":
        out += seg.raw;
        break;
      case "subsection_label":
        out += seg.label;
        break;
      case "paragraph_break":
        out += "\n";
        break;
      case "format":
        out += bodyToText(seg.children);
        break;
    }
  }
  return out;
}

// `kind` discriminates Section files from sibling CorpusEntry kinds
// (Appendix, OrdinanceHistory, ResolutionHistory). Default makes the
// reader lenient when the field is omitted: missing-with-default parses
// fine, present-with-wrong-value fails strict validation.
//
// redirect_to is set on redesignated/repealed sections that point at a
// successor section. editorial_status discriminates the variants so the
// renderer can show "[Reserved.]", "[Repealed.]", or a redirect affordance.
//
// `body` is optional with `.default([])` so custom `--corpus-path`
// users with old `body`-less section JSON keep loading.
//
// section.id IS the canonical anchor (lowercase JD_-stripped form
// like "p109" / "b102a" / "5.102"). display_label carries the
// human-readable form readers see in headings, tabs, and breadcrumbs
// ("109.0" / "102A" / "5.102").
export const SectionFileSchema = z
  .object({
    kind: z.literal("section").default("section"),
    id: SectionIdSchema,
    display_label: z.string().min(1),
    title: z.string(),
    text: z.string(),
    citations: z.array(CitationSchema),
    defined_terms: z.array(z.string()),
    hierarchy: z.array(z.string()),
    editorial_status: SectionEditorialStatusSchema,
    redirect_to: SectionIdSchema.optional(),
    body: z.array(BodySegmentSchema).default([]),
  })
  .strict()
  .refine((s) => s.redirect_to === undefined || s.editorial_status === "redesignated", {
    message: "redirect_to is only valid when editorial_status is 'redesignated'",
    path: ["redirect_to"],
  })
  // Cross-field validation:
  //
  // 1. body[] re-flattens to text. The renderer iterates body[];
  //    search and export read text. If they diverge, the user sees
  //    a blank section while a search hit insists otherwise — exactly
  //    the corruption mode body[] was added to prevent. Assert the
  //    invariant here so a stale or hand-edited --corpus-path JSON
  //    fails closed at the trust boundary instead of silently
  //    rendering wrong.
  //
  // 2. Every citation segment's citation_index must point at a real
  //    entry in `citations[]` AND its raw text must match the
  //    indexed citation's display_text. Bounds-only is too loose:
  //    raw="§ 1.01" with citation_index=0 pointing at a citations[]
  //    entry whose display_text is "§ 2.02" would silently wire the
  //    visible text to the wrong link target. Both checks have to
  //    live here — segments don't see siblings, so nested validation
  //    in BodySegmentSchema alone can't reach `citations`.
  .superRefine((s, ctx) => {
    if (bodyToText(s.body) !== s.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "body[] does not re-flatten to text (roundtrip invariant violated)",
      });
    }
    forEachCitationSegment(s.body, (seg, path) => {
      if (seg.citation_index >= s.citations.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", ...path, "citation_index"],
          message: `citation_index ${seg.citation_index} out of range (citations.length=${s.citations.length})`,
        });
        return;
      }
      const indexed = s.citations[seg.citation_index];
      if (indexed && seg.raw !== indexed.display_text) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body", ...path, "raw"],
          message: `raw ${JSON.stringify(seg.raw)} does not match citations[${seg.citation_index}].display_text ${JSON.stringify(indexed.display_text)}`,
        });
      }
    });
  });

export type SectionEditorialStatus = z.infer<typeof SectionEditorialStatusSchema>;
export type SectionFile = z.infer<typeof SectionFileSchema>;
export type { BodySegment };
