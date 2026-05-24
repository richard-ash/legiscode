// Shared crumb renderer for the two breadcrumb surfaces — the chrome
// strip (`src/ui/chrome/breadcrumb.tsx`) and the in-section kicker at
// the top of section-view.tsx. The user sees "Administrative Code ·
// Chapter 37: Residential Rent..." twice; rendering both surfaces from
// a single component means the click target, the aria-label, and the
// module-root-non-interactive rule can't drift.
//
// A crumb with `sectionId !== null` is a real `<button>` that
// dispatches `navigate({kind:"section", ref}, "primary")`. The
// module-root parent gets `sectionId: null` and renders as plain text
// — no module overview view exists to navigate to, and the
// data-honesty rule says don't decorate something with authority the
// system can't back up.

import type { CorpusRef } from "@/corpus/refs";
import { parse as parseCorpusRef } from "@/corpus/refs";
import type { SectionId } from "@/types";
import type { OpenItem } from "@/workbench";
import type { NavigationIntent } from "@/workbench/navigate";

export interface Crumb {
  code: string;
  name: string;
  sectionId: SectionId | null;
}

export interface CrumbProps {
  crumb: Crumb;
  moduleId: string;
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
}

export function Crumb({ crumb, moduleId, navigate }: CrumbProps) {
  const label = crumb.code || crumb.name;
  if (crumb.sectionId === null) {
    // Module-root or other non-interactive ancestor — plain text.
    return <span className="lc-crumb-text">{label}</span>;
  }
  const ref: CorpusRef = parseCorpusRef({ module: moduleId, section: crumb.sectionId });
  return (
    <button
      type="button"
      className="lc-crumb-button"
      aria-label={crumb.name ? crumb.name : label}
      onClick={() => navigate({ kind: "section", ref }, "primary")}
    >
      {label}
    </button>
  );
}
