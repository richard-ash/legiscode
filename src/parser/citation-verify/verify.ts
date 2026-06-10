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

import { extractAnswerCitations } from "./parse-citations";
import { parseSourcesBlock, splitProseAndSources } from "./sources-block";

export interface FetchedRef {
  module_id: string;
  section_id: string;
}

/** Bills the model touched (read /bills/X or read /bills/X/changes/...).
 *  Tracked separately from section refs because bills resolve against
 *  the session bills index, not the sections index. */
export interface FetchedBill {
  file_no: string;
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
    };

export interface VerifySourcesBlockInput {
  /** Full assistant prose (the body + the trailing Sources block, if any). */
  text: string;
  /** Sections fetched THIS turn (used to validate block entries). */
  fetchedSections: readonly FetchedRef[];
  /** Bills fetched THIS turn (used to validate block entries). */
  fetchedBills: readonly FetchedBill[];
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

  return { ok: true, kind: "block_valid", entryCount: parsedBlock.entries.length };
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
