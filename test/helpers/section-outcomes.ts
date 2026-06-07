// Shared helper for migrating tests from the legacy
// `affected_sections: SectionId[]` shape to the new
// `section_outcomes: SectionOutcome[]` shape on Bill.
//
// The mapping is parse-status aware: tests that expected the old
// "manual_review with affected sections" shape get per-section
// outcomes with `classification_low_confidence` (the canonical
// non-rendering parse failure post-v2); "ok" gets `anchored`;
// "structural_change" gets `structural`.

import type { ParseStatus, SectionId, SectionOutcome } from "@/types";

export function outcomesFromAffectedSections(
  sectionIds: ReadonlyArray<SectionId>,
  parseStatus: ParseStatus = "manual_review",
): SectionOutcome[] {
  const status: SectionOutcome["status"] =
    parseStatus === "ok"
      ? "anchored"
      : parseStatus === "structural_change"
        ? "structural"
        : parseStatus === "absorbed_external"
          ? "absorbed_external"
          : "classification_low_confidence";
  return sectionIds.map((s) => ({ section_id: s, status, detail: null }));
}
