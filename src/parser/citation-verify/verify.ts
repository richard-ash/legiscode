// Citation verifier. Asserts every citation in the model's prose answer
// was deliberately fetched via a tool call THIS turn. Violations emit a
// synthetic tool_error feedback block per N13/N16 — the model self-
// corrects or writes honest prose; the renderer never sees a verifier
// state.
//
// Inputs:
//   - text: the model's final prose for this turn
//   - fetched: the union of `fetched[]` from every successful tool result
//              this turn. Failed results don't count (per N13 — error
//              outputs from the corpus aren't license to cite).
//   - anchorModule: the chat's anchored module id; resolves bare cites
//                   ("§ 1.01") against the active module first.
//
// Output:
//   - { ok: true } when every parsed citation maps to a fetched ref.
//   - { ok: false, missing } when one or more do not.
//
// Verification is intentionally lenient on structural cites
// ("Chapter 10") because those don't pin section text. Only section-
// level citations (internal/cross_module/section-ref) count.

import { type BillClaimSurface, extractBillClaims } from "./bill-claims";
import { extractAnswerCitations } from "./parse-citations";
import { parseSourcesBlock, splitProseAndSources } from "./sources-block";

export interface FetchedRef {
  module_id: string;
  section_id: string;
}

/** Bills the model touched (read /bills/X or read /bills/X/changes/...).
 *  Tracked separately from section refs because bills resolve against
 *  the session bills index, not the sections index.
 *
 *  `module_id` and `affected_section_ids` are populated when the harvester
 *  saw payload kinds that expose them (`bill`, `bills-list`, `bill-changes`).
 *  A path-only harvest (e.g. /bills/{file_no}/proposed-text) yields just
 *  `file_no`; R23's affected-section completeness check skips bills whose
 *  affected set is unknown rather than false-positive on incomplete data. */
export interface FetchedBill {
  file_no: string;
  module_id?: string;
  affected_section_ids?: readonly string[];
}

export interface VerifyResult {
  ok: boolean;
  /** Citations not present in the fetched set. */
  missing: readonly { display: string; module_id: string | null; section_id: string }[];
  /** Display of every citation that DID match — useful for telemetry. */
  matched: readonly { display: string; module_id: string; section_id: string }[];
}

export interface VerifyInput {
  text: string;
  fetched: readonly FetchedRef[];
  anchorModule: string;
}

/**
 * Sources-block enforcement output. Per D3/D8 the rule is
 * citation-driven, NOT fetch-driven: every section / bill *cited in
 * prose* must appear in the Sources block, and every block entry must
 * be a section / bill the model fetched this turn.
 *
 * `ok: true` when (the answer cites nothing OR a complete, valid block
 * is present). `kind` enumerates the failure modes so the synthetic
 * tool_error feedback can name the exact gap.
 */
export type SourcesBlockOutcome =
  | { ok: true; kind: "no_citations" }
  | { ok: true; kind: "block_valid"; entryCount: number }
  | { ok: false; kind: "block_missing" }
  | {
      ok: false;
      kind: "cited_but_not_in_block";
      missing: readonly { display: string }[];
    }
  | {
      ok: false;
      kind: "block_entry_not_fetched";
      missing: readonly { display: string }[];
    }
  | {
      ok: false;
      kind: "block_entry_unparseable";
      missing: readonly { display: string }[];
    }
  | {
      ok: false;
      kind: "bill_affected_sections_omitted";
      /** Affected sections present in the cited bill's `affected_section_ids`
       *  but absent from both the prose AND the Sources block. Grouped by
       *  bill so the feedback can name "Bill #N is missing X, Y, Z". */
      missing: readonly {
        file_no: string;
        sections: readonly { display: string; module_id: string; section_id: string }[];
      }[];
    }
  | {
      ok: false;
      kind: "bill_claim_unsupported";
      /** Sections the answer attributes to a bill that are NOT in that
       *  bill's `affected_section_ids` — the fabrication dual of the
       *  omission check above. Grouped by bill. */
      unsupported: readonly {
        file_no: string;
        sections: readonly {
          display: string;
          module_id: string;
          section_id: string;
          surface: BillClaimSurface;
        }[];
      }[];
    };

