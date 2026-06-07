// Shared per-section banner copy + component. Lives in its own module
// so both `DiffView` (which surfaces the banner when the outcome isn't
// renderable) and `SectionPendingRail` (which surfaces the banner in
// the "overlay requested but unavailable" path) can render the same
// specific reason copy. Keeping the copy in one place stops the two
// surfaces from drifting.

import type { SectionId, SectionOutcomeStatus } from "@/types";

export interface PerSectionBannerProps {
  status: SectionOutcomeStatus;
  fileNo: string;
  sectionId: SectionId;
  detailOverride?: string;
}

export function PerSectionBanner({
  status,
  fileNo,
  sectionId,
  detailOverride,
}: PerSectionBannerProps) {
  const copy = bannerCopyFor(status, fileNo, sectionId, detailOverride);
  return (
    <div
      className={`lc-diff-banner lc-diff-banner--${status}`}
      role="note"
      data-testid={`diff-banner-${status}`}
    >
      <span className="lc-diff-banner-title">{copy.title}</span>
      {copy.detail ? <span className="lc-diff-banner-detail"> — {copy.detail}</span> : null}
    </div>
  );
}

export function bannerCopyFor(
  status: SectionOutcomeStatus,
  fileNo: string,
  sectionId: SectionId,
  detailOverride?: string,
): { title: string; detail: string } {
  switch (status) {
    case "no_baseline":
      return {
        title: `No baseline for § ${sectionId}`,
        detail: detailOverride ?? "The corpus has no current text for this section.",
      };
    case "classification_low_confidence":
      return {
        title: `Couldn't interpret § ${sectionId}`,
        detail:
          "The bill's redline typography didn't classify cleanly. The original PDF below has the change.",
      };
    case "unresolved":
      return {
        title: `Couldn't locate § ${sectionId}`,
        detail: `Ord. ${fileNo} references a section that isn't in this module's tree.`,
      };
    case "added_section":
      return {
        title: `New section`,
        detail: `Ord. ${fileNo} adds a new § ${sectionId}.`,
      };
    case "structural":
      return {
        title: `Structural change`,
        detail: `Ord. ${fileNo} restructures the chapter — per-section diff isn't applicable.`,
      };
    case "absorbed_external":
      return {
        title: `Codified by AmLegal`,
        detail: `Ord. ${fileNo}'s changes are already reflected in the corpus tree.`,
      };
    case "no_changes":
      return {
        title: `No changes in § ${sectionId}`,
        detail:
          detailOverride ?? `Ord. ${fileNo} references this section but does not change its text.`,
      };
    case "anchored":
      // Anchored outcomes render the diff itself, not this banner;
      // reaching this branch means a caller asked for banner copy on
      // a renderable outcome. Fail loud so the caller can't render an
      // empty/blank banner by accident.
      throw new Error(
        `bannerCopyFor called with status="anchored" for § ${sectionId} (Ord. ${fileNo}) — anchored outcomes render the diff, not a banner.`,
      );
  }
}
