// Ordinance reference index. Walks every loaded section's text on first
// call, regex-extracts the embedded ordinance citations the AmLegal
// parser preserves verbatim as prose, and dedupes by ordinance number.
//
// Why text scan, not ordinance-history/*.json:
//   The corpus parser writes the OrdinanceHistory file shape but does
//   not currently populate `items: []` for AmLegal output (separate
//   branch). The same data is preserved in body text as the "AMENDMENT
//   HISTORY" footer the corpus reader sees — e.g. "Added by Ord. 50-15,
//   File No. 150149, App. 4/24/2015, Eff. 5/24/2015". Reading from the
//   live source means the AI module surfaces the data that exists today
//   rather than the data the digest-extraction pipeline was meant to
//   produce.
//
// Both `get_section_history` and `list_recent_ordinances` read from
// here. Same index, same dedupe, same date parsing — the two tools
// project differently (per-section vs. corpus-wide) but agree on every
// ordinance's date and cited-in set.

import type { AiCorpusHandle } from "../corpus-loader";

export interface OrdinanceCitation {
  /** "193-23", "50-15", "212-10" — verbatim from the section text. */
  ordinance_number: string;
  /** Numeric year derived from the suffix. "193-23" → 2023; "168-98" → 1998. */
  year: number;
  /** "230764" when the section text quotes a File No.; null otherwise. */
  file_number: string | null;
  /** ISO date (YYYY-MM-DD) parsed from `App. M/D/YYYY`; null if absent. */
  approved_at: string | null;
  /** ISO date parsed from `Eff. M/D/YYYY`; null if absent. */
  effective_at: string | null;
  /** Sections this ordinance is cited in, qualified. Deduped. */
  cited_in: readonly { module_id: string; section_id: string }[];
}

export interface OrdinanceIndex {
  /** Ordinances cited in the given section, newest first. Empty if none. */
  bySection(mod: string, section: string): readonly OrdinanceCitation[];
  /** Ordinances across the corpus, newest first. Filter + cap applied. */
  recent(opts: { moduleId?: string; year?: number; limit: number }): {
    total: number;
    ordinances: readonly OrdinanceCitation[];
  };
}

let cached: { corpusHash: string; index: OrdinanceIndex } | null = null;

export function getOrdinanceIndex(handle: AiCorpusHandle): OrdinanceIndex {
  if (cached && cached.corpusHash === handle.corpusHash) return cached.index;
  cached = { corpusHash: handle.corpusHash, index: buildOrdinanceIndex(handle) };
  return cached.index;
}

/** Test seam. */
export function __resetOrdinanceIndexForTests(): void {
  cached = null;
}

// ─── Index construction ────────────────────────────────────────────────────

// Pattern observed in the SF AmLegal corpus:
//   "Ord. 193-23, File No. 230764, App. 9/15/2023, Eff. 10/16/2023"
//   "Ord. 50-15, File No. 150149, App. 4/24/2015, Eff. 5/24/2015"
//   "Ord. 212-10, File No. 100703, App. 8/4/2010"   (no Eff)
//   "Ord. 153-93, App. 5/25/93"                      (1990s — short year, no File No.)
//
// Strategy: anchor on `Ord. NUMBER-YEAR`, then opportunistically scrape
// the trailing File / App / Eff fields. The body builder preserves
// newlines around the AMENDMENT HISTORY footer but the relevant fields
// always sit on the same logical sentence as the Ord. anchor.
const ORD_REF_RE =
  /Ord\.\s+(\d+-\d{2,4})(?:[^A-Za-z]*?File\s+No\.\s+(\d+))?(?:[^A-Za-z]*?App\.\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))?(?:[^A-Za-z]*?Eff\.\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))?/g;

