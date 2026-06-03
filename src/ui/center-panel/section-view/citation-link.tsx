// Renders a single citation segment as a `<span>` so plain text
// selection works across citation boundaries. Click semantics live on
// the section-view body container: plain click is selection only,
// ⌘/Ctrl-click dispatches resolve() → navigate (VS Code-style).
//
// Indirection layout: `BodySegment` (kind:"citation") carries `raw` +
// `citation_index`. The discriminator (kind/target/subsection/range) lives
// on `section.citations[citation_index]` (validated by the section schema's
// superRefine — see src/types/section.ts). This component reads the indexed
// citation to emit per-kind data attributes the hover popover targets.

import type { Citation } from "@/types";

export interface CitationLinkProps {
  raw: string;
  citation: Citation;
  /** Index into `section.citations` — recovered by the delegated click
   *  handler via `data-citation-index` so the dispatch path doesn't need
   *  a per-link useCallback. */
  citation_index: number;
}

export function CitationLink({ raw, citation, citation_index }: CitationLinkProps) {
  const target = citation.target;
  const dataAttrs: Record<string, string> = {
    "data-cite-kind": target.kind,
    "data-raw": raw,
    "data-citation-index": String(citation_index),
  };

  switch (target.kind) {
    case "internal":
      dataAttrs["data-section-id"] = target.section_id;
      if (target.subsection) dataAttrs["data-subsection"] = target.subsection;
      if (target.range) {
        dataAttrs["data-range-from"] = target.range.from;
        dataAttrs["data-range-to"] = target.range.to;
      }
      break;
    case "cross_module":
      dataAttrs["data-module-id"] = target.module_id;
      dataAttrs["data-section-id"] = target.section_id;
      if (target.subsection) dataAttrs["data-subsection"] = target.subsection;
      if (target.range) {
        dataAttrs["data-range-from"] = target.range.from;
        dataAttrs["data-range-to"] = target.range.to;
      }
      break;
    case "structural":
      dataAttrs["data-structural-level"] = target.level;
      dataAttrs["data-structural-number"] = target.number;
      break;
    case "vague":
      break;
    case "internal_appendix":
      dataAttrs["data-appendix-id"] = target.appendix_id;
      break;
  }

  // A real <a> would invite default-href / right-click semantics that
  // conflict with the ⌘-click dispatch model; a span with role="link" +
  // tabIndex preserves keyboard reachability without the anchor's
  // URL-handling baggage.
  return (
    // biome-ignore lint/a11y/useSemanticElements: see comment above
    <span className="lc-cite" {...dataAttrs} role="link" tabIndex={0}>
      {raw}
    </span>
  );
}
