import { z } from "zod";

// SectionIds are dotted/dashed lowercase identifiers like "10.04.020" or
// "title-10_chapter-04". Used wherever section IDs index a Record.
//
// SECTION_ID_RE is exported as the single source of truth so the parser
// can self-validate extracted ids before returning, instead of waiting
// for the downstream SectionFileSchema round-trip to surface the same
// failure with a less-specific message. See @/parser.parseSectionElement.
export const SECTION_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const SectionIdSchema = z
  .string()
  .regex(SECTION_ID_RE, "must be a dotted/dashed lowercase identifier");

// ModuleIds are kebab-case slugs like "sf-municipal" or "ca-vehicle".
export const ModuleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "must be a kebab-case slug starting with a letter");

// Defined terms are human-readable phrases used as the displayable label of
// a Definition. Whitespace invariants enforce canonical form so two captures
// of the same logical term ("Director " vs "Director") can't masquerade as
// different definitions. No length cap: legal corpora occasionally use long
// labels (e.g. "Section 41B.6 of the Administrative Code, as that Section
// 41B.6 existed as of June 3, 2019"), and extractor over-captures are inert
// in practice because the body scanner matches \b<term>\b — a runaway
// capture can only ever match its own source position.
export const DefinedTermSchema = z
  .string()
  .min(1, "must not be empty")
  .regex(/^\S(?:.*\S)?$/, "must not have leading or trailing whitespace")
  .regex(/^(?!.* {2}).*$/, "must not contain doubled internal whitespace");

export type SectionId = z.infer<typeof SectionIdSchema>;
export type ModuleId = z.infer<typeof ModuleIdSchema>;
export type DefinedTerm = z.infer<typeof DefinedTermSchema>;