export interface VerifySourcesBlockInput {
  /** Full assistant prose (the body + the trailing Sources block, if any). */
  text: string;
  /** Sections fetched THIS turn (used to validate block entries). */
  fetchedSections: readonly FetchedRef[];
  /** Bills fetched THIS turn (used to validate block entries). */
  fetchedBills: readonly FetchedBill[];
  /**
   * Section refs the model probed via tool calls that returned not_found.
   * Prose may legitimately mention these ("§ X doesn't exist in the
   * installed code") — that's the honest-acknowledgment path (rule 10).
   * R19 exempts these from the "every cited ref must be in the Sources
   * block" check because the model isn't authority-claiming them, it's
   * reporting a search miss. Block entries for attempted-only refs are
   * still rejected — you can't cite a non-existent section as authority.
   */
  attemptedSections?: readonly FetchedRef[];
}

export function verifyCitations(input: VerifyInput): VerifyResult {
  const candidates = extractAnswerCitations(input.text);
  if (candidates.length === 0) {
    return { ok: true, missing: [], matched: [] };
  }
  const fetchedSet = buildFetchedIndex(input.fetched);
  const collectedMissing: { display: string; module_id: string | null; section_id: string }[] = [];
  const matched: { display: string; module_id: string; section_id: string }[] = [];

  for (const c of candidates) {
    if (c.qualified) {
      const key = refKey(c.qualified.module_id, c.qualified.section_id);
      if (fetchedSet.has(key)) {
        matched.push({
          display: c.display,
          module_id: c.qualified.module_id,
          section_id: c.qualified.section_id,
        });
      } else {
        collectedMissing.push({
          display: c.display,
          module_id: c.qualified.module_id,
          section_id: c.qualified.section_id,
        });
      }
      continue;
    }
    if (c.bareSectionId) {
      // Bare cite — try anchor module first, then every fetched module
      // (the model may have widened scope mid-turn).
      const tryAnchor = refKey(input.anchorModule, c.bareSectionId);
      if (fetchedSet.has(tryAnchor)) {
        matched.push({
          display: c.display,
          module_id: input.anchorModule,
          section_id: c.bareSectionId,
        });
        continue;
      }
      const fallback = findAcrossModules(fetchedSet, c.bareSectionId);
      if (fallback) {
        matched.push({ display: c.display, ...fallback });
        continue;
      }
      collectedMissing.push({
        display: c.display,
        module_id: null,
        section_id: c.bareSectionId,
      });
    }
  }

  return {
    ok: collectedMissing.length === 0,
    missing: collectedMissing,
    matched,
  };
}

function buildFetchedIndex(fetched: readonly FetchedRef[]): Map<string, FetchedRef> {
  const out = new Map<string, FetchedRef>();
  for (const f of fetched) out.set(refKey(f.module_id, f.section_id), f);
  return out;
}

function findAcrossModules(
  set: Map<string, FetchedRef>,
  sectionId: string,
): { module_id: string; section_id: string } | null {
  for (const [, ref] of set) {
    if (ref.section_id === sectionId) {
      return { module_id: ref.module_id, section_id: ref.section_id };
    }
  }
  return null;
}

function refKey(moduleId: string, sectionId: string): string {
  return `${moduleId}::${sectionId}`;
}

/**
 * Validate the Sources block at the tail of the answer.
 *
 * Rule (D3/D8 citation-driven semantics):
 *   - If the body cites NO section or bill: ok (no_citations).
 *   - Otherwise the block must be present AND list every cited
 *     section / bill, AND every entry must be a section / bill the
 *     model fetched this turn.
 *
 * Citation extraction runs over the BODY only (prose before the
 * heading) so an entry listed in the block doesn't double-count as a
 * prose citation. This is what keeps Sources blocks deterministic —
 * the same answer always produces the same outcome.
 */
