// Amends chips — the primary navigation surface inside a bill tab.
// Each chip points at one (module, section) target this bill
// affects; activate to open the section as a new tab in the centre
// panel.
//
// No kind labels ("amend"/"add"/"repeal") because the Bill schema
// doesn't carry a `kind` field on each change.
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
   *  flat union of every row's touched sections (from section_outcomes),
   *  deduped by (moduleId, sectionId). */
  bills: ReadonlyArray<Bill>;
  navigate: (item: OpenItem, intent: NavigationIntent) => void;
  /** Synchronous title lookup. Returns null when the ref isn't in the
   *  loaded corpus — the chip falls back to the section id. */
  lookupSectionTitle: (ref: CorpusRef) => string | null;
}

export function AmendsChips({ bills, navigate, lookupSectionTitle }: AmendsChipsProps) {
  // Flatten + dedupe like the legacy BillSectionList. The touched-set
  // is sourced from section_outcomes — every section the bill touches
  // gets a chip, regardless of per-section diff outcome (anchored,
  // partial, manual_review, etc.). The chip's job is navigation, not
  // diff visibility.
  const refs: CorpusRef[] = [];
  const seen = new Set<string>();
  for (const bill of bills) {
    for (const outcome of bill.section_outcomes) {
      let ref: CorpusRef;
      try {
        ref = parseRef({ module: bill.module_id, section: outcome.section_id });
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
