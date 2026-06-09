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

export interface FetchedRef {
  module_id: string;
  section_id: string;
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