export function verifySourcesBlock(input: VerifySourcesBlockInput): SourcesBlockOutcome {
  const { body, block } = splitProseAndSources(input.text);
  const bodyCites = extractAnswerCitations(body);
  const citedSectionKeys = new Set<string>();
  const citedBillKeys = new Set<string>();
  const citedDisplays = new Map<string, string>(); // key → first display seen
  for (const c of bodyCites) {
    if (c.qualified) {
      const key = `sec:${c.qualified.module_id}::${c.qualified.section_id}`;
      citedSectionKeys.add(key);
      if (!citedDisplays.has(key)) citedDisplays.set(key, c.display);
    } else if (c.bareSectionId) {
      const key = `sec-bare:${c.bareSectionId}`;
      citedSectionKeys.add(key);
      if (!citedDisplays.has(key)) citedDisplays.set(key, c.display);
    } else if (c.billFileNo) {
      const key = `bill:${c.billFileNo}`;
      citedBillKeys.add(key);
      if (!citedDisplays.has(key)) citedDisplays.set(key, c.display);
    }
  }
  // Build the attempted-only key set so the cite-checker can exempt
  // honest-acknowledgment cites from the "must be in block" rule. A
  // section that was probed and returned not_found is not authority —
  // mentioning it doesn't trigger Sources-block requirements.
  const attemptedOnlyKeys = new Set<string>();
  if (input.attemptedSections) {
    const fetchedKeys = new Set<string>();
    for (const f of input.fetchedSections) {
      fetchedKeys.add(`sec:${f.module_id}::${f.section_id}`);
      fetchedKeys.add(`sec-bare:${f.section_id}`);
    }
    for (const a of input.attemptedSections) {
      const k1 = `sec:${a.module_id}::${a.section_id}`;
      const k2 = `sec-bare:${a.section_id}`;
      if (!fetchedKeys.has(k1)) attemptedOnlyKeys.add(k1);
      if (!fetchedKeys.has(k2)) attemptedOnlyKeys.add(k2);
    }
  }
  // Strip attempted-only refs from the cited set — they don't require
  // block entries. A turn whose only cites are probed-not-found refs
  // becomes effectively no-citation under R19.
  for (const k of attemptedOnlyKeys) citedSectionKeys.delete(k);
  const citesAnything = citedSectionKeys.size > 0 || citedBillKeys.size > 0;
  if (!citesAnything) {
    return { ok: true, kind: "no_citations" };
  }
  if (!block) {
    return { ok: false, kind: "block_missing" };
  }

  const parsedBlock = parseSourcesBlock(input.text);
  if (!parsedBlock.present) {
    // Shouldn't happen because splitProseAndSources found a heading,
    // but keep the path safe.
    return { ok: false, kind: "block_missing" };
  }

  // Build the keyspace of block entries.
  const blockSectionKeys = new Set<string>();
  const blockBillKeys = new Set<string>();
  const unparseable: { display: string }[] = [];
  for (const e of parsedBlock.entries) {
    if (e.kind === "section" && e.module_id && e.section_id) {
      blockSectionKeys.add(`sec:${e.module_id}::${e.section_id}`);
      blockSectionKeys.add(`sec-bare:${e.section_id}`);
    } else if (e.kind === "bill" && e.file_no) {
      blockBillKeys.add(`bill:${e.file_no}`);
    } else {
      unparseable.push({ display: e.display });
    }
  }
  if (unparseable.length > 0) {
    return { ok: false, kind: "block_entry_unparseable", missing: unparseable };
  }

  // Citation-driven gap: every cite in prose must appear in the block.
  const citedMissing: { display: string }[] = [];
  for (const key of citedSectionKeys) {
    if (!blockSectionKeys.has(key)) {
      const display = citedDisplays.get(key) ?? key;
      citedMissing.push({ display });
    }
  }
  for (const key of citedBillKeys) {
    if (!blockBillKeys.has(key)) {
      const display = citedDisplays.get(key) ?? key;
      citedMissing.push({ display });
    }
  }
  if (citedMissing.length > 0) {
    return { ok: false, kind: "cited_but_not_in_block", missing: citedMissing };
  }

  // Fetch-side check: every block entry must be a ref the model fetched
  // THIS turn. Symmetric with the inline-cite verifier.
  const fetchedSectionIds = new Set<string>();
  for (const f of input.fetchedSections) {
    fetchedSectionIds.add(`sec:${f.module_id}::${f.section_id}`);
    fetchedSectionIds.add(`sec-bare:${f.section_id}`);
  }
  const fetchedBillIds = new Set<string>();
  for (const b of input.fetchedBills) {
    fetchedBillIds.add(`bill:${b.file_no}`);
  }
  const unfetched: { display: string }[] = [];
  for (const e of parsedBlock.entries) {
    if (e.kind === "section" && e.module_id && e.section_id) {
      const qualifiedKey = `sec:${e.module_id}::${e.section_id}`;
      const bareKey = `sec-bare:${e.section_id}`;
      if (!fetchedSectionIds.has(qualifiedKey) && !fetchedSectionIds.has(bareKey)) {
        unfetched.push({ display: e.display });
      }
    } else if (e.kind === "bill" && e.file_no) {
      if (!fetchedBillIds.has(`bill:${e.file_no}`)) {
        unfetched.push({ display: e.display });
      }
    }
  }
  if (unfetched.length > 0) {
    return { ok: false, kind: "block_entry_not_fetched", missing: unfetched };
  }

  // R23 — affected-section completeness. When the answer is a memo (R20)
  // or bill-impact table (R21), every section in the cited bill's
  // `affected_section_ids` must appear somewhere the user can act on it:
  // either cited inline in prose, OR listed in the Sources block. Narrow
  // free-prose answers about one section of a multi-section bill are
  // exempt — they explicitly opt out by NOT using the R20/R21 heading.
  const shape = detectArtifactShape(body);
  if (shape !== null) {
    const omitted: {
      file_no: string;
      sections: { display: string; module_id: string; section_id: string }[];
    }[] = [];
    const mentioned = new Set<string>([...citedSectionKeys, ...blockSectionKeys]);
    for (const billKey of citedBillKeys) {
      const fileNo = billKey.slice("bill:".length);
      const bill = input.fetchedBills.find((b) => b.file_no === fileNo);
      if (!bill?.module_id || !bill.affected_section_ids?.length) continue;
      const missingForBill: { display: string; module_id: string; section_id: string }[] = [];
      for (const sectionId of bill.affected_section_ids) {
        const qkey = `sec:${bill.module_id}::${sectionId}`;
        const bareKey = `sec-bare:${sectionId}`;
        if (mentioned.has(qkey) || mentioned.has(bareKey)) continue;
        missingForBill.push({
          display: `[${bill.module_id} § ${sectionId}]`,
          module_id: bill.module_id,
          section_id: sectionId,
        });
      }
      if (missingForBill.length > 0) {
        omitted.push({ file_no: fileNo, sections: missingForBill });
      }
    }
    if (omitted.length > 0) {
      return { ok: false, kind: "bill_affected_sections_omitted", missing: omitted };
    }

    // R25 — bill-claim discipline, the fabrication dual of R23.
    // Completeness first (above), then over-claiming: every section the
    // artifact attributes to a bill must be in that bill's
    // affected_section_ids. Quoted/blockquoted material and guarded
    // debunking sentences never produce claims (see bill-claims.ts);
    // bills with unknown affected sets are exempt, mirroring R23.
    const unsupported: {
      file_no: string;
      sections: {
        display: string;
        module_id: string;
        section_id: string;
        surface: BillClaimSurface;
      }[];
    }[] = [];
    for (const claim of extractBillClaims(body)) {
      const bill = input.fetchedBills.find((b) => b.file_no === claim.file_no);
      if (!bill?.module_id || !bill.affected_section_ids?.length) continue;
      // Qualified cites into a different module than the harvested
      // slice aren't verifiable against this bill record — skip rather
      // than guess (multi-module bills carry one slice per module).
      if (claim.module_id !== null && claim.module_id !== bill.module_id) continue;
      if (bill.affected_section_ids.includes(claim.section_id)) continue;
      const moduleId = claim.module_id ?? bill.module_id;
      const entry = {
        display: claim.display,
        module_id: moduleId,
        section_id: claim.section_id,
        surface: claim.surface,
      };
      const bucket = unsupported.find((u) => u.file_no === claim.file_no);
      if (bucket) bucket.sections.push(entry);
      else unsupported.push({ file_no: claim.file_no, sections: [entry] });
    }
    if (unsupported.length > 0) {
      return { ok: false, kind: "bill_claim_unsupported", unsupported };
    }
  }

  return { ok: true, kind: "block_valid", entryCount: parsedBlock.entries.length };
}

