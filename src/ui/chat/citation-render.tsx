// Inline citation renderer for assistant prose. The conversation loop
// returns raw markdown; react-markdown handles **bold**, *italic*,
// `code`, lists, headings, blockquotes, etc. We then walk the rendered
// text nodes and replace citation patterns with clickable buttons.
//
// Three surface forms covered:
//   1. [module_id § section_id]   — qualified section form
//   2. § section_id               — bare section form (resolved against anchor module)
//   3. [Bill #file_no]            — session bill — opens the bill tab
//
// Code blocks (<code>, <pre>) are NOT tokenized — citations inside
// verbatim code stay as text.

import React, { type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { AiCorpusContextRef } from "@/ai/wire";
import { parseSourcesBlock, splitProseAndSources } from "@/parser/citation-verify";

interface ChatCitationProseProps {
  text: string;
  anchorModule: string;
  onCitationClick(ref: AiCorpusContextRef): void;
  /** Click handler for [Bill #file_no] citations. When omitted the
   *  bill text still renders as a styled span but is not clickable. */
  onBillClick?(fileNo: string): void;
}

interface CitationCtx {
  anchorModule: string;
  onCitationClick(ref: AiCorpusContextRef): void;
  onBillClick?(fileNo: string): void;
}

export function ChatCitationProse({
  text,
  anchorModule,
  onCitationClick,
  onBillClick,
}: ChatCitationProseProps) {
  const ctx: CitationCtx = { anchorModule, onCitationClick, onBillClick };
  // Per F2, the Sources block lives outside the body's flow so the
  // renderer can give it a distinct chip-grid treatment. Split first; if
  // there's no block, the body fills the whole space exactly as before.
  const { body, block } = splitProseAndSources(text);
  return (
    <div className="lc-chat-prose">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p>{renderInline(children, ctx)}</p>,
          li: ({ children }) => <li>{renderInline(children, ctx)}</li>,
          strong: ({ children }) => <strong>{renderInline(children, ctx)}</strong>,
          em: ({ children }) => <em>{renderInline(children, ctx)}</em>,
          h1: ({ children }) => <h1>{renderInline(children, ctx)}</h1>,
          h2: ({ children }) => <h2>{renderInline(children, ctx)}</h2>,
          h3: ({ children }) => <h3>{renderInline(children, ctx)}</h3>,
          h4: ({ children }) => <h4>{renderInline(children, ctx)}</h4>,
          h5: ({ children }) => <h5>{renderInline(children, ctx)}</h5>,
          h6: ({ children }) => <h6>{renderInline(children, ctx)}</h6>,
          blockquote: ({ children }) => <blockquote>{renderInline(children, ctx)}</blockquote>,
          // Code stays verbatim — citation syntax inside backticks is intentional content.
        }}
      >
        {body}
      </ReactMarkdown>
      {block ? <SourcesBlock block={block} ctx={ctx} /> : null}
    </div>
  );
}

/**
 * Render the trailing Sources block as a labeled chip grid. Empty,
 * single-entry, multi-entry, and unknown-entry cases all render — the
 * shared parser is the ground truth, so any non-broken case the
 * verifier accepts also renders here. An entry whose ref is
 * unparseable (e.g. the model wrote freeform text inside the brackets)
 * falls back to a plain styled span so the visual contract still
 * holds when the model goes off-script.
 */
