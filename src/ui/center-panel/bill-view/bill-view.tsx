// r11 bill detail. Compose the kicker + h1 + meta header, the long_title
// purpose block, the parse-status notice (when applicable), the Amends
// chips (navigation to affected sections), and the structured ordinance
// body parsed from the source PDF.
//
// Pre-typography-spike: each block renders without insertion/deletion
// coloring. When the spike addendum lands, paragraph + subsection
// content will be replaced by styled `text_diff[]` spans inside the
// same OrdinanceBlock tree, so the renderer's block layout doesn't
// change.

import { useCallback } from "react";
import type { CorpusRef } from "@/corpus/refs";
import type { Bill, OrdinanceBlock } from "@/types";
import type { NavigationIntent } from "@/workbench/navigate";
import type { OpenItem } from "@/workbench/open-items";
import { AmendsChips } from "./amends-chips";
import { BillHeader } from "./bill-header";
import "@/styles/bills.css";

export interface BillViewProps {
  /** Every per-module Bill row in the loaded corpus matching this
   *  view's file_no. Empty when the bill is no longer in the pending
   *  set (the empty inline notice surfaces instead of the header). */
  bills: ReadonlyArray<Bill>;
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
  /** ARIA wiring from tab-content. */
  tabPanel: { id: string; labelledBy: string };
  /** Display name for the kicker, e.g. "Police Code". Looked up from
   *  the module tree node by the App-level container. */
  codeLabel?: string;
  /** Synchronous (title) lookup keyed by section ref. Feeds the
   *  AmendsChips title field; chips fall back to the section id when
   *  the lookup returns null. */
  lookupSectionTitle?: (ref: CorpusRef) => string | null;
  /** Dispatches shell.openExternal for the first bill row's
   *  legistar_url. The IPC handler validates the protocol. Defaults
   *  to a no-op so tests that don't assert this seam don't have to
   *  thread the prop. */
  onOpenLegistar?: (url: string) => void;
}

export function BillView({
  bills,
  navigate,
  tabPanel,
  codeLabel,
  lookupSectionTitle,
  onOpenLegistar,
}: BillViewProps) {
  const first = bills[0];
  const handleOpenLegistar = useCallback(() => {
    if (!first || !onOpenLegistar) return;
    onOpenLegistar(first.legistar_url);
  }, [first, onOpenLegistar]);

  return (
    <div
      className="lc-billview"
      role="tabpanel"
      id={tabPanel.id}
      aria-labelledby={tabPanel.labelledBy}
    >
      <div className="lc-billview-inner">
        {first ? (
          <>
            <BillHeader
              bill={first}
              codeLabel={codeLabel ?? first.module_id}
              onOpenLegistar={handleOpenLegistar}
            />
            {first.long_title ? <p className="lc-billview-purpose">{first.long_title}</p> : null}
            <ParseStatusNotice bills={bills} />
            <AmendsChips
              bills={bills}
              navigate={navigate}
              lookupSectionTitle={lookupSectionTitle ?? noopLookup}
            />
            <ProposedText bills={bills} />
          </>
        ) : (
          <p className="lc-billparse-notice">This ordinance is no longer pending.</p>
        )}
      </div>
    </div>
  );
}

function noopLookup(): null {
  return null;
}

function ProposedText({ bills }: { bills: ReadonlyArray<Bill> }) {
  // The same source PDF generates every per-module Bill row for a given
  // file_no, so `body` is identical across `bills`. Render the first
  // one that has any content.
  const body = bills.find((b) => bodyHasContent(b.body))?.body;
  if (!body) return null;
  return (
    <section className="lc-billview-proposed" aria-labelledby="lc-billview-proposed-label">
      <h2 id="lc-billview-proposed-label" className="lc-billview-proposed-label">
        Ordinance text
      </h2>
      <div className="lc-billview-proposed-body">
        {body.preamble.length > 0 ? <ProseBlock text={body.preamble} /> : null}
        {body.sections.map((section, sIdx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: section order is the body parser's emit order; no stable id exists.
          <article key={sIdx} className="lc-billview-section">
            <p className="lc-billview-action">{section.action}</p>
            {section.body.map((block, bIdx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: block order is fixed by the tokenizer for a given section.
              <OrdinanceBlockView key={bIdx} block={block} />
            ))}
          </article>
        ))}
        {body.closing.length > 0 ? <ProseBlock text={body.closing} /> : null}
      </div>
    </section>
  );
}

function bodyHasContent(body: Bill["body"]): boolean {
  return body.preamble.length > 0 || body.sections.length > 0 || body.closing.length > 0;
}

// Render a paragraph-separated string (preamble / closing slices) as a
// stack of <p> elements. `\n\n` is the body parser's paragraph
// separator inside these slices.
function ProseBlock({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return (
    <>
      {paragraphs.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraph order in a fixed-content prose slice is stable.
        <p key={i} className="lc-billview-paragraph">
          {p}
        </p>
      ))}
    </>
  );
}

function OrdinanceBlockView({ block }: { block: OrdinanceBlock }) {
  if (block.kind === "section_header") {
    return (
      <h3 className="lc-billview-section-header">
        <span className="lc-billview-section-header-num">SEC. {block.number}.</span>{" "}
        <span className="lc-billview-section-header-title">{block.title}</span>
      </h3>
    );
  }
  if (block.kind === "paragraph") {
    return <p className="lc-billview-paragraph">{block.text}</p>;
  }
  // subsection
  return (
    <div className="lc-billview-subsection">
      <span className="lc-billview-subsection-marker">{block.marker}</span>
      <div className="lc-billview-subsection-body">
        {block.body.map((child, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: subsection child order is fixed by the tokenizer.
          <OrdinanceBlockView key={i} block={child} />
        ))}
      </div>
    </div>
  );
}

function ParseStatusNotice({ bills }: { bills: ReadonlyArray<Bill> }) {
  // Surface the worst-case parse_status across the bill's modules so the
  // reader knows whether the section list represents a clean structural
  // pass, a manual-review fallback, or a full structural change.
  const statuses = new Set(bills.map((b) => b.parse_status));
  if (statuses.has("structural_change")) {
    const scope = bills.find(
      (b) => b.parse_status === "structural_change",
    )?.structural_change_scope;
    return (
      <p className="lc-billparse-notice is-structural">
        Structural change{scope ? ` — ${scope}` : ""}. The inline diff isn't applicable; see the
        ordinance text below.
      </p>
    );
  }
  if (statuses.has("manual_review")) {
    return (
      <p className="lc-billparse-notice">
        The structural pass identified the affected sections below. Insertions and deletions aren't
        styled yet — the raw ordinance text from the source PDF follows.
      </p>
    );
  }
  return null;
}
