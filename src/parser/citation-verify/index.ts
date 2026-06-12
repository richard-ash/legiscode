export type { BillClaim, BillClaimSurface } from "./bill-claims";
export { blankQuotedRegions, extractBillClaims } from "./bill-claims";
export type { ParsedAnswerCitation } from "./parse-citations";
export { extractAnswerCitations } from "./parse-citations";
export type { ParsedSourcesBlock, SourceEntry, SourceEntryKind } from "./sources-block";
export { parseSourcesBlock, splitProseAndSources } from "./sources-block";
export {
  type FetchedBill,
  type FetchedRef,
  formatSourcesBlockFailure,
  formatVerificationFailure,
  type SourcesBlockOutcome,
  type VerifyInput,
  type VerifyResult,
  type VerifySourcesBlockInput,
  verifyCitations,
  verifySourcesBlock,
} from "./verify";
