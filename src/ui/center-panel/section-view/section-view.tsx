// Section view — the centre-panel reader for a single corpus section.
// Iterates `section.body[]` (the BodySegment discriminated union shipped
// in #6.5) into React, rendering citations, defined-terms, subsection
// labels, and inline formatting without re-parsing text. Three top-level
// states:
//
//   error  →  in-section error banner replaces the body (D8 + C7).
//             App.tsx clears `view` to null on `corpus.read` ok:false so
//             stale chrome (breadcrumb, parents kicker) doesn't leak.
//   null   →  "No section selected" placeholder. Only visible if the
//             workbench has no active section item; corpus:read latency
//             on the in-memory loader is negligible so a transient
//             loading state isn't user-visible.
//   view   →  full render: parents kicker, § id + title, editorial chip
//             (when status !== "active"), redesignated redirect link
//             (when redirect_to is set), then body iteration.
//
// Body iteration: split body[] at top-level `paragraph_break` segments
// and render each chunk inside `<p class="lc-para">`. Within a paragraph,
// recurse into `format` children for bold/italic/list/listItem wrappers.
// The roundtrip-invariant `bodyToText(body) === text` guarantees the
// rendered text matches what search/export sees (enforced by
// SectionFileSchema.superRefine at src/types/section.ts:286).

import type { ReactNode } from "react";
import { type CorpusRef, parse as parseCorpusRef } from "@/corpus/refs";
import type { CorpusError, CorpusSectionView } from "@/corpus/wire";
import type { BodySegment, Citation, SectionId } from "@/types";
import { CitationLink } from "./citation-link";
import { DefinedTerm } from "./defined-term";
import "./section-view.css";

export interface SectionViewProps {
  view: CorpusSectionView | null;
  /** Pretty parents string for the kicker — e.g. "Port Code · ARTICLE 1". */
  parentsLabel: string;
  /** Set when corpus.read returns ok:false; replaces the body with a banner (D8). */
  error: CorpusError | null;
  /** Used by defined-term tooltip jump-links and the redesignated redirect link. */
  onActivate: (ref: CorpusRef) => void;
}

interface RenderCtx {
  citations: ReadonlyArray<Citation>;
  definitions: CorpusSectionView["definitions"];
  onJump: (sectionId: SectionId) => void;
}

export function SectionView({ view, parentsLabel, error, onActivate }: SectionViewProps) {
  if (error) {
    return (
      <div className="lc-doc lc-scroll" data-testid="section-view">
        <div className="lc-doc-inner">
          <div className="lc-section-error" role="alert">
            <div className="lc-section-error-title">Couldn't load this section</div>
            <div className="lc-section-error-detail">{error.detail}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="lc-doc lc-scroll">
        <div className="lc-doc-inner">
          <div className="lc-doc-title">No section selected</div>
        </div>
      </div>
    );
  }

  const { section, moduleId } = view;
  const onJump = (sectionId: SectionId) =>
    onActivate(parseCorpusRef({ module: moduleId, section: sectionId }));
  const ctx: RenderCtx = {
    citations: section.citations,
    definitions: view.definitions,
    onJump,
  };

  const paragraphs = splitParagraphs(section.body);

  return (
    <div className="lc-doc lc-scroll" data-testid="section-view">
      <div className="lc-doc-inner">
        <div className="lc-doc-title">{parentsLabel}</div>
        <h1 className="lc-section" style={{ marginBottom: 4 }}>
          <span className="lc-section-id">§ {section.id}</span>
          <span style={{ marginLeft: 12 }}>{section.title}</span>
        </h1>
        {section.editorial_status !== "active" ? (
          <div className="lc-section-meta">
            <span className="lc-status-chip" data-status={section.editorial_status}>
              {section.editorial_status}
            </span>
            {section.editorial_status === "redesignated" && section.redirect_to ? (
              <button
                type="button"
                className="lc-redirect-link"
                onClick={() =>
                  onActivate(parseCorpusRef({ module: moduleId, section: section.redirect_to! }))
                }
              >
                See § {section.redirect_to}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="lc-section-body">
          {paragraphs.map((segs, pi) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional within a stable section render
            <p key={pi} className="lc-para">
              {renderInline(segs, ctx, `p${pi}`)}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Split body[] at top-level paragraph_break segments. paragraph_break is
 * a flat marker (not a wrapping Paragraph[]) per the schema. Empty
 * paragraphs are dropped — they only happen when consecutive
 * paragraph_breaks slip through the parser, and rendering an empty <p>
 * just creates ghost vertical space.
 */
function splitParagraphs(body: readonly BodySegment[]): BodySegment[][] {
  const out: BodySegment[][] = [];
  let current: BodySegment[] = [];
  for (const seg of body) {
    if (seg.type === "paragraph_break") {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(seg);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function renderInline(
  segs: readonly BodySegment[],
  ctx: RenderCtx,
  keyPrefix: string,
): ReactNode[] {
  return segs.map((seg, i) => renderSegment(seg, ctx, `${keyPrefix}-${i}`));
}

function renderSegment(seg: BodySegment, ctx: RenderCtx, key: string): ReactNode {
  switch (seg.type) {
    case "text":
      return <span key={key}>{seg.text}</span>;
    case "citation": {
      const citation = ctx.citations[seg.citation_index];
      if (!citation) return <span key={key}>{seg.raw}</span>;
      return <CitationLink key={key} raw={seg.raw} citation={citation} />;
    }
    case "defined_term": {
      // Object.hasOwn guard: definitions arrives as a plain object after
      // IPC's JSON round-trip, so a term named "constructor" / "toString"
      // would otherwise read an inherited function from Object.prototype
      // and crash on tooltip hover.
      const entries = Object.hasOwn(ctx.definitions, seg.term)
        ? ctx.definitions[seg.term]
        : undefined;
      return <DefinedTerm key={key} term={seg.term} definitions={entries} onJump={ctx.onJump} />;
    }
    case "subsection_label":
      return (
        <span key={key} className="lc-subsection-label">
          {seg.label}
        </span>
      );
    case "format":
      return renderFormat(seg, ctx, key);
    case "paragraph_break":
      // Nested paragraph_break inside format children — the schema
      // permits it but the parser doesn't emit it. Render as nothing
      // so a regression doesn't surface as a crash.
      return null;
  }
}

function renderFormat(
  seg: Extract<BodySegment, { type: "format" }>,
  ctx: RenderCtx,
  key: string,
): ReactNode {
  const children = renderInline(seg.children, ctx, key);
  switch (seg.style) {
    case "bold":
      return <strong key={key}>{children}</strong>;
    case "italic":
      return <em key={key}>{children}</em>;
    case "list":
      return (
        <ul key={key} className="lc-format-list">
          {children}
        </ul>
      );
    case "listItem":
      return (
        <li key={key} className="lc-format-list-item">
          {children}
        </li>
      );
  }
}
