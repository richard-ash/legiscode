import type { ModuleId } from "@/types";
import { SF_BILL_CODE_ALIASES } from "./aliases";

// Title-classifier scope-filter. Given the lblTitle2 string from a Legistar
// LegislationDetail page plus the installed-module set, classify the
// matter and resolve every code-name stub the title mentions to a
// (module_id | not_installed | unresolved) bucket.
//
// Codex amendment A3 reversal lock: this filter is **advisory**, not a
// download gate. The fetcher records the verdict in BillMeta and downloads
// every Ordinance-type matter regardless. The parse_status field on the
// per-module Bill output is the real bucket; the title classifier is the
// renderer's priority signal (Class A bills sort above Class B in the
// pending tree) and the operator's audit signal (Class B matters with
// zero parsed sections are expected, not a parse failure).

export type ScopeFilterResult = {
  /**
   * Class A — title verb is "amending" / "adding" / "repealing"; matter
   * is expected to produce text_diff content.
   * Class B — title verb is "waiving" / "authorizing" / "appropriating" /
   * "approving"; matter is expected to produce zero text_diff entries.
   */
  class: "A" | "B";
  /**
   * Raw code-name stubs the title mentioned, in title order. Preserved
   * verbatim for audit (the alias table maps "Building Inspection Code"
   * → "sf-building" but the operator still wants to see the original
   * source string).
   */
  touched_code_stubs: string[];
  /**
   * Subset of touched_code_stubs that resolved to an installed module.
   * `installed_modules` is the input ID list, not a derived value, so
   * the caller controls the install set; this field is the intersection
   * with the resolved stubs.
   */
  touched_modules: ModuleId[];
  /**
   * Stubs that named a known code with no installed module. Surfaced in
   * BillMeta + the Impact card so the operator sees what the bill touches
   * beyond the installed perimeter.
   */
  not_installed_modules: string[];
  /**
   * Stubs that matched no installed module and no alias. Real Legistar
   * data should produce zero entries here under steady state; non-empty
   * means either new SF code is in flight or a drift in Legistar's
   * code-name verbiage needs a new alias.
   */
  unresolved: string[];
};

export type InstalledModule = {
  readonly id: ModuleId;
  /** Manifest `code_title` — e.g. "Administrative Code". */
  readonly code_title: string;
};

// Class A verbs: code-amending action words. Matched against the title's
// leading verb (after "Ordinance ") — title format is "Ordinance {verb-ing}
// the {Code} Code …".
const CLASS_A_VERBS = ["amending", "adding", "repealing", "enacting"] as const;

// CodeStubMatcher precomputes the installed + aliased stub lookup so the
// longest-match left-consumer doesn't re-walk the code-title list per stub
// candidate. Stubs are matched without the literal "Code" / "Charter" suffix
// because SF titles inconsistently include it (e.g. "Health" vs "Health Code").
type StubMatch = { stub: string; moduleId: ModuleId };

function buildStubMatcher(installed: readonly InstalledModule[]): StubMatch[] {
  const out: StubMatch[] = [];
  for (const mod of installed) {
    // Strip the trailing " Code" / " Charter" so "Administrative Code"
    // matches the title's "Administrative" stub regardless of whether the
    // body restates "Code". Charter is the unsuffixed exception: its
    // code_title IS "Charter" and stripping leaves an empty string, so
    // fall back to the original.
    const stripped = mod.code_title.replace(/\s+(?:Code|Charter)\s*$/i, "").trim();
    const stub = stripped.length > 0 ? stripped : mod.code_title;
    out.push({ stub, moduleId: mod.id });
  }
  for (const [aliasName, moduleId] of Object.entries(SF_BILL_CODE_ALIASES)) {
    const stripped = aliasName.replace(/\s+(?:Code|Charter)\s*$/i, "").trim();
    const stub = stripped.length > 0 ? stripped : aliasName;
    out.push({ stub, moduleId });
  }
  // Longest-first ordering enforces the left-consumer rule: "Business and
  // Tax Regulations" matches before "Business" so a title that mentions
  // the longer code is never silently routed to the shorter one.
  out.sort((a, b) => b.stub.length - a.stub.length);
  return out;
}

