// DiffView — renders a bill's inline diff for a single corpus section,
// or the appropriate per-section banner when the bill's outcome for
// that section is non-renderable.
//
// Why a separate component:
//   • Each bill carries a per-section diff outcome (anchored,
//     classification_low_confidence, no_baseline, unresolved,
//     added_section, structural, absorbed_external). The section view
//     used to lump every non-anchored outcome into a single "overlay
//     unavailable" copy; the per-section banner spells out *why* the
//     diff doesn't render.
//   • The baseline text is fetched asynchronously via a caller-supplied
//     loader. This lets the same component drive both the in-place
//     overlay (where the baseline is already loaded as section.text)
//     and a future cross-section diff tab (where the baseline lives in
//     a different corpus row).
//   • Cancellation guard mirrors `src/ui/App.tsx` — every load tracks
//     a `cancelled` flag, and a corpus_epoch change invalidates in-
//     flight requests so a stale baseline can't paint over a freshly-
//     installed module.

import { useEffect, useMemo, useState } from "react";
import type { Bill, ModuleId, RenderBodySegment, SectionId, TextDiffSpan } from "@/types";
import { splitParagraphs } from "@/types";
import { overlayDiffOnBaseline } from "@/ui/diff/overlay";
import { PerSectionBanner } from "./banner";

/**
 * Async baseline loader. Returns `null` when the corpus has no text for
 * the requested section. Errors should throw; the component catches +
 * surfaces them as the "no_baseline" banner with a detail string.
 *
 * The loader's closure may capture an epoch / cache; the component
 * passes a `corpus_epoch` token through the `epoch` prop so the
 * component's own dedupe + invalidation logic can react to corpus
 * reloads without re-instantiating the loader.
 */
export type BaselineLoader = (moduleId: ModuleId, sectionId: SectionId) => Promise<string | null>;

export interface DiffViewProps {
  /** Bill whose text_diff drives the overlay rendering. */
  bill: Bill;
  /** Section the diff is being rendered for. The component looks up
   *  the outcome in bill.section_outcomes for this section id. */
  sectionId: SectionId;
  /** Asynchronous baseline text loader; called once per
   *  (moduleId, sectionId, epoch) tuple. */
  baselineLoader: BaselineLoader;
  /** Corpus-epoch token — opaque value that changes when the loaded
   *  corpus reloads (module install/uninstall, sync run). When this
   *  changes mid-load, the in-flight load is cancelled and the
   *  baseline is re-fetched. Typical value: the
   *  CorpusModuleSummary object identity, or a `jurisdictionVersion`
   *  string. */
  epoch: unknown;
  /** Pre-resolved baseline override. When passed, the component
   *  short-circuits the async loader path and renders the overlay
   *  immediately. The section-view passes its already-loaded
   *  `section.text` here for the in-place overlay case. */
  baselineOverride?: string;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; baseline: string }
  | { kind: "no_baseline"; reason: string };