/**
 * Identify whether the answer body uses an artifact template that
 * implies bill-scoped completeness. Memo (R20) and bill-impact-table
 * (R21) both promise the reader a structured walk over the bill; their
 * top-level `## ` heading is the contract signal. Reading-order (R22)
 * and free-form prose don't make that promise and are exempt.
 *
 * Heading detection scans only the first few non-blank lines so that a
 * later `## Memo:` inside quoted material can't accidentally trip the
 * check. Real R20/R21 answers put the heading first.
 */
function detectArtifactShape(body: string): "memo" | "impact" | null {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines.slice(0, 3)) {
    if (/^##\s+Memo:\s+/i.test(line)) return "memo";
    if (/^##\s+What\s+\[Bill\s+#/i.test(line)) return "impact";
  }
  return null;
}

/**
 * Build the synthetic tool_error string the conversation loop appends
 * when verifySourcesBlock reports a failure. The model sees what it did
 * wrong and either adds / fixes the block or rewrites the answer in
 * acknowledgment prose.
 */
export function formatSourcesBlockFailure(outcome: SourcesBlockOutcome): string {
  if (outcome.ok) return "";
  const lines: string[] = ["<verification_failure>"];
  switch (outcome.kind) {
    case "block_missing":
      lines.push(
        "Your answer cites at least one section or bill but is missing the trailing Sources block.",
        "Append a `**Sources**` heading followed by one bulleted entry per cited reference:",
        "  - [module-id § section-id] — Title",
        "  - [Bill #file_no] — Title",
      );
      break;
    case "cited_but_not_in_block":
      lines.push(
        "Your answer cites these references in prose but they are not in the Sources block:",
      );
      for (const m of outcome.missing) lines.push(`  - ${m.display}`);
      lines.push(
        "Add a Sources entry for each, or drop the citation if you didn't mean to authority-claim it.",
      );
      break;
    case "block_entry_not_fetched":
      lines.push("Your Sources block lists entries you did not fetch this turn:");
      for (const m of outcome.missing) lines.push(`  - ${m.display}`);
      lines.push(
        "Either read each via the corpus tool before listing it, or drop the unfetched entries from the block.",
      );
      break;
    case "block_entry_unparseable":
      lines.push(
        "Your Sources block contains entries that don't parse as `[module § id]` or `[Bill #file_no]`:",
      );
      for (const m of outcome.missing) lines.push(`  - ${m.display}`);
      lines.push("Rewrite each entry in the bracketed form.");
      break;
    case "bill_affected_sections_omitted":
      lines.push(
        "Your answer uses an R20 memo or R21 bill-impact-table heading, which promises a walk over every section the bill touches. These affected sections were omitted:",
      );
      for (const b of outcome.missing) {
        lines.push(`  [Bill #${b.file_no}] is missing:`);
        for (const s of b.sections) lines.push(`    - ${s.display}`);
      }
      lines.push(
        "Either read each missing section and cite it (or add it to the Sources block), or drop the R20/R21 heading and rewrite as free prose if the question is narrower than the whole bill.",
      );
      break;
    case "bill_claim_unsupported":
      lines.push(
        "Your answer asserts these sections are changed by a bill, but they are not in that bill's affected_section_ids:",
      );
      for (const b of outcome.unsupported) {
        lines.push(`  [Bill #${b.file_no}] does not touch:`);
        for (const s of b.sections) lines.push(`    - [${s.module_id} § ${s.section_id}]`);
      }
      lines.push(
        'Remove or correct each claim. If you are quoting an erroneous draft in order to correct it, put the quoted claims in Markdown blockquotes (lines starting with ">") and state the correction in your own voice.',
      );
      break;
  }
  lines.push("</verification_failure>");
  return lines.join("\n");
}

/**
 * Format a synthetic tool_error message the conversation loop appends
 * to the message stream when verification fails. The model sees the
 * failure and either re-fetches the missing section (preferred) or
 * rewrites the answer in honest prose ("I don't have authority for
 * § X.Y in this corpus").
 */
export function formatVerificationFailure(result: VerifyResult): string {
  if (result.ok) return "";
  const lines: string[] = [
    "<verification_failure>",
    "Citations in your answer that you did not fetch this turn:",
  ];
  for (const m of result.missing) {
    const where = m.module_id ? `${m.module_id} § ${m.section_id}` : `§ ${m.section_id}`;
    lines.push(`  - ${m.display} (resolved as ${where})`);
  }
  lines.push(
    "Either call get_section on each, or remove the citation and acknowledge in prose that you don't have authority for it.",
    "</verification_failure>",
  );
  return lines.join("\n");
}