// SF Legistar title shape (lblTitle2):
//   "Ordinance amending the Planning Code, Administrative Code, and Police
//    Code to require ..."
//
// The classifier reads the first verb after "Ordinance " (Class A vs B),
// then for Class A walks the "the X Code[, Y Code, and Z Code]" stub list
// in order, greedy-matching the longest installed/aliased stub at each
// position. Stubs that match no installed module fall into `unresolved` so
// the audit log surfaces the drift; the spike found zero genuine
// unresolvable stubs in the SF corpus, so non-empty `unresolved` is a real
// signal worth seeing.
export function classifyBillTitle(
  title: string,
  installed: readonly InstalledModule[],
): ScopeFilterResult {
  const trimmed = title.trim();
  const verbMatch = /^Ordinance\s+(\w+ing)\b/i.exec(trimmed);
  const verb = verbMatch?.[1]?.toLowerCase() ?? null;
  const isClassA = verb !== null && (CLASS_A_VERBS as readonly string[]).includes(verb);

  const installedIds = new Set(installed.map((m) => m.id));
  const result: ScopeFilterResult = {
    class: isClassA ? "A" : "B",
    touched_code_stubs: [],
    touched_modules: [],
    not_installed_modules: [],
    unresolved: [],
  };

  if (!isClassA) {
    // Class B titles don't list code stubs. Leave the touched arrays
    // empty — the caller still records the bill in bills-index for
    // audit but knows there's nothing to parse.
    return result;
  }

  const matcher = buildStubMatcher(installed);
  // Extract the stub list region. The grammar is:
  //   "amending the {STUB_LIST} to {action}"
  // STUB_LIST is comma + Oxford-comma + "and" separated; each entry is a
  // capitalized phrase ending in "Code" or "Charter". We slice from "the"
  // to the next " to " / " by " / " in order " transition keyword.
  const region = sliceStubRegion(trimmed);
  if (region === null) {
    // Verb matched but stub list didn't — fall back to Class B-style
    // (no stubs) and let parse_status carry the verdict.
    return result;
  }
  const stubs = splitStubs(region);
  for (const stub of stubs) {
    result.touched_code_stubs.push(stub);
    const hit = matcher.find((m) => stubMatches(stub, m.stub));
    if (hit === undefined) {
      result.unresolved.push(stub);
      continue;
    }
    if (installedIds.has(hit.moduleId)) {
      if (!result.touched_modules.includes(hit.moduleId)) {
        result.touched_modules.push(hit.moduleId);
      }
    } else {
      // Alias resolved to a module id that isn't installed — surface as
      // not_installed so the audit + UI footer line ("Touches 11 codes
      // not installed") includes it.
      if (!result.not_installed_modules.includes(stub)) {
        result.not_installed_modules.push(stub);
      }
    }
  }
  return result;
}

function sliceStubRegion(title: string): string | null {
  // Look for "the " after the leading verb. The greedy non-stub-ending
  // suffix is one of "to ", "by ", or "in order to ".
  const start = /\bthe\s+/i.exec(title);
  if (start === null) return null;
  const after = title.slice(start.index + start[0].length);
  const terminator = / (?:to|by|in order to)\s+/i.exec(after);
  return terminator ? after.slice(0, terminator.index).trim() : after.trim();
}

function splitStubs(region: string): string[] {
  // Region looks like "Planning Code, Administrative Code, and Police Code"
  // OR "Business and Tax Regulations Code" — naïve comma-or-"and" splitting
  // breaks the second case because the conjunction is interior to a single
  // stub. Walk the region instead and end each stub at the next Code /
  // Charter boundary, then strip an Oxford "and " prefix the lazy match
  // pulls in when the previous stub ended without a comma. The leading
  // `Charter` alternative handles the bare "Charter" case (no prefix
  // words; only SF Charter today, but generalized for any future
  // jurisdiction with a constitutional document).
  const re = /\b(?:Charter|[A-Z][A-Za-z]+(?:\s+(?:and\s+)?[A-Z][A-Za-z]+)*\s+(?:Code|Charter))\b/g;
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(region);
  while (m !== null) {
    const captured = m[0];
    const cleaned = captured
      .replace(/^and\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length > 0) out.push(cleaned);
    m = re.exec(region);
  }
  return out;
}

function stubMatches(observed: string, stub: string): boolean {
  // observed is the raw text from the title (already trimmed); stub is
  // the manifest code_title minus " Code"/" Charter" suffix. Match if
  // observed starts with stub followed by " Code" or " Charter" or end-
  // of-string. Comparison is case-insensitive because Legistar's
  // capitalization is consistent but not strictly uppercase.
  const o = observed.toLowerCase();
  const s = stub.toLowerCase();
  if (!o.startsWith(s)) return false;
  const tail = o.slice(s.length).trim();
  return tail === "" || tail === "code" || tail === "charter";
}
