// Breadcrumb — center-panel header strip showing the active section's
// parent path (code title → chapter → section). Reads from
// CorpusSectionView.parents which the corpus loader populates from the
// section's hierarchy field. Phase 2's feat/section-view will add view
// options (line-height, amendments-visible) — those compose around this
// strip rather than replacing it.

import { Icons } from "@/ui/icons";

export interface BreadcrumbProps {
  parents: ReadonlyArray<{ code: string; name: string }>;
  sectionLabel: string | null;
}

export function Breadcrumb({ parents, sectionLabel }: BreadcrumbProps) {
  if (!sectionLabel) {
    return <div className="lc-breadcrumb" data-testid="breadcrumb" />;
  }
  return (
    <div className="lc-breadcrumb" data-testid="breadcrumb">
      <Icons.Book size={11} color="var(--overlay1)" />
      {parents.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered breadcrumb path; index is a stable position
        <span key={`${c.code}-${i}`}>
          {i > 0 && <span className="lc-crumb-sep">›</span>}
          <span>{c.code || c.name}</span>
        </span>
      ))}
      <span className="lc-crumb-sep">›</span>
      <span className="is-active">{sectionLabel}</span>
    </div>
  );
}