function buildOrdinanceIndex(handle: AiCorpusHandle): OrdinanceIndex {
  // Dedup key: ordinance_number. Per the SF numbering scheme, an
  // ordinance number ("193-23") is unique across the year. Same
  // ordinance amending multiple sections shows up as multiple entries
  // in `cited_in[]` but one entry in the index.
  const byNumber = new Map<string, OrdinanceCitation>();

  for (const mod of handle.modules) {
    for (const wrap of mod.sections) {
      const text = wrap.section.text;
      if (!text.includes("Ord.")) continue;
      // Reset the regex's lastIndex implicitly via the for-of iterator
      // returned by matchAll.
      for (const match of text.matchAll(ORD_REF_RE)) {
        const ordinance_number = match[1];
        if (!ordinance_number) continue;
        const file_number = match[2] ?? null;
        const approvedRaw = match[3] ?? null;
        const effectiveRaw = match[4] ?? null;

        const year = yearFromOrdinanceNumber(ordinance_number);
        const cite: { module_id: string; section_id: string } = {
          module_id: mod.id,
          section_id: wrap.section.id,
        };

        const existing = byNumber.get(ordinance_number);
        if (existing) {
          // Merge cited_in (dedup); keep the most informative dates from
          // either occurrence. Different sections may cite the same
          // ordinance with slightly different field availability.
          const cited_in = existing.cited_in.some(
            (r) => r.module_id === cite.module_id && r.section_id === cite.section_id,
          )
            ? existing.cited_in
            : [...existing.cited_in, cite];
          byNumber.set(ordinance_number, {
            ...existing,
            file_number: existing.file_number ?? file_number,
            approved_at: existing.approved_at ?? toIsoDate(approvedRaw, year),
            effective_at: existing.effective_at ?? toIsoDate(effectiveRaw, year),
            cited_in,
          });
        } else {
          byNumber.set(ordinance_number, {
            ordinance_number,
            year,
            file_number,
            approved_at: toIsoDate(approvedRaw, year),
            effective_at: toIsoDate(effectiveRaw, year),
            cited_in: [cite],
          });
        }
      }
    }
  }

  const ordered = [...byNumber.values()].sort(compareNewestFirst);

  // Per-section reverse index. The bySection() lookup is the per-section
  // pivot get_section_history needs; keeping it as a Map<refKey, []>
  // avoids re-scanning ordered[] for every call.
  const sectionMap = new Map<string, OrdinanceCitation[]>();
  for (const ord of ordered) {
    for (const cite of ord.cited_in) {
      const key = `${cite.module_id}::${cite.section_id}`;
      const bucket = sectionMap.get(key);
      if (bucket) bucket.push(ord);
      else sectionMap.set(key, [ord]);
    }
  }

  return {
    bySection(mod: string, section: string): readonly OrdinanceCitation[] {
      return sectionMap.get(`${mod}::${section}`) ?? [];
    },
    recent(opts: { moduleId?: string; year?: number; limit: number }): {
      total: number;
      ordinances: readonly OrdinanceCitation[];
    } {
      const filtered = ordered.filter((ord) => {
        if (opts.year !== undefined && ord.year !== opts.year) return false;
        if (opts.moduleId !== undefined) {
          if (!ord.cited_in.some((r) => r.module_id === opts.moduleId)) return false;
        }
        return true;
      });
      return {
        total: filtered.length,
        ordinances: filtered.slice(0, Math.max(0, opts.limit)),
      };
    },
  };
}

// ─── Date parsing ──────────────────────────────────────────────────────────

// Expand "5/25/93" → "1993-05-25" using the ordinance year as the
// century-disambiguation hint. SF AmLegal uses two-digit years for
// pre-2000 ordinances and four-digit years thereafter; the ordinance
// number suffix tracks the same era so we can reuse it as a tiebreaker
// when the date column is short.
function toIsoDate(raw: string | null, ordinanceYear: number): string | null {
  if (!raw) return null;
  const parts = raw.split("/");
  if (parts.length !== 3) return null;
  const month = Number.parseInt(parts[0] ?? "", 10);
  const day = Number.parseInt(parts[1] ?? "", 10);
  let year = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  if (year < 100) {
    // Two-digit; lean on the ordinance year's century.
    const ordCentury = Math.floor(ordinanceYear / 100) * 100;
    year += ordCentury;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// Year suffix on "193-23" / "168-98" / "212-10" maps to 2023 / 1998 / 2010.
// SF Board of Supervisors started numbering ordinances in the 1880s, but
// the corpus only carries 1990+ records; anything with a 2-digit suffix
// ≥ 90 is 19xx, otherwise 20xx. The four-digit form (rare) is taken
// verbatim.
function yearFromOrdinanceNumber(number: string): number {
  const suffix = number.split("-")[1] ?? "";
  if (suffix.length === 4) {
    const n = Number.parseInt(suffix, 10);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number.parseInt(suffix, 10);
  if (!Number.isFinite(n)) return 0;
  return n >= 90 ? 1900 + n : 2000 + n;
}

function compareNewestFirst(a: OrdinanceCitation, b: OrdinanceCitation): number {
  // Primary: effective date when available, then approved, then year.
  // The ordinance number sequence within a year is monotonic so it's a
  // stable tiebreaker.
  const aDate = a.effective_at ?? a.approved_at ?? "";
  const bDate = b.effective_at ?? b.approved_at ?? "";
  if (aDate && bDate && aDate !== bDate) return bDate.localeCompare(aDate);
  if (a.year !== b.year) return b.year - a.year;
  // Numeric prefix of the ordinance number ("193-23" → 193). Larger
  // means later in the same year.
  const aN = Number.parseInt(a.ordinance_number.split("-")[0] ?? "0", 10);
  const bN = Number.parseInt(b.ordinance_number.split("-")[0] ?? "0", 10);
  return bN - aN;
}
