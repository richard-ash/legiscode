// Static registry of known external code modules. Provides the stable
// `module_id` + display name for citations that reference an out-of-module
// code (California codes, US Code). Entries are listed even when the
// module's bundle does not ship today (v1 ships sf-* only); the registry
// is what makes "California Vehicle Code § 515" resolvable as a
// cross_module citation with a known module identity, so the popover can
// say "{display_name} not downloaded" instead of treating the cite as
// dead-external.
//
// The phrase patterns are also the source of truth for the parser's
// code-phrase scope tracking (L3): when the parser sees "California
// Vehicle Code" it sets an active code-prefix for the paragraph; every
// § cite inside that paragraph is then classified as cross_module with
// the matching module_id.

import type { ModuleId } from "@/types";

export interface ModuleRegistryEntry {
  readonly module_id: ModuleId;
  readonly display_name: string;
}

interface RegistryEntryInternal {
  readonly entry: ModuleRegistryEntry;
  // Phrase patterns that route text → module_id. Longer / more-specific
  // patterns must be listed first within a single entry so a partial
  // match doesn't shadow a fully-qualified one.
  readonly phrases: readonly RegExp[];
}

// California codes — the 29 enumerated by Cal. Gov. Code § 9605. Adding a
// code is mechanical: append an entry. Naming follows kebab-case ModuleId
// convention with the `ca-` jurisdiction prefix.
const CALIFORNIA_CODES: readonly RegistryEntryInternal[] = [
  {
    entry: {
      module_id: "ca-business-professions",
      display_name: "California Business and Professions Code",
    },
    phrases: [/\bBus(?:iness)?\.?\s+(?:and|&)\s+Prof(?:essions)?\.?\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-civil", display_name: "California Civil Code" },
    phrases: [/\bCal\.?\s+Civ(?:il)?\.?\s+Code\b/i, /\bCivil\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-civil-procedure", display_name: "California Code of Civil Procedure" },
    phrases: [/\bCode\s+of\s+Civ(?:il)?\.?\s+Proc(?:edure)?\b/i, /\bC\.?C\.?P\.?\b/i],
  },
  {
    entry: { module_id: "ca-commercial", display_name: "California Commercial Code" },
    phrases: [/\bCal\.?\s+Com(?:mercial)?\.?\s+Code\b/i, /\bCommercial\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-corporations", display_name: "California Corporations Code" },
    phrases: [/\bCal\.?\s+Corp(?:orations)?\.?\s+Code\b/i, /\bCorporations\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-education", display_name: "California Education Code" },
    phrases: [/\bCal\.?\s+Educ(?:ation)?\.?\s+Code\b/i, /\bEducation\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-elections", display_name: "California Elections Code" },
    phrases: [/\bCal\.?\s+Elec(?:tions)?\.?\s+Code\b/i, /\bElections\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-evidence", display_name: "California Evidence Code" },
    phrases: [/\bCal\.?\s+Evid(?:ence)?\.?\s+Code\b/i, /\bEvidence\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-family", display_name: "California Family Code" },
    phrases: [/\bCal\.?\s+Fam(?:ily)?\.?\s+Code\b/i, /\bFamily\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-financial", display_name: "California Financial Code" },
    phrases: [/\bCal\.?\s+Fin(?:ancial)?\.?\s+Code\b/i, /\bFinancial\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-fish-game", display_name: "California Fish and Game Code" },
    phrases: [/\bFish\s+(?:and|&)\s+Game\s+Code\b/i],
  },
  {
    entry: {
      module_id: "ca-food-agriculture",
      display_name: "California Food and Agricultural Code",
    },
    phrases: [/\bFood\s+(?:and|&)\s+Agric(?:ultural)?\.?\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-government", display_name: "California Government Code" },
    phrases: [/\bCal\.?\s+Gov(?:'t|ernment)?\.?\s+Code\b/i, /\bGov(?:'t|ernment)\s+Code\b/i],
  },
  {
    entry: {
      module_id: "ca-harbors-navigation",
      display_name: "California Harbors and Navigation Code",
    },
    phrases: [/\bHarbors\s+(?:and|&)\s+Navigation\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-health-safety", display_name: "California Health and Safety Code" },
    phrases: [/\bHealth\s+(?:and|&)\s+Safety\s+Code\b/i],
  },
  // ca-unemployment-insurance must precede ca-insurance: "Unemployment
  // Insurance Code" contains "Insurance Code" as a suffix and would
  // otherwise route to the wrong module.
  {
    entry: {
      module_id: "ca-unemployment-insurance",
      display_name: "California Unemployment Insurance Code",
    },
    phrases: [/\bUnemp(?:loyment)?\.?\s+Ins(?:urance)?\.?\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-insurance", display_name: "California Insurance Code" },
    phrases: [/\bCal\.?\s+Ins(?:urance)?\.?\s+Code\b/i, /\bInsurance\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-labor", display_name: "California Labor Code" },
    phrases: [/\bCal\.?\s+Lab(?:or)?\.?\s+Code\b/i, /\bLabor\s+Code\b/i],
  },
  {
    entry: {
      module_id: "ca-military-veterans",
      display_name: "California Military and Veterans Code",
    },
    phrases: [/\bMil(?:itary)?\.?\s+(?:and|&)\s+Vet(?:erans)?\.?\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-penal", display_name: "California Penal Code" },
    phrases: [/\bCal\.?\s+Pen(?:al)?\.?\s+Code\b/i, /\bPenal\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-probate", display_name: "California Probate Code" },
    phrases: [/\bCal\.?\s+Prob(?:ate)?\.?\s+Code\b/i, /\bProbate\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-public-contract", display_name: "California Public Contract Code" },
    phrases: [/\bPub(?:lic)?\.?\s+Contract\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-public-resources", display_name: "California Public Resources Code" },
    phrases: [
      /\bCal\.?\s+Pub\.?\s+Res(?:ources)?\.?\s+Code\b/i,
      /\bPub(?:lic)?\.?\s+Res(?:ources)?\.?\s+Code\b/i,
    ],
  },
  {
    entry: { module_id: "ca-public-utilities", display_name: "California Public Utilities Code" },
    phrases: [/\bPub(?:lic)?\.?\s+Util(?:ities)?\.?\s+Code\b/i],
  },
  {
    entry: {
      module_id: "ca-revenue-taxation",
      display_name: "California Revenue and Taxation Code",
    },
    phrases: [/\bRev(?:enue)?\.?\s+(?:and|&)\s+Tax(?:ation)?\.?\s+Code\b/i],
  },
  {
    entry: {
      module_id: "ca-streets-highways",
      display_name: "California Streets and Highways Code",
    },
    phrases: [/\bStreets\s+(?:and|&)\s+Highways\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-vehicle", display_name: "California Vehicle Code" },
    phrases: [/\bCal\.?\s+Veh(?:icle)?\.?\s+Code\b/i, /\bC\.?V\.?C\.?\b/i, /\bVehicle\s+Code\b/i],
  },
  {
    entry: { module_id: "ca-water", display_name: "California Water Code" },
    phrases: [/\bCal\.?\s+Water\s+Code\b/i, /\bWater\s+Code\b/i],
  },
  {
    entry: {
      module_id: "ca-welfare-institutions",
      display_name: "California Welfare and Institutions Code",
    },
    phrases: [/\bWelf(?:are)?\.?\s+(?:and|&)\s+Inst(?:itutions)?\.?\s+Code\b/i],
  },
];

const FEDERAL: readonly RegistryEntryInternal[] = [
  {
    entry: { module_id: "us-code", display_name: "United States Code" },
    phrases: [/\bU\.?S\.?C\.?\b/i],
  },
  {
    entry: { module_id: "us-cfr", display_name: "Code of Federal Regulations" },
    phrases: [/\bC\.?F\.?R\.?\b/i, /\bCode\s+of\s+Federal\s+Regulations\b/i],
  },
];

const REGISTRY: readonly RegistryEntryInternal[] = [...CALIFORNIA_CODES, ...FEDERAL];

/**
 * Find the module that matches a code-phrase substring (e.g. "California
 * Vehicle Code"). Returns null when no phrase matches. Patterns within an
 * entry are tested in declaration order; entries themselves are tested in
 * registry order, so unique-prefix phrases land before shared-suffix ones.
 */
export function findModuleByPhrase(text: string): ModuleRegistryEntry | null {
  for (const { entry, phrases } of REGISTRY) {
    for (const re of phrases) {
      if (re.test(text)) return entry;
    }
  }
  return null;
}

/**
 * Look up an entry by stable module_id. Used by the resolver to format
 * the "{display_name} not downloaded" popover label and by the parser
 * to attach `module_id` on a classified cross_module match.
 */
export function getModule(moduleId: ModuleId): ModuleRegistryEntry | null {
  for (const { entry } of REGISTRY) {
    if (entry.module_id === moduleId) return entry;
  }
  return null;
}

/** Iterate all registered modules. Used by tests + diagnostic surfaces. */
export function allModules(): readonly ModuleRegistryEntry[] {
  return REGISTRY.map((r) => r.entry);
}

export interface PhraseOccurrence {
  readonly start: number;
  readonly end: number;
  readonly module_id: ModuleId;
}

/**
 * Find every code-phrase occurrence inside the given text, ordered by
 * start offset. The parser uses this to track which external code is
 * "active" at any point in a paragraph: each occurrence sets the active
 * module_id for subsequent § cites until the paragraph boundary.
 */
export function findAllPhraseOccurrences(text: string): readonly PhraseOccurrence[] {
  if (!text) return [];
  const raw: PhraseOccurrence[] = [];
  for (const { entry, phrases } of REGISTRY) {
    for (const phrase of phrases) {
      const re = phrase.global ? phrase : new RegExp(phrase.source, `${phrase.flags}g`);
      for (const m of text.matchAll(re)) {
        if (m.index === undefined) continue;
        raw.push({
          start: m.index,
          end: m.index + m[0].length,
          module_id: entry.module_id,
        });
      }
    }
  }
  // Sort by start; on ties prefer the longer match so a more-specific
  // phrase wins over a substring (e.g. "Unemployment Insurance Code"
  // beats "Insurance Code" at the same anchor).
  raw.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  // Suppress overlaps: walking left-to-right, drop any occurrence that
  // starts before the previous one ended. The earlier-starting longer
  // phrase shadows the suffix match.
  const dedup: PhraseOccurrence[] = [];
  let lastEnd = -1;
  for (const o of raw) {
    if (o.start >= lastEnd) {
      dedup.push(o);
      lastEnd = o.end;
    }
  }
  return dedup;
}
