import type { BillStatus } from "@/types";
import type { ActionHistoryRow } from "./legistar-html";

export type { ActionHistoryRow };

// Map Legistar's free-text status to the 9-key BillStatus taxonomy:
// the original 5 in-flight states (filed → committee → engrossed →
// floor → enrolled) plus four terminal states (enacted, vetoed,
// withdrawn, failed) added when the bill substrate widened from
// pending-only to session-scoped.
//
// Per the Pass 7 lock, the mapping is regex-driven and falls back to
// `filed` with a typed warning when nothing matches — explicitly NOT a
// silent default, because a genuine miss is signal that Legistar's
// verbiage drifted and the alias table needs an update.
//
// Workflow order (pre-passage):
//   filed      — introduced but not yet assigned to committee
//   committee  — pending in committee, hearing scheduled or being heard
//   engrossed  — committee approved, finalized for floor consideration
//   floor      — pending floor vote (Board of Supervisors)
//   enrolled   — passed both votes, awaiting Mayor / publication
//
// Terminal (post-passage, no further movement):
//   enacted    — Mayor signed (or published without veto)
//   vetoed     — Mayor vetoed
//   withdrawn  — sponsor pulled the bill
//   failed     — Board vote failed
//
// Matchers are ordered most-specific-first; first match wins. Terminal
// matchers come before in-flight matchers so "Signed by Mayor" doesn't
// silently fall through to a workflow state.

type Matcher = { re: RegExp; status: BillStatus };

const MATCHERS: Matcher[] = [
  // ── Pre-passage qualifiers ─────────────────────────────────────────
  // "Awaiting Mayor's signature" must fire BEFORE the enacted matchers
  // below, because it carries the literal word "signature" but the bill
  // is still enrolled (not yet signed). Without this guard, "Awaiting
  // Mayor's signature" would silently map to enacted.
  { re: /\bawaiting\s+(?:the\s+)?mayor\b/i, status: "enrolled" },

  // ── Terminal states ────────────────────────────────────────────────
  // "vetoed" — Mayor rejection. Check before "enacted" because some
  // free-text strings say "Vetoed — override pending" which would also
  // match the signature word otherwise.
  { re: /\bvetoed?\b/i, status: "vetoed" },
  { re: /\bveto\s+sustained\b/i, status: "vetoed" },

  // "withdrawn" — sponsor pulled the bill before it reached a vote.
  { re: /\bwithdrawn\b/i, status: "withdrawn" },
  { re: /\brescinded\b/i, status: "withdrawn" },

  // "failed" — Board vote failed (motion did not pass).
  { re: /\bfailed\b/i, status: "failed" },
  { re: /\bdefeated\b/i, status: "failed" },
  { re: /\btabled\b/i, status: "failed" },

  // "enacted" — Mayor signed or published without veto. Check before
  // "enrolled" because "Signed by Mayor" and "Effective" appear after
  // enrollment. "Awaiting" qualifier already filtered above.
  { re: /\bsigned\s+by\s+(?:the\s+)?mayor\b/i, status: "enacted" },
  { re: /\bmayor['’]?s?\s+signature\b/i, status: "enacted" },
  { re: /\beffective\b/i, status: "enacted" },
  { re: /\benacted\b/i, status: "enacted" },
  { re: /\bapproved\s+by\s+(?:the\s+)?mayor\b/i, status: "enacted" },

  // ── In-flight states ───────────────────────────────────────────────
  // "enrolled" is the post-floor stage; check before "floor" since some
  // statuses include both words (e.g. "Enrolled - moved to Mayor's desk").
  { re: /\benrolled\b/i, status: "enrolled" },

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

// Audit pass on the resolved status: detects the case where Legistar's
// status string mapped to a non-terminal state but the action history
// shows a terminal event. D7.4 + D12.7: this is louder than
// `unmatched=true` because the mapper happily resolved to e.g. "filed"
// based on the status text, while the action history says the bill was
// "Signed by Mayor on 2026-04-12". The renderer would render a "filed"
// pill on an enacted bill — exactly the silent miscategorization the
// design's invariant forbids.
//
// Returns null when no inconsistency is detected; otherwise returns a
// structured warning the caller (fetch-bills assembleMeta) can hoist
// into the sync log.
export type StatusAuditWarning = {
  /** Free-text Legistar status the mapper consumed. */
  legistar_status: string;
  /** Status the mapper resolved to. */
  mapped_status: BillStatus;
  /** Terminal status the action history implies. */
  implied_status: BillStatus;
  /** The history row that triggered the disagreement. */
  evidence: ActionHistoryRow;
};

export function auditStatusAgainstHistory(args: {
  legistarStatus: string;
  mappedStatus: BillStatus;
  history: readonly ActionHistoryRow[];
}): StatusAuditWarning | null {
  // Terminal events are the only ones worth escalating. An in-flight
  // event in the history (e.g. "Referred to Committee") is consistent
  // with any non-terminal mapped state.
  for (const row of args.history) {
    const implied = inferTerminalStatusFromAction(row.action);
    if (implied === null) continue;
    if (implied !== args.mappedStatus) {
      return {
        legistar_status: args.legistarStatus,
        mapped_status: args.mappedStatus,
        implied_status: implied,
        evidence: row,
      };
    }
  }
  return null;
}

function inferTerminalStatusFromAction(action: string): BillStatus | null {
  if (/\bvetoed?\b/i.test(action)) return "vetoed";
  if (/\bsigned\s+by\s+(?:the\s+)?mayor\b/i.test(action)) return "enacted";
  if (/\bmayor['’]?s?\s+signature\b/i.test(action)) return "enacted";
  if (/\beffective\b/i.test(action)) return "enacted";
  if (/\bwithdrawn\b/i.test(action)) return "withdrawn";
  if (/\bfailed\b/i.test(action)) return "failed";
  if (/\bdefeated\b/i.test(action)) return "failed";
  return null;
}
