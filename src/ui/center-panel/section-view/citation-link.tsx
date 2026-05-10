// Renders a single citation segment as an `<a>` with kind-discriminated
// data attributes. The data attrs are the contract that
// `feat/citation-resolution` (#9) consumes — the link itself has no `href`
// and click handling stays a no-op until #9 wires resolution.
//
// Indirection layout: `BodySegment` (type:"citation") carries `raw` +
// `citation_index`. The discriminator (kind/target/subsection/range) lives
// on `section.citations[citation_index]` (validated by the section schema's
// superRefine — see src/types/section.ts:286). This component reads the
// indexed citation to emit per-kind attrs.

import type { Citation } from "@/types";

export interface CitationLinkProps {
  raw: string;
  citation: Citation;
}

export function CitationLink({ raw, citation }: CitationLinkProps) {
  const target = citation.target;
  const dataAttrs: Record<string, string> = { "data-cite-kind": target.kind, "data-raw": raw };
  let kindClass = "lc-cite-vague";

  switch (target.kind) {
    case "internal":
      kindClass = "lc-cite-internal";
      dataAttrs["data-section-id"] = target.section_id;
      if (target.subsection) dataAttrs["data-subsection"] = target.subsection;
      if (target.range) {
        dataAttrs["data-range-from"] = target.range.from;
        dataAttrs["data-range-to"] = target.range.to;
      }
      break;
    case "cross_module":
      kindClass = "lc-cite-internal";
      dataAttrs["data-module-id"] = target.module_id;
      dataAttrs["data-section-id"] = target.section_id;
      if (target.subsection) dataAttrs["data-subsection"] = target.subsection;
      if (target.range) {
        dataAttrs["data-range-from"] = target.range.from;
        dataAttrs["data-range-to"] = target.range.to;
      }
      break;
    case "external":
      kindClass = "lc-cite-external";
      break;
    case "vague":
      kindClass = "lc-cite-vague";
      break;
    case "internal_appendix":
      kindClass = "lc-cite-internal";
      dataAttrs["data-appendix-id"] = target.appendix_id;
      break;
  }

  return (
    // biome-ignore lint/a11y/useValidAnchor: navigation lands in feat/citation-resolution (#9); the link is render-only
    <a className={`lc-cite ${kindClass}`} {...dataAttrs}>
      {raw}
    </a>
  );
}
