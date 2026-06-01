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
//
// The title character class accepts uppercase letters / digits / spaces
// plus the punctuation observed in the SF Legistar corpus:
//   - `-` hyphen-minus, `–` en-dash, `—` em-dash (titles like
//     "PERMIT REQUIRED – ENFORCEMENT.")
//   - `,` `;` `:` for separators (`POLICE; TRAFFIC REGULATION.`)
//   - `&` `'` for compound names (`POLICE & FIRE…`, `MAYOR'S OFFICE`)
//   - `(` `)` `.` for parenthetical / abbreviated suffixes
// New title-character variants get appended here as the corpus
// surfaces them. Per `project_legal_corpus_zero_skip` an undetected
// SEC. header is a parse-completeness regression, never an acceptable
// silent skip.
const SECTION_HEADER_RE =
  /^\s*(?:\d+\s+)?(?:SEC\.|SECTION|Section)\s+([0-9][0-9A-Za-z.-]*)\.\s+([A-Z][A-Z0-9\s\-–—,;:&'().]+)$/gm;

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
    /** Char offset of the `SEC.` (or `SECTION`/`Section`) keyword. */
    text_offset_start: number;
    /**
     * Char offset of the position right after the header's last char
     * (i.e. right after the title). The header itself can span more
     * than one line when the PDF extractor wraps a long title at the
     * ~80-char column. Body parsers slice from here forward to capture
     * the section's body without re-including the title.
     */
    text_offset_after_header: number;
    /** Char offset of the next section header's start (or group end). */
    text_offset_end: number;
  }>;
};

/**
 * Half-open char offset range over the structural pass's input text.
 * `[start, end)` — `start` is inclusive, `end` is exclusive. The body
 * parser slices the input directly with these.
 */
export type TextRange = {
  start: number;
  end: number;
};

export type StructuralPassResult = {
  /** All AMEND ordinance-section groups in document order. */
  groups: CodeGroup[];
  /**
   * Char offsets of the document preamble — every character before the
   * first AMEND group starts. Captures the bracket title block, the
   * ordinance long-title sentence, and the "Be it ordained…" enacting
   * clause that precede the first `Section N. <Code> Code is hereby
   * amended…` action line. When `groups` is empty (fallback shape), the
   * whole document is preamble.
   */
  preamble_range: TextRange;
  /**
   * Char offsets of the document closing — every character after the
   * last AMEND group ends. Captures boilerplate sections like
   * `Section 2. Scope of Ordinance.` / `Section 3. Effective Date.`
   * and the signature block (`APPROVED AS TO FORM:` + names). Empty
   * range when `groups` is empty or the document ends exactly at the
   * last group.
   */
  closing_range: TextRange;
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
  const closingStart = findClosingStart(text, groups);
  // Tighten the last group's range so closing boilerplate isn't
  // misattributed as part of an AMEND group's body. The structural-pass
  // group walker extends the final group's end to `text.length`; here
  // we pull it back to the closing boundary so the body parser slices
  // body text without the trailing "Section 2. Scope of Ordinance." /
  // signature material.
  if (groups.length > 0) {
    const last = groups[groups.length - 1];
    if (last && closingStart < last.text_offset_end) {
      last.text_offset_end = closingStart;
      const lastSection = last.sections[last.sections.length - 1];
      if (lastSection && lastSection.text_offset_end > closingStart) {
        lastSection.text_offset_end = closingStart;
      }
    }
  }
  const preambleEnd = groups[0]?.text_offset_start ?? text.length;
  return {
    groups,
    preamble_range: { start: 0, end: preambleEnd },
    closing_range: { start: closingStart, end: text.length },
    has_structural_action: structural !== null,
    structural_action_text: structural,
  };
}

// Closing boilerplate is identified by a non-AMEND `Section N. <Title>`
// line (e.g. "Section 2. Scope of Ordinance.", "Section 3. Effective
// Date.") or the `APPROVED AS TO FORM` signature opener. Both are stable
// in the SF Legistar template; new patterns get appended here as the
// corpus surfaces them.
const CLOSING_MARKER_RE =
  /^(?:\s*(?:\d+\s+)?Section\s+\d+[A-Z]?\.\s+[A-Z]|APPROVED\s+AS\s+TO\s+FORM\b)/gm;

function findClosingStart(text: string, groups: readonly CodeGroup[]): number {
  if (groups.length === 0) return text.length;
  const last = groups[groups.length - 1];
  if (!last) return text.length;
  // Scan from the start of the last AMEND group. The action line itself
  // matches CLOSING_MARKER_RE shape, so we skip every match whose trailing
  // context contains "is hereby amended" (those are AMEND lines, already
  // captured as groups).
  CLOSING_MARKER_RE.lastIndex = 0;
  const region = text.slice(last.text_offset_start);
  let m: RegExpExecArray | null = CLOSING_MARKER_RE.exec(region);
  while (m !== null) {
    const absStart = last.text_offset_start + m.index;
    const leadingWs = m[0].length - m[0].trimStart().length;
    const lineStart = absStart + leadingWs;
    const trailing = text.slice(lineStart, lineStart + 300);
    if (!/\bis\s+(?:hereby\s+)?amended\b/.test(trailing)) {
      return lineStart;
    }
    m = CLOSING_MARKER_RE.exec(region);
  }
  return text.length;
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
  const starts: Array<{
    rawId: string;
    title: string;
    rel: number;
    relAfterHeader: number;
  }> = [];
  while (m !== null) {
    starts.push({
      rawId: (m[1] ?? "").trim(),
      title: (m[2] ?? "").trim(),
      rel: m.index,
      relAfterHeader: m.index + m[0].length,
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
      text_offset_after_header: start + cur.relAfterHeader,
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
