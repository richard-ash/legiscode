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

// SourceConfig describes where the build pipeline reads its bytes
// from and which format-parser handles them. snapshot_at is an
// optional ISO 8601 hint the scheduled fetcher writes after each
// download; sync-corpus uses it as the default --snapshot-at when
// the CLI flag is absent. The traversal-escape guard on path runs
// both at schema-parse time (here) and at filesystem-resolve time in
// sync-corpus.ts.
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

// DisplayRules — minimum-shape DSL that lets the build-time binder
// turn cite text ("Section 102A of the Building Code") into a
// candidate anchor_id ("b102a") for the target module's anchor index.
// Four first-class knobs plus an escape hatch:
//
//   prefix              — single-letter or short tag prepended to the
//                         numeric section ref ("102A" with prefix "b"
//                         becomes "b102a"). null means no prefix —
//                         sf-charter's bare-numeric primary form.
//   extra_prefixes      — additional prefixes the binder also tries
//                         when `prefix` misses. The pattern recurs
//                         across sf-charter (appendix-A as "a",
//                         appendix-D as "d"), sf-building (Green
//                         Building Division 4-x as "g"), sf-park
//                         (chapter-11A appendix as "11a").
//   alpha_suffix        — when true, the regex captures a trailing
//                         single letter on the section ref ("102A" not
//                         "102"). Required for sf-building's chapter
//                         1A series.
//   strip_trailing_zero — when true, ".0" at the end of the section ref
//                         is collapsed ("109.0" ↔ "109"). sf-plumbing's
//                         AmLegal anchors drop the trailing zero
//                         (JD_P109, not JD_P109.0).
//   override_regex      — last-resort escape hatch. The DSL grows by
//                         observed repetition: a pattern living here
//                         that recurs across >1 module gets promoted
//                         to a first-class knob.
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
// inference ("as used in this Chapter") is intentionally NOT
// supported, because a false declared-global is worse than no
// popover. Operator-maintained manifests can add entries here without
// a schema-version bump round-trip.
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

// BillLabel — jurisdiction-specific user-facing strings for the
// proposed-amendment object. Internally we call this object a Bill
// (generic across SF / CA / federal), but each jurisdiction has its own
// vocabulary (SF: "Ordinance · Ord.", CA: "Bill · AB/SB", US House: "Bill
// · H.R."). The renderer reads these strings every time it surfaces a
// pending-bill row so no jurisdiction sees an out-of-place label.
//
// citation_format is a simple {abbr}/{file_no} template (no general-purpose
// string interpolation surface, so this stays a plain string the renderer
// processes with a fixed two-token replace).
export const BillLabelSchema = z
  .object({
    singular: z.string().min(1),
    plural: z.string().min(1),
    abbreviation: z.string().min(1),
    citation_format: z.string().min(1),
  })
  .strict();

export type BillLabel = z.infer<typeof BillLabelSchema>;

// PendingBillSource — Lane 1 fetcher input. format names which parser path
// the fetcher uses (today only legistar-search-html is supported; CA's
// CalMatters-style API and other future surfaces join the union as their
// scrapers land). url is the canonical search page; snapshot_at is the
// scrape-run wall clock the Lane 1 fetcher writes after each successful
// run (mirrors source.snapshot_at on the corpus side).
export const PendingBillSourceFormatSchema = z.enum(["legistar-search-html"]);

export const PendingBillSourceSchema = z
  .object({
    format: PendingBillSourceFormatSchema,
    url: z.url(),
    snapshot_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type PendingBillSource = z.infer<typeof PendingBillSourceSchema>;

// LegislativeSession — the political-event window the bill surface
// filters against. A bill belongs to the session if its introduced_at
// falls inside `current.start..current.end` (inclusive). SF runs a
// 2-year Board cycle aligned with even-year elections; cycle_months
// captures that as a shape invariant the scraper can sanity-check at
// jurisdiction-install time (no rolling-window mode supported — D1).
//
// `label` is the user-facing range string ("2025–2026") the Activity
// panel header can interpolate without re-deriving it from the date
// pair. Kept as a manifest-declared string (not auto-formatted) so a
// jurisdiction can use its own typographic conventions (en dash vs.
// hyphen vs. slash).
export const LegislativeSessionSchema = z
  .object({
    current: z
      .object({
        start: z.iso.date(),
        end: z.iso.date(),
        label: z.string().min(1),
      })
      .strict()
      .refine((c) => c.start < c.end, {
        message: "legislative_session.current.start must precede current.end",
      }),
    cycle_months: z.number().int().positive(),
  })
  .strict();

export type LegislativeSession = z.infer<typeof LegislativeSessionSchema>;

// JurisdictionManifest is the build input. source declares where the bytes
// come from and how to parse them; modules[] declares which codes inside
// that source should become installable modules. The slicer locates each
// module's region by code_title (and jd_anchor for amlegal-html).
//
// pending_bill_source + bill_label + legislative_session are optional —
// jurisdictions that don't publish pending-bill data (or don't have a
// Bill renderer yet) omit them and the bill-related UI surfaces hide
// entirely (per feedback_no_placeholder_ui). When pending_bill_source IS
// declared, legislative_session is required cross-field — the scraper
// post-filter needs the window to bound the bill set, and the panel
// header copy needs the label.
export const JurisdictionManifestSchema = z
  .object({
    jurisdiction: z.string().min(1),
    source: SourceConfigSchema,
    parser_strategy: ParserStrategySchema,
    modules: z.array(ModuleConfigSchema).min(1),
    pending_bill_source: PendingBillSourceSchema.optional(),
    legislative_session: LegislativeSessionSchema.optional(),
    bill_label: BillLabelSchema.optional(),
  })
  .strict()
  .refine((m) => m.pending_bill_source === undefined || m.legislative_session !== undefined, {
    message: "jurisdiction with pending_bill_source must also declare legislative_session",
    path: ["legislative_session"],
  })
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