function SourcesBlock({ block, ctx }: { block: string; ctx: CitationCtx }) {
  const parsed = parseSourcesBlock(block);
  if (!parsed.present) return null;
  return (
    <section className="lc-sources-block" aria-label="Sources">
      <div className="lc-sources-heading">Sources</div>
      {parsed.entries.length === 0 ? (
        <div className="lc-sources-empty">(no citations listed)</div>
      ) : (
        <ul className="lc-sources-list">
          {parsed.entries.map((e, i) => {
            if (e.kind === "section" && e.module_id && e.section_id) {
              const ref: AiCorpusContextRef = {
                module_id: e.module_id,
                section_id: e.section_id,
              };
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: shared parser produces deterministic order for the same input.
                  key={`src-${i}`}
                  className="lc-sources-item"
                >
                  <button
                    type="button"
                    className="lc-cite-inline lc-sources-chip"
                    onClick={(ev) => {
                      ev.preventDefault();
                      ctx.onCitationClick(ref);
                    }}
                    title={`${ref.module_id} § ${ref.section_id}`}
                  >
                    {e.display}
                  </button>
                  {e.title ? <span className="lc-sources-title"> — {e.title}</span> : null}
                </li>
              );
            }
            if (e.kind === "bill" && e.file_no) {
              const fileNo = e.file_no;
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: shared parser produces deterministic order for the same input.
                  key={`src-${i}`}
                  className="lc-sources-item"
                >
                  <button
                    type="button"
                    className="lc-cite-inline lc-cite-bill lc-sources-chip"
                    onClick={(ev) => {
                      ev.preventDefault();
                      ctx.onBillClick?.(fileNo);
                    }}
                    disabled={!ctx.onBillClick}
                    title={`Bill #${fileNo}`}
                  >
                    {e.display}
                  </button>
                  {e.title ? <span className="lc-sources-title"> — {e.title}</span> : null}
                </li>
              );
            }
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: shared parser produces deterministic order for the same input.
                key={`src-${i}`}
                className="lc-sources-item lc-sources-item-broken"
              >
                <span className="lc-cite-inline lc-sources-chip lc-sources-chip-broken">
                  {e.display}
                </span>
                {e.title ? <span className="lc-sources-title"> — {e.title}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Walk a ReactNode tree and tokenize strings into citation buttons.
 *  Recurses through elements but stops at our own citation buttons
 *  (className contains `lc-cite-`). Preserves React element wrappers
 *  like <strong>, <em>, <a> so bold/italic/links around a citation
 *  keep their formatting. */
function renderInline(node: ReactNode, ctx: CitationCtx): ReactNode {
  if (typeof node === "string") {
    return tokenizeString(node, ctx);
  }
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (node == null) return null;
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: children come from markdown parsing of a stable text — positions don't reorder between renders of the same prose.
      <React.Fragment key={`r-${i}`}>{renderInline(child, ctx)}</React.Fragment>
    ));
  }
  if (React.isValidElement(node)) {
    const props = node.props as { className?: string; children?: ReactNode };
    if (typeof props.className === "string" && props.className.includes("lc-cite-")) {
      return node;
    }
    // Don't recurse into <code> — citations inside code stay verbatim.
    if (node.type === "code") return node;
    if (props.children === undefined) return node;
    return React.cloneElement(node, undefined, renderInline(props.children, ctx));
  }
  return node;
}

function tokenizeString(text: string, ctx: CitationCtx): ReactNode {
  const matches = findCitations(text);
  if (matches.length === 0) return text;
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      out.push(text.slice(cursor, match.start));
    }
    if (match.kind === "bill") {
      const fileNo = match.fileNo;
      out.push(
        <button
          type="button"
          key={`b-${match.start}`}
          className="lc-cite-inline lc-cite-bill"
          onClick={(e) => {
            e.preventDefault();
            ctx.onBillClick?.(fileNo);
          }}
          disabled={!ctx.onBillClick}
          title={`Bill #${fileNo}`}
        >
          {match.display}
        </button>,
      );
    } else {
      const ref: AiCorpusContextRef = match.qualified ?? {
        module_id: ctx.anchorModule,
        section_id: match.sectionId,
      };
      out.push(
        <button
          type="button"
          key={`s-${match.start}`}
          className="lc-cite-inline"
          onClick={(e) => {
            e.preventDefault();
            ctx.onCitationClick(ref);
          }}
          title={`${ref.module_id} § ${ref.section_id}`}
        >
          {match.display}
        </button>,
      );
    }
    cursor = match.end;
  }
  if (cursor < text.length) {
    out.push(text.slice(cursor));
  }
  return out;
}

type CitationMatch =
  | {
      kind: "section";
      start: number;
      end: number;
      display: string;
      qualified: { module_id: string; section_id: string } | null;
      sectionId: string;
    }
  | {
      kind: "bill";
      start: number;
      end: number;
      display: string;
      fileNo: string;
    };

const QUALIFIED_RE = /\[([a-z][a-z0-9-]*)\s*§\s*([a-z0-9][a-z0-9._-]*)\]/gi;
const BARE_RE = /§\s+([a-z0-9][a-z0-9._-]*)/gi;
// [Bill #260542] — bracketed, hash-prefixed file_no. Numeric only;
// SF Legistar file numbers are 6 digits today but the regex accepts
// 3+ for future-proofing across jurisdictions.
const BILL_RE = /\[Bill\s+#([0-9]{3,})\]/gi;

function findCitations(text: string): CitationMatch[] {
  const matches: CitationMatch[] = [];
  for (const m of text.matchAll(QUALIFIED_RE)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const moduleId = (m[1] ?? "").toLowerCase();
    const sectionId = (m[2] ?? "").toLowerCase();
    matches.push({
      kind: "section",
      start: idx,
      end: idx + m[0].length,
      display: m[0],
      qualified: { module_id: moduleId, section_id: sectionId },
      sectionId,
    });
  }
  for (const m of text.matchAll(BILL_RE)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    matches.push({
      kind: "bill",
      start: idx,
      end: idx + m[0].length,
      display: m[0],
      fileNo: m[1] ?? "",
    });
  }
  for (const m of text.matchAll(BARE_RE)) {
    const idx = m.index ?? -1;
    if (idx < 0) continue;
    const end = idx + m[0].length;
    if (matches.some((q) => idx >= q.start && idx < q.end)) continue;
    const sectionId = (m[1] ?? "").toLowerCase();
    matches.push({
      kind: "section",
      start: idx,
      end,
      display: m[0],
      qualified: null,
      sectionId,
    });
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