export function DiffView({
  bill,
  sectionId,
  baselineLoader,
  epoch,
  baselineOverride,
}: DiffViewProps) {
  const outcome = useMemo(
    () => bill.section_outcomes.find((o) => o.section_id === sectionId) ?? null,
    [bill.section_outcomes, sectionId],
  );
  const spans = useMemo<TextDiffSpan[]>(
    () => bill.text_diff.filter((s) => s.section_id === sectionId),
    [bill.text_diff, sectionId],
  );

  const renderable =
    outcome !== null && (outcome.status === "anchored" || outcome.status === "added_section");

  const [state, setState] = useState<LoadState>(() =>
    !renderable
      ? { kind: "idle" }
      : baselineOverride !== undefined
        ? { kind: "loaded", baseline: baselineOverride }
        : { kind: "loading" },
  );

  useEffect(() => {
    // `epoch` is the cache-invalidation token: it isn't otherwise
    // read inside the effect, but a change MUST re-fire the loader
    // so a corpus reload invalidates the in-flight or completed
    // baseline. Reference it explicitly so biome's exhaustive-deps
    // check sees the usage and doesn't strip it from the array.
    void epoch;
    if (!renderable) {
      setState({ kind: "idle" });
      return;
    }
    if (baselineOverride !== undefined) {
      setState({ kind: "loaded", baseline: baselineOverride });
      return;
    }
    setState({ kind: "loading" });
    let cancelled = false;
    void (async () => {
      try {
        const text = await baselineLoader(bill.module_id, sectionId);
        if (cancelled) return;
        if (text === null || text.length === 0) {
          setState({
            kind: "no_baseline",
            reason: "corpus has no baseline text for this section",
          });
          return;
        }
        setState({ kind: "loaded", baseline: text });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "no_baseline",
          reason: (err as Error).message || "baseline load failed",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [renderable, baselineOverride, baselineLoader, bill.module_id, sectionId, epoch]);

  if (outcome === null) {
    // Section not in this bill's outcomes — nothing to render.
    return null;
  }

  if (!renderable) {
    return <PerSectionBanner status={outcome.status} fileNo={bill.file_no} sectionId={sectionId} />;
  }

  if (state.kind === "loading") {
    return (
      <div className="lc-diff-view lc-diff-view--loading" role="status" aria-live="polite">
        Loading the diff for § {sectionId}…
      </div>
    );
  }

  if (state.kind === "no_baseline") {
    return (
      <PerSectionBanner
        status="no_baseline"
        fileNo={bill.file_no}
        sectionId={sectionId}
        detailOverride={state.reason}
      />
    );
  }

  if (state.kind === "loaded") {
    const paragraphs = splitParagraphs(overlayDiffOnBaseline(spans, state.baseline));
    if (paragraphs.length === 0) {
      return (
        <div className="lc-diff-view lc-diff-view--empty" data-testid="diff-view-empty">
          This section would be removed entirely under Ord. {bill.file_no}.
        </div>
      );
    }
    return (
      <div className="lc-diff-view lc-diff-view--loaded" data-testid="diff-view-loaded">
        {paragraphs.map((segs, pi) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs in a fixed overlay render are positionally stable
          <p key={pi} className="lc-para">
            {segs.map((seg, si) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments within a paragraph render in fixed order
              <DiffSegmentView key={si} segment={seg} />
            ))}
          </p>
        ))}
      </div>
    );
  }

  return null;
}

function DiffSegmentView({ segment }: { segment: RenderBodySegment }) {
  switch (segment.kind) {
    case "text":
      return <>{segment.text}</>;
    case "diff_insert":
      return (
        <span className="lc-diff-run" data-diff-op="insert">
          {segment.text}
        </span>
      );
    case "diff_delete":
      return (
        <span className="lc-diff-run" data-diff-op="delete">
          {segment.text}
        </span>
      );
    case "diff_elision":
      return <span className="lc-diff-elision">[…]</span>;
    case "citation":
    case "defined_term":
      // Citations and defined terms inside an overlay render as their
      // verbatim raw text. The overlay isn't a navigation surface —
      // no hover popovers, no click handlers — but the text content
      // is load-bearing for reading. Dropping it would silently
      // remove words from the baseline render.
      return <>{segment.raw}</>;
    case "subsection_label":
      return <>{segment.label}</>;
    case "paragraph_break":
      // paragraph_break is handled by the splitParagraphs pass before
      // segments reach this component; it shouldn't appear here.
      return null;
    case "format":
      // Format wrappers (bold/italic/list/listItem): render children
      // recursively. The overlay strips the format markup itself —
      // the segments-with-format level isn't load-bearing for diff
      // readability and adds rendering complexity we don't need yet.
      return (
        <>
          {segment.children.map((child, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: format children are positionally stable inside a fixed segment.
            <DiffSegmentView key={i} segment={child} />
          ))}
        </>
      );
  }
}

// PerSectionBanner + bannerCopyFor live in ./banner.tsx so the
// SectionPendingRail's "overlay unavailable" path can render the same
// per-section reason copy without re-implementing the switch.
