// Breadcrumb — center-panel header strip showing the active section's
// parent path (code title → chapter → section). Reads from
// CorpusSectionView.parents which the corpus loader populates from the
// section's hierarchy field. Parent entries with a non-null `sectionId`
// render as buttons that dispatch navigate({kind:"section", ref},
// "primary"); module-root (sectionId === null) renders as plain text.
// The same crumb component renders inside section-view.tsx's in-section
// kicker — two surfaces, one click target, no drift.

import { Crumb } from "@/ui/center-panel/section-view/crumb";
import { Icons } from "@/ui/icons";
import type { OpenItem } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";

export interface BreadcrumbProps {
  parents: ReadonlyArray<Crumb>;
  sectionLabel: string | null;
  /** Module id needed to resolve a parent's sectionId into a CorpusRef.
   *  Optional: if missing or when parents[] is empty (between selections)
   *  every crumb falls through to plain text. */
  moduleId?: string;
  /** Dispatched on crumb click. Optional for the same reason — pre-
   *  selection chrome renders without an actionable navigate target. */
  navigate?: (item: OpenItem, intent: NavigationIntent) => void;
}

export function Breadcrumb({ parents, sectionLabel, moduleId, navigate }: BreadcrumbProps) {
  if (!sectionLabel) {
    return <div className="lc-breadcrumb" data-testid="breadcrumb" />;
  }
  const interactive = moduleId !== undefined && navigate !== undefined;
  return (
    <div className="lc-breadcrumb" data-testid="breadcrumb">
      <Icons.Book size={11} color="var(--overlay1)" />
      {parents.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered breadcrumb path; index is a stable position
        <span key={`${p.code}-${i}`}>
          {i > 0 && <span className="lc-crumb-sep">›</span>}
          {interactive ? (
            <Crumb crumb={p} moduleId={moduleId} navigate={navigate} />
          ) : (
            <span className="lc-crumb-text">{p.code || p.name}</span>
          )}
        </span>
      ))}
      <span className="lc-crumb-sep">›</span>
      <span className="is-active">{sectionLabel}</span>
    </div>
  );
}
