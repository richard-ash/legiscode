import type { BillStatus } from "@/types";

// Map Legistar's free-text status to the 5-key BILL_STATUS taxonomy from
// the Claude Design handoff (bills-doc.jsx:3). Per the Pass 7 lock, the
// mapping is regex-driven and falls back to `filed` with a typed warning
// when nothing matches — explicitly NOT a silent default, because a
// genuine miss is signal that Legistar's verbiage drifted and the alias
// table needs an update.
//
// The 5 keys (in workflow order):
//   filed      — introduced but not yet assigned to committee
//   committee  — pending in committee, hearing scheduled or being heard
//   engrossed  — committee approved, finalized for floor consideration
//   floor      — pending floor vote (Board of Supervisors)
//   enrolled   — passed both votes, awaiting Mayor / publication
//
// Matchers are ordered most-specific-first; first match wins.

type Matcher = { re: RegExp; status: BillStatus };

const MATCHERS: Matcher[] = [
  // "enrolled" is the post-floor stage; check before "floor" since some
  // statuses include both words (e.g. "Enrolled - awaiting Mayor's signature").
  { re: /\benrolled\b/i, status: "enrolled" },
  { re: /\bsignature\b/i, status: "enrolled" },
  { re: /\bawaiting\s+mayor\b/i, status: "enrolled" },

  // "floor" stage — pending Board vote.
  { re: /\bboard\s+(?:vote|reading)\b/i, status: "floor" },
  { re: /\bfloor\b/i, status: "floor" },
  { re: /\bsecond\s+reading\b/i, status: "floor" },

  // "engrossed" — committee approved and finalized.
  { re: /\bengross/i, status: "engrossed" },
  { re: /\bpassed\s+committee\b/i, status: "engrossed" },

  // "committee" — pending in committee. SF's Legistar uses verbose
  // committee names: "Pending — Land Use Committee", "Pending Committee
  // Hearing", "Continued — Rules Committee", etc.
  { re: /\bcommittee\b/i, status: "committee" },
  { re: /\bhearing\b/i, status: "committee" },
  { re: /\bcontinued\b/i, status: "committee" },

  // "filed" — introduced, no committee assignment yet. Default end of
  // chain so unmatched statuses don't silently slip past.
  { re: /\bfiled\b/i, status: "filed" },
  { re: /\bintroduced\b/i, status: "filed" },
  { re: /\bpending\b/i, status: "filed" },
];

export type StatusMapResult = {
  status: BillStatus;
  /** True when no matcher fired and we fell back to `filed`. */
  unmatched: boolean;
};

export function mapLegistarStatusToBillStatus(legistarStatus: string): StatusMapResult {
  for (const m of MATCHERS) {
    if (m.re.test(legistarStatus)) {
      return { status: m.status, unmatched: false };
    }
  }
  // No matcher fired. Fall back to "filed" but flag the result so the
  // operator log can surface the drift — silently masking unknown statuses
  // would let a Legistar verbiage rename hide a real workflow stage from
  // the renderer until someone notices the badge color is wrong.
  return { status: "filed", unmatched: true };
}
