import type { ModuleId } from "@/types";

// Code-name aliases the structural-anchoring spike (2026-05-30) found in
// the SF Legistar corpus: the canonical `code_title` in the manifest is the
// preferred form, but operator-curated aliases catch the strings AmLegal
// publishes that don't algorithmically match it. Add entries here as new
// drift surfaces.
//
// Current entries (1):
//   "Building Inspection Code" — AmLegal's variant of the manifest's
//     "Building Code". Observed in 260217.
//
// Aliases are intentionally restricted to the SF jurisdiction because
// Legistar's verbiage drift is jurisdiction-specific; CA Assembly and US
// Congress have their own corpora and their own drift surfaces, which get
// their own files under src/parser/bills/aliases/ when those jurisdictions
// arrive.
export const SF_BILL_CODE_ALIASES: Readonly<Record<string, ModuleId>> = Object.freeze({
  "Building Inspection Code": "sf-building",
});
