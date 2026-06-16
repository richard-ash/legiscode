// Bill-claim extraction — the fabrication dual of R23's omission check.
// R23 catches a memo that SKIPS an affected section; this module finds
// every section the answer ATTRIBUTES to a bill so the verifier can
// reject attributions the bill's affected_section_ids cannot back.
//
// Conservative by construction. The memo-validation workflow has the
// model quoting a flawed draft's wrong claims in order to debunk them,
// so two defenses keep debunking prose out of the claim set:
//
//   1. Quoted material never claims. Fenced code blocks and blockquote
//      lines are blanked (offset-preserving) before extraction; R25
//      tells the model to quote drafts as blockquotes.
//   2. Attribution sentences carry a negation/attribution guard: a
//      span like "the draft claims [Bill #X] amends § Y — it does not"
//      is reported speech, not the model's own claim, and is skipped.
//
// Three claim surfaces, all scoped by the caller to R20/R21-shaped
// artifacts:
//
//   A. The memo's Affected Sections listing — every section cite in
//      the region is attributed to the artifact's subject bill.
//   B. Markdown table rows — same attribution, R21's table form.
//   C. Explicit attribution sentences — "[Bill #X] amends ... § Y".

import { extractAnswerCitations } from "./parse-citations";

export type BillClaimSurface = "affected_listing" | "impact_table" | "attribution_sentence";

export interface BillClaim {
  file_no: string;
  /** Null for bare "§ X" cites — the verifier resolves those against
   *  the bill's own module. */
  module_id: string | null;
  section_id: string;
  display: string;
  surface: BillClaimSurface;
}

