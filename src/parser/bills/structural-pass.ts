import type { ModuleId, SectionId } from "@/types";
import { SF_BILL_CODE_ALIASES } from "./aliases";
import type { InstalledModule } from "./scope-filter";

// Structural pass over a bill's text. Walks the document, identifies each
// "Section N. <Code> Code is hereby amended..." group (Criterion 1 from
// the structural-anchoring spike), captures the SEC./SECTION/Section
// headers inside (Criterion 2), resolves each code name to a module id
// (Criterion 3), and reports both ordinance-section groups (raw_section_id
// preserved per-group for audit) and a touched-sections map per module.
//
// Whole-chapter actions ("by adding Chapter X" / "is hereby repealed in
// its entirety") promote the affected module to structural_change in the
// caller. This pass surfaces the signal but doesn't decide parse_status;
// that's the orchestrator's job.

// Spike Criterion 1: `Section N. [Chapter X of] the <Code> [Code|Charter]
// is hereby amended`. Two phrasings observed; the regex unifies them.
// Line-anchored (/m) so body text like "by revising Section 41.2:" doesn't
// produce phantom matches. The trailing `[^.]{0,80}?` span enforces
// "stays inside one sentence" — the spike found that letting it cross
// periods produces false positives that swallow nested section headers.
const ORD_SECTION_RE =
  /^\s*(?:\d+\s+)?Section\s+\d+[A-Z]?\.\s+[^.]{0,200}?\b(?:of\s+the|The)\s+([A-Z][A-Za-z\s']+?)\s+(Code|Charter)\b[^.]{0,80}?\bis\s+(?:hereby\s+)?amended\b/gm;

// Spike Criterion 2: section header inside an AMEND block. Three observed
// variants (SEC./SECTION/Section) unified into one regex. The section_id
// capture excludes any leading whitespace and the trailing period.
const SECTION_HEADER_RE =
  /^\s*(?:\d+\s+)?(?:SEC\.|SECTION|Section)\s+([0-9][0-9A-Za-z.-]*)\.\s+([A-Z][A-Z0-9\s\-,&'().]+)$/gm;

// Whole-chapter action patterns that promote the bill to structural_change.
// The wording is specific enough that false positives are rare in SF's
// Legistar corpus.
const STRUCTURAL_PATTERNS = [
  /\bby\s+adding\s+Chapter\s+[\w-]+/i,
  /\bis\s+hereby\s+repealed\s+in\s+its\s+entirety\b/i,
  /\brepealing\s+Chapter\s+[\w-]+\s+in\s+its\s+entirety\b/i,
  /\badding\s+(?:a\s+new\s+)?Article\s+[\w-]+/i,
] as const;

export type CodeGroup = {
  /** Ordinance-section number from the PDF, e.g. "4" from "Section 4. …". */
  ordinance_section_number: string;
  /** Raw code-name string captured from the AMEND phrase. */
  code_name: string;
  /** Resolved module id, or null when no installed module matches. */
  module_id: ModuleId | null;
  /** Character offsets in the input text — used by the typography pass. */
  text_offset_start: number;
  text_offset_end: number;
  /**
   * Section headers nested inside this code group, in document order.
   * Empty for groups whose body is short-form / new-chapter (no nested SEC.s).
   */
  sections: Array<{
    raw_id: string;
    title: string;
    text_offset_start: number;
    text_offset_end: number;
  }>;
};

export type StructuralPassResult = {
  /** All AMEND ordinance-section groups in document order. */
  groups: CodeGroup[];
  /**
   * Promoted-to-structural-change discriminator. true when at least one
   * STRUCTURAL_PATTERN matched the document. The orchestrator emits
   * parse_status="structural_change" for any module whose touched
   * sections include a structural pattern hit.
   */
  has_structural_action: boolean;
  /**
   * Free-text description of the structural action, captured from the
   * first matching STRUCTURAL_PATTERN. Surfaced in the renderer's
   * Impact card. null when has_structural_action is false.
   */
  structural_action_text: string | null;
};

/**
 * Run the structural pass over already-extracted PDF text. The caller is
 * responsible for converting pdfjs runs into the input string (via
 * runsToText or equivalent).
 */
export function runStructuralPass(
  text: string,
  installed: readonly InstalledModule[],
): StructuralPassResult {
  const groups = findCodeGroups(text, installed);
  const structural = findStructuralAction(text);
  return {
    groups,
    has_structural_action: structural !== null,
    structural_action_text: structural,
  };
}

/** Identify every AMEND code-group and the sections nested inside it. */
function findCodeGroups(text: string, installed: readonly InstalledModule[]): CodeGroup[] {
  const matcher = buildModuleMatcher(installed);
  const groups: CodeGroup[] = [];
  // Reset regex state — module-level globals carry between calls.
  ORD_SECTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null = ORD_SECTION_RE.exec(text);
  const groupStarts: Array<{ ordNum: string; codeName: string; start: number }> = [];
  while (m !== null) {
    const ordNumberMatch = /Section\s+(\d+[A-Z]?)\./.exec(m[0]);
    const ordNumber = ordNumberMatch?.[1] ?? "?";
    groupStarts.push({
      ordNum: ordNumber,
      codeName: `${(m[1] ?? "").trim()} ${m[2] ?? ""}`.trim(),
      start: m.index,
    });
    m = ORD_SECTION_RE.exec(text);
  }
  for (let i = 0; i < groupStarts.length; i++) {
    const cur = groupStarts[i];
    if (!cur) continue;
    const next = groupStarts[i + 1];
    const end = next ? next.start : text.length;
    const moduleId = matcher.resolve(cur.codeName);
    const sections = findSectionHeaders(text, cur.start, end);
    groups.push({
      ordinance_section_number: cur.ordNum,
      code_name: cur.codeName,
      module_id: moduleId,
      text_offset_start: cur.start,
      text_offset_end: end,
      sections,
    });
  }
  return groups;
}

function findSectionHeaders(text: string, start: number, end: number): CodeGroup["sections"] {
  const slice = text.slice(start, end);
  const out: CodeGroup["sections"] = [];
  SECTION_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null = SECTION_HEADER_RE.exec(slice);
  const starts: Array<{ rawId: string; title: string; rel: number }> = [];
  while (m !== null) {
    starts.push({
      rawId: (m[1] ?? "").trim(),
      title: (m[2] ?? "").trim(),
      rel: m.index,
    });
    m = SECTION_HEADER_RE.exec(slice);
  }
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i];
    if (!cur) continue;
    const next = starts[i + 1];
    const relEnd = next ? next.rel : slice.length;
    out.push({
      raw_id: cur.rawId,
      title: cur.title,
      text_offset_start: start + cur.rel,
      text_offset_end: start + relEnd,
    });
  }
  return out;
}

function findStructuralAction(text: string): string | null {
  for (const re of STRUCTURAL_PATTERNS) {
    const m = re.exec(text);
    if (m !== null) return m[0];
  }
  return null;
}

// ── Module-id resolver ──────────────────────────────────────────────────

type ModuleMatcher = {
  resolve(codeName: string): ModuleId | null;
};

function buildModuleMatcher(installed: readonly InstalledModule[]): ModuleMatcher {
  // Build a longest-first stub list mirroring the scope-filter logic so
  // the structural pass and the title classifier agree on which name
  // resolves to which module.
  type Entry = { stub: string; moduleId: ModuleId };
  const entries: Entry[] = [];
  for (const mod of installed) {
    const stripped = mod.code_title.replace(/\s+(?:Code|Charter)\s*$/i, "").trim();
    const stub = stripped.length > 0 ? stripped : mod.code_title;
    entries.push({ stub: stub.toLowerCase(), moduleId: mod.id });
  }
  for (const [aliasName, moduleId] of Object.entries(SF_BILL_CODE_ALIASES)) {
    const stripped = aliasName.replace(/\s+(?:Code|Charter)\s*$/i, "").trim();
    const stub = stripped.length > 0 ? stripped : aliasName;
    entries.push({ stub: stub.toLowerCase(), moduleId });
  }
  entries.sort((a, b) => b.stub.length - a.stub.length);

  return {
    resolve(codeName: string): ModuleId | null {
      const lower = codeName
        .toLowerCase()
        .replace(/\s+(?:code|charter)$/i, "")
        .trim();
      for (const e of entries) {
        if (lower === e.stub) return e.moduleId;
      }
      return null;
    },
  };
}

/**
 * Apply ModuleConfig.display_rules to a raw section number extracted from
 * a bill PDF, producing the SectionId the corpus tree uses. Codex C3
 * replacement: the structural pass observes raw numbers like "102A" or
 * "109.0", but the existing module tree stores them as the prefixed/
 * stripped form ("b102a", "p109"). The renderer needs the corpus-tree
 * form to highlight the right node.
 *
 * Rules applied in order:
 *   strip_trailing_zero — ".0" suffix collapses ("109.0" → "109")
 *   alpha_suffix        — preserves trailing letter ("102A" not "102")
 *   prefix              — single-letter/digit prepend ("102a" → "b102a")
 *
 * Returns the lowercased candidate id; the caller validates it against
 * the loaded module's section index.
 */
export function applyDisplayRules(
  rawSectionId: string,
  rules:
    | {
        prefix?: string | null;
        extra_prefixes?: readonly string[];
        alpha_suffix?: boolean;
        strip_trailing_zero?: boolean;
        override_regex?: string | null;
      }
    | undefined,
): SectionId[] {
  // Lowercase to match the corpus tree's canonical form (SectionIds are
  // dotted/dashed lowercase per src/types/identifiers.ts).
  let normalized = rawSectionId.toLowerCase();
  if (!rules) {
    return [normalized as SectionId];
  }
  if (rules.strip_trailing_zero && normalized.endsWith(".0")) {
    normalized = normalized.slice(0, -2);
  }
  const prefixes: string[] = [];
  if (rules.prefix !== null && rules.prefix !== undefined && rules.prefix.length > 0) {
    prefixes.push(rules.prefix);
  }
  if (rules.extra_prefixes) {
    prefixes.push(...rules.extra_prefixes);
  }
  // Emit candidates: bare + each prefixed form. The caller probes each
  // against the section index and picks the first hit.
  const out: SectionId[] = [normalized as SectionId];
  for (const p of prefixes) {
    out.push(`${p}${normalized}` as SectionId);
  }
  return out;
}
