// Public surface of the @/parser module. Consumers must import from here,
// not from individual files inside src/parser/. See docs/ARCHITECTURE.md.
//
// The deep-module discipline: everything inside src/parser/ — the rbox
// classifier, the per-kind raw parsers, citation/defined-term extraction,
// the references/definitions graph computers, slugification — is private.
// A future contributor adding NYC support, Legistar support, or rewriting
// the SF parser, only touches files inside src/parser/. The public surface
// here does not change.
//
// If you find yourself needing to expose a helper, ask first whether the
// orchestration belongs INSIDE the module instead. Most "I need
// extractCitations from outside" answers are actually "you need a fatter
// ParsedModule field."

// ParsedModule and ParseWarning are contract types between parser and
// storage; they live in @/types so both modules can depend on the contract
// layer instead of each other. Re-exported here so consumers reaching for
// "the parser's result type" find it via the parser barrel.
export type { ParsedModule, ParseWarning } from "@/types";
export { CitationPatternError } from "./citations";
export { DefinedTermPatternError } from "./defined-terms";
export { ParseAbortError } from "./parse-html";
export { parseExport } from "./pipeline";
export type {
  CitationReport,
  CorpusValidationResult,
  DuplicateSectionId,
  NewlyVagueByReason,
  PerModuleValidation,
  TocCoverageReport,
  UnresolvedCitation,
} from "./validate-corpus";
export { validateCorpus } from "./validate-corpus";
