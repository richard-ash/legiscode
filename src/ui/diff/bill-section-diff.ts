// Per-section diff availability for a Bill.
//
// The visibility decision is per-outcome, not per-bill: a `partial`
// bill can have one section anchored with usable text_diff spans and
// another section fall through. Both the section-pending-rail's
// per-row "Show changes" gate and the section-view's overlay banner
// must follow the same per-section rule — otherwise a partial bill's
// 6 cleanly-anchored sections would surface "overlay unavailable"
// just because a 7th section is ambiguous.

import type { Bill, SectionId } from "@/types";

export function billHasDiffForSection(bill: Bill, sectionId: SectionId): boolean {
  if (bill.parse_status === "structural_change" || bill.parse_status === "absorbed_external") {
    return false;
  }
  if (bill.parse_status === "body_only") return false;
  const outcome = bill.section_outcomes.find((o) => o.section_id === sectionId);
  if (!outcome) return false;
  if (outcome.status !== "anchored" && outcome.status !== "added_section") return false;
  return bill.text_diff.some((span) => span.section_id === sectionId);
}
