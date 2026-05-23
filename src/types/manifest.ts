import { z } from "zod";
import { ModuleIdSchema, SectionIdSchema } from "./identifiers";

const ModuleVersionSchema = z
  .string()
  .regex(/^\d{4}\.\d{2}\.\d{2}$/, "must be a YYYY.MM.DD date version");

// SourceFormat names which parser path consumes the source bytes. Today
// only amlegal-html is supported; sfbos-html / legistar-pdf / etc. join
// the union as their respective parsers land. The enum stays additive —
// new formats extend the union, never replace existing values.
export const SourceFormatSchema = z.enum(["amlegal-html"]);

const SourcePathSchema = z
  .string()
  .min(1, "source.path must not be empty")
  .refine((value) => !value.startsWith("/"), {
    message: "source.path must be a relative path (no leading slash)",
  })
  .refine((value) => !value.split(/[\\/]/).some((segment) => segment === ".."), {
    message: "source.path must not contain '..' segments",
  });

// SourceConfig describes where the build pipeline reads its bytes from and
// which format-parser handles them. snapshot_at is an optional ISO 8601
// hint the scheduled fetcher (feat/build-pipeline) writes after each
// download; sync-corpus uses it as the default --snapshot-at when the
// CLI flag is absent. The traversal-escape guard on path runs both at
// schema-parse time (here) and at filesystem-resolve time in sync-corpus.ts.
export const SourceConfigSchema = z
  .object({
    format: SourceFormatSchema,
    path: SourcePathSchema,
    snapshot_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const CodeTitleSchema = z
  .string()
  .min(1)
  .refine((v) => v.trim() === v && v.trim().length > 0, {
    message: "code_title must be non-empty and not surrounded by whitespace",
  });

// jd_anchor matches AmLegal HTML's <a name="JD_<X>"> pattern at code roots
// (e.g. "Charter", "PublicWorks", "ZoningMaps"). Operator-curated because
// AmLegal's anchor naming isn't algorithmically derivable from code_title
// — "Business and Tax Regulations Code" maps to JD_Business, not JD_BTR.
//
// Required for amlegal-html sources via cross-field validation on the
// JurisdictionManifestSchema; optional here so non-AmLegal jurisdictions
// can omit it.
const JdAnchorSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9]*$/, "jd_anchor must be a single PascalCase token");

// parser_strategy names which strategy module in src/parser/strategies/ owns
// the markup variants for this jurisdiction. Independent from format —
// multiple jurisdictions can share format: "amlegal-html" while having
// distinct parser_strategy values for their per-jurisdiction quirks.
const ParserStrategySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "parser_strategy must be lowercase tokens with hyphens");

// DisplayRules — minimum-shape DSL that lets the build-time binder turn
// cite text ("Section 102A of the Building Code") into a candidate
// anchor_id ("b102a") for the target module's anchor index. Four
// first-class knobs plus an escape hatch per the locked principle in the
// refoundation plan (~/.gstack/projects/legiscode/richardash-feat-
// citation-resolution-pr25-refactor-plan-20260520.html § "Locked
// decisions"):
//
//   prefix              — single-letter or short tag prepended to the
//                         numeric section ref ("102A" with prefix "b"
//                         becomes "b102a"). null means no prefix —
//                         sf-charter's bare-numeric primary form.
//   extra_prefixes      — additional prefixes the binder also tries
//                         when `prefix` misses. Earns first-class
//                         status because the pattern recurs across
//                         sf-charter (appendix-A as "a", appendix-D
//                         as "d"), sf-building (Green Building
//                         Division 4-x as "g"), sf-park (chapter-11A
//                         appendix as "11a"). Promote-by-evidence per
//                         feedback_minimum_shapes.
//   alpha_suffix        — when true, the regex captures a trailing
//                         single letter on the section ref ("102A" not
//                         "102"). Required for sf-building's chapter
//                         1A series.
//   strip_trailing_zero — when true, ".0" at the end of the section ref
//                         is collapsed ("109.0" ↔ "109"). sf-plumbing's
//                         AmLegal anchors drop the trailing zero
//                         (JD_P109, not JD_P109.0).
//   override_regex      — last-resort escape hatch. The DSL grows by
//                         observed repetition (feedback_minimum_shapes):
//                         a pattern living here that recurs across >1
//                         module gets promoted to a first-class knob.
//
// The full set is optional so manifests that don't ship cross-module
// citation traffic don't have to declare it. Without display_rules the
// binder falls back to bare-numeric lookup.
const DisplayRulesSchema = z
  .object({
    prefix: z
      .string()
      .regex(/^[a-z0-9]+$/, "prefix must be lowercase letters or digits only")
      .nullable()
      .default(null),
    extra_prefixes: z
      .array(z.string().regex(/^[a-z0-9]+$/, "extra_prefix must be lowercase letters or digits"))
      .default([]),
    alpha_suffix: z.boolean().default(false),
    strip_trailing_zero: z.boolean().default(false),
    override_regex: z.string().min(1).nullable().default(null),
  })
  .strict();