const BILL_CITE_RE = /\[Bill\s+#(\d{3,12})\]/gi;

const AFFECTED_HEADING_RE = /^(?:\*\*Affected Sections\*\*|#{2,4}\s+Affected Sections\b)/i;

const LIST_ITEM_RE = /^(?:[-*]\s+|\d+\.\s+)/;

const ATTRIBUTION_VERB_RE =
  /\b(amends?|adds?|repeals?|changes?|modifies|modify|revises?|rewrites?|deletes?|strikes?|touches|affects?)\b/i;

/** Reported-speech / negation markers between the bill cite and the
 *  section cite. Their presence means the sentence is quoting,
 *  correcting, or denying a claim — not making one. */
const GUARD_RE =
  /\b(claims?|asserts?|alleges?|suggests?|says|stated?|states|does\s+not|doesn'?t|not|never|incorrect\w*|erroneous\w*|wrong\w*|mistaken\w*|omits?|omitted|fails?\s+to)\b/i;

/**
 * Extract every section-level claim the body attributes to a bill.
 * `body` is the prose BEFORE the Sources block (the caller splits).
 * Returns claims deduplicated on (file_no, module_id, section_id),
 * keeping the first surface that produced each.
 */
export function extractBillClaims(body: string): BillClaim[] {
  const blanked = blankQuotedRegions(body);
  const subject = findSubjectBill(blanked);

  const claims: BillClaim[] = [];
  if (subject) {
    claims.push(...extractAffectedListingClaims(blanked, subject));
    claims.push(...extractTableClaims(blanked, subject));
  }
  claims.push(...extractAttributionSentenceClaims(blanked));

  const seen = new Set<string>();
  const out: BillClaim[] = [];
  for (const claim of claims) {
    const key = `${claim.file_no}::${claim.module_id ?? ""}::${claim.section_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

/**
 * Replace fenced code blocks and blockquote lines with spaces,
 * preserving every offset and line boundary so downstream regexes see
 * the same geometry the model wrote.
 */
export function blankQuotedRegions(text: string): string {
  // Fenced code blocks first — a "> quoted" line inside a fence is
  // already gone by the time the blockquote pass runs.
  let out = text.replace(/```[\s\S]*?(?:```|$)/g, (m) => m.replace(/[^\n]/g, " "));
  out = out
    .split("\n")
    .map((line) => (/^\s*>/.test(line) ? " ".repeat(line.length) : line))
    .join("\n");
  return out;
}

/**
 * The artifact's subject bill: the file_no cited in the R20/R21
 * heading (first 3 non-blank lines), falling back to "the only bill
 * cited anywhere in the body". Null when ambiguous — surfaces A and B
 * are skipped rather than guessed.
 */
function findSubjectBill(blankedBody: string): string | null {
  const lines = blankedBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines.slice(0, 3)) {
    if (/^##\s+(Memo:|What\s+\[Bill\s+#)/i.test(line)) {
      const m = line.match(/\[Bill\s+#(\d{3,12})\]/i);
      if (m?.[1]) return m[1];
    }
  }
  const all = new Set<string>();
  for (const m of blankedBody.matchAll(BILL_CITE_RE)) {
    if (m[1]) all.add(m[1]);
  }
  if (all.size === 1) {
    const only = all.values().next().value;
    return only ?? null;
  }
  return null;
}

/**
 * Surface A: the Affected Sections region — the heading line itself
 * plus consecutive list-item lines under it, ending at the first
 * non-blank line that isn't a list item.
 */
function extractAffectedListingClaims(blankedBody: string, subject: string): BillClaim[] {
  const lines = blankedBody.split(/\r?\n/);
  const regionLines: string[] = [];
  let inRegion = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inRegion) {
      if (AFFECTED_HEADING_RE.test(trimmed)) {
        inRegion = true;
        regionLines.push(line);
      }
      continue;
    }
    if (trimmed.length === 0) continue;
    if (LIST_ITEM_RE.test(trimmed)) {
      regionLines.push(line);
      continue;
    }
    break;
  }
  if (regionLines.length === 0) return [];
  return sectionCitesIn(regionLines.join("\n"), subject, "affected_listing");
}

/** Surface B: markdown table rows (lines starting with `|`, excluding
 *  the `| --- |` separator). */
function extractTableClaims(blankedBody: string, subject: string): BillClaim[] {
  const rows = blankedBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !/^\|[\s:|-]+\|?$/.test(l));
  if (rows.length === 0) return [];
  return sectionCitesIn(rows.join("\n"), subject, "impact_table");
}

/**
 * Surface C: explicit attribution sentences — a bill cite followed by
 * an amendment verb followed by section cites, all inside one
 * sentence. The guard regex over the span (bill cite → sentence end)
 * skips reported speech and negations.
 */
function extractAttributionSentenceClaims(blankedBody: string): BillClaim[] {
  const claims: BillClaim[] = [];
  for (const billMatch of blankedBody.matchAll(BILL_CITE_RE)) {
    const fileNo = billMatch[1];
    const start = billMatch.index;
    if (!fileNo || start === undefined) continue;
    // Sentence span: from the end of the bill cite to the next
    // sentence-ending period (NOT a dot inside "§ 19.1") or newline,
    // capped to keep the claim local.
    const from = start + billMatch[0].length;
    const rest = blankedBody.slice(from);
    const endRel = rest.search(/\.(?=\s|$)|\n/);
    const sentence = rest.slice(0, endRel === -1 ? Math.min(rest.length, 320) : endRel);
    if (sentence.length > 320) continue;
    const verbMatch = sentence.match(ATTRIBUTION_VERB_RE);
    if (!verbMatch || verbMatch.index === undefined) continue;
    // Guard window includes the line BEFORE the bill cite — reported
    // speech usually leads ("The draft claims [Bill #X] amends …").
    const lineStart = blankedBody.lastIndexOf("\n", start) + 1;
    const guardSpan = blankedBody.slice(lineStart, from) + sentence;
    if (GUARD_RE.test(guardSpan)) continue;
    const afterVerb = sentence.slice(verbMatch.index + verbMatch[0].length);
    claims.push(...sectionCitesIn(afterVerb, fileNo, "attribution_sentence"));
  }
  return claims;
}

function sectionCitesIn(text: string, fileNo: string, surface: BillClaimSurface): BillClaim[] {
  const out: BillClaim[] = [];
  for (const cite of extractAnswerCitations(text)) {
    if (cite.qualified) {
      out.push({
        file_no: fileNo,
        module_id: cite.qualified.module_id,
        section_id: cite.qualified.section_id,
        display: cite.display,
        surface,
      });
    } else if (cite.bareSectionId) {
      out.push({
        file_no: fileNo,
        module_id: null,
        section_id: cite.bareSectionId,
        display: cite.display,
        surface,
      });
    }
  }
  return out;
}
