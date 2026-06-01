// r11 Amends chips — the primary navigation surface inside a bill tab.
// Each chip points at one (module, section) target this bill affects;
// activate to open the section as a new tab in the centre panel.
//
// CR-1: no kind labels ("amend"/"add"/"repeal") because the v1 Bill
// schema doesn't carry a `kind` field on each change. The mockup's
// `<span class="ckind">` is omitted entirely until the inline-diff PR
// repopulates `text_diff[]` with kind information.
//
// Click semantics mirror BillSectionList: plain → primary, Cmd/Ctrl →
// background. Each chip is a real <button> so the activity-pane
// keyboard contract (Enter/Space) carries through without override.

import type { KeyboardEvent, MouseEvent } from "react";
import { type CorpusRef, parse as parseRef, hash as refHash } from "@/corpus/refs";
import type { Bill } from "@/types";
import type { NavigationIntent } from "@/workbench/navigate";
import type { OpenItem } from "@/workbench/open-items";

export interface AmendsChipsProps {
  /** Every per-module Bill row for this file_no — the chips are the
   *  flat union of every row's affected_sections, deduped by
   *  (moduleId, sectionId). */
  bills: ReadonlyArray<Bill>;
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
  /** Synchronous title lookup. Returns null when the ref isn't in the
   *  loaded corpus — the chip falls back to the section id. */
  lookupSectionTitle: (ref: CorpusRef) => string | null;
}

export function AmendsChips({ bills, navigate, lookupSectionTitle }: AmendsChipsProps) {
  // Flatten + dedupe like the legacy BillSectionList. The activity
  // panel ranks chips by their order in `bills` (which is sorted upstream
  // by (file_no, module_id)); within each module, affected_sections is
  // already in source order from the parser.
  const refs: CorpusRef[] = [];
  const seen = new Set<string>();
  for (const bill of bills) {
    for (const sectionId of bill.affected_sections) {
      let ref: CorpusRef;
      try {
        ref = parseRef({ module: bill.module_id, section: sectionId });
      } catch {
        continue;
      }
      const key = refHash(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  if (refs.length === 0) return null;
  const onActivate = (ref: CorpusRef, openMod: boolean) => {
    navigate({ kind: "section", ref }, openMod ? "background" : "primary");
  };
  return (
    <section className="lc-amends" aria-labelledby="lc-amends-label">
      <h2 id="lc-amends-label" className="lc-amends-label">
        Amends <span className="lc-amends-count">{refs.length}</span>{" "}
        {refs.length === 1 ? "section" : "sections"}
      </h2>
      <ul className="lc-amends-chips" aria-label="Sections this bill amends">
        {refs.map((ref) => {
          const title = lookupSectionTitle(ref);
          return (
            <li key={refHash(ref)}>
              <button
                type="button"
                className="lc-amends-chip"
                onClick={(e: MouseEvent<HTMLButtonElement>) =>
                  onActivate(ref, e.metaKey || e.ctrlKey)
                }
                onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onActivate(ref, e.metaKey || e.ctrlKey);
                  }
                }}
              >
                <code className="lc-amends-chip-section">§ {ref.section}</code>
                {title ? <span className="lc-amends-chip-title">{title}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