export type DisplayRules = z.infer<typeof DisplayRulesSchema>;

// ModuleConfig is the per-code subset of a JurisdictionManifest. The HTML
// slicer locates each module's region by finding <a name="JD_${jd_anchor}">.
// code_title is the depth-0 hierarchy label on every emitted SectionFile.
//
// max_skip_count is the production contract on parser completeness:
// 0 means the build refuses to promote a corpus that silently dropped any
// candidate rbox. Manifests can set higher values for transitional periods,
// but production manifests should leave it at default.
// global_definer_sections lists section ids inside this module whose
// extracted definitions should scope to the entire module
// ({kind:"module"} ScopeExpr, extracted_by "manifest:declared-global"),
// instead of defaulting to the definer section's hierarchy chain. This
// is the only source of module-wide scope: prose-parsed scope-hint
// inference ("as used in this Chapter") is intentionally NOT supported,
// because a false declared-global is worse than no popover (see §9 L5
// of the definitions-foundation plan). The L3 extractor wires the
// behavior — L1 declares the slot so operator-maintained manifests can
// add entries without a schema-version bump round-trip.
export const ModuleConfigSchema = z
  .object({
    id: ModuleIdSchema,
    name: z.string().min(1),
    code_title: CodeTitleSchema,
    jd_anchor: JdAnchorSchema.optional(),
    module_version: ModuleVersionSchema,
    min_section_count: z.number().int().positive().optional(),
    max_skip_count: z.number().int().nonnegative().default(0),
    citation_patterns: z.array(z.string().min(1)),
    defined_term_patterns: z.array(z.string().min(1)),
    display_rules: DisplayRulesSchema.optional(),
    global_definer_sections: z.array(SectionIdSchema).optional(),
  })
  .strict();

// JurisdictionManifest is the build input. source declares where the bytes
// come from and how to parse them; modules[] declares which codes inside
// that source should become installable modules. The slicer locates each
// module's region by code_title (and jd_anchor for amlegal-html).
export const JurisdictionManifestSchema = z
  .object({
    jurisdiction: z.string().min(1),
    source: SourceConfigSchema,
    parser_strategy: ParserStrategySchema,
    modules: z.array(ModuleConfigSchema).min(1),
  })
  .strict()
  .refine(
    (m) => {
      const ids = m.modules.map((mod) => mod.id);
      return new Set(ids).size === ids.length;
    },
    { message: "modules[].id values must be unique within a jurisdiction" },
  )
  .refine(
    (m) => {
      const titles = m.modules.map((mod) => mod.code_title.trim().toUpperCase());
      return new Set(titles).size === titles.length;
    },
    {
      message:
        "modules[].code_title values must be unique within a jurisdiction (case-insensitive)",
    },
  )
  .refine(
    (m) => {
      if (m.source.format !== "amlegal-html") return true;
      return m.modules.every((mod) => mod.jd_anchor !== undefined);
    },
    {
      message: "every module must declare jd_anchor when source.format is amlegal-html",
      path: ["modules"],
    },
  );

// DistributedModuleManifest is what gets re-emitted into each built module
// bundle at <output>/<module-id>/manifest.json. It carries the per-module
// config plus the jurisdiction context, and deliberately omits source
// (a build-time concern with no meaning to a client installing the bundle).
export const DistributedModuleManifestSchema = z
  .object({
    id: ModuleIdSchema,
    name: z.string().min(1),
    jurisdiction: z.string().min(1),
    code_title: CodeTitleSchema,
    jd_anchor: JdAnchorSchema.optional(),
    module_version: ModuleVersionSchema,
    min_section_count: z.number().int().positive().optional(),
    citation_patterns: z.array(z.string().min(1)),
    defined_term_patterns: z.array(z.string().min(1)),
    display_rules: DisplayRulesSchema.optional(),
    global_definer_sections: z.array(SectionIdSchema).optional(),
  })
  .strict();

export type SourceFormat = z.infer<typeof SourceFormatSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type ModuleConfig = z.infer<typeof ModuleConfigSchema>;
export type JurisdictionManifest = z.infer<typeof JurisdictionManifestSchema>;
export type DistributedModuleManifest = z.infer<typeof DistributedModuleManifestSchema>;
