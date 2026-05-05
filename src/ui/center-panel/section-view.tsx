// Section view — the center-panel reader for a single corpus section.
// Renders the section number, title, parents kicker, optional editorial
// status (when not "active"), and the section text split into paragraphs
// on blank lines. Inline citations, defined-term highlights, amendment
// banners, line numbers, and the minimap are owned by feat/section-view
// (Phase 2) and will replace this component wholesale; nothing about the
// current shape is structural for downstream branches.

import type { CorpusSectionView } from "../../../electron/ipc/contract";

export interface SectionViewProps {
  view: CorpusSectionView | null;
  /** Pretty parents string for the kicker — e.g. "Port Code · ARTICLE 1". */
  parentsLabel: string;
}

export function SectionView({ view, parentsLabel }: SectionViewProps) {
  if (!view) {
    return (
      <div className="lc-doc lc-scroll">
        <div className="lc-doc-inner">
          <div className="lc-doc-title">No section selected</div>
        </div>
      </div>
    );
  }

  const { section } = view;
  const editorialLabel = section.editorial_status !== "active" ? section.editorial_status : null;
  const paragraphs = section.text.split(/\n\s*\n+/).filter((p) => p.trim().length > 0);

  return (
    <div className="lc-doc lc-scroll" data-testid="section-view">
      <div className="lc-doc-inner">
        <div className="lc-doc-title">{parentsLabel}</div>
        <h1 className="lc-section" style={{ marginBottom: 4 }}>
          <span className="lc-section-id">§ {section.id}</span>
          <span style={{ marginLeft: 12 }}>{section.title}</span>
        </h1>
        {editorialLabel ? (
          <div className="lc-section-meta">Editorial status: {editorialLabel}</div>
        ) : null}
        <div style={{ marginTop: 24 }}>
          {paragraphs.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional; index is stable for a given section
            <p key={i} className="lc-para">
              {p}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
