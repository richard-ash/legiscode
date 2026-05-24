// Shared hover-popover context for the section view. Owned by
// SectionView, consumed by DefinedTerm. Lives in its own module to
// avoid a runtime circular import between section-view.tsx and
// defined-term.tsx (the type import from defined-term stays type-only,
// which the bundler drops at runtime).
//
// Why context: SectionView's single useHoverPopover instance is the
// source of truth for "is a popover visible right now?" — citations
// dispatch into it through delegated body handlers, defined terms
// dispatch into it through this context. Sharing the hook lifts "one
// popover at a time" from a timer-non-overlap hope to a structural
// invariant.

import { createContext, useContext } from "react";
import type { ResolutionResult } from "@/citations/resolver";
import type { Citation } from "@/types";
import type { DefinitionView } from "./defined-term";
import type { HoverPopoverHandle } from "./use-hover-popover";

/**
 * Discriminated union of every popover surface in the section view. The
 * single useHoverPopover instance carries this as its payload; the
 * render block in section-view.tsx switches on `kind` to mount the
 * right popover component.
 *
 * `anchorElement` (not anchorRect) lets the popover compute a fresh
 * `getBoundingClientRect()` at render time. A rect captured at hover
 * time can go stale during the 400ms show delay if the page reflows
 * (font loads, image dims arriving, etc.); reading the element at
 * render time eliminates that window.
 */
export type HoverPayload =
  | {
      kind: "citation";
      citation: Citation;
      resolution: ResolutionResult;
      anchorElement: HTMLElement;
    }
  | {
      kind: "definedTerm";
      definition: DefinitionView;
      anchorElement: HTMLElement;
      onActivate: () => void;
    };

/**
 * Section-wide hover-popover handle. `null` outside a SectionView
 * provider — DefinedTerm renders as inert prose in that case, which
 * keeps an isolated unit-test render of DefinedTerm from forcing every
 * caller to wrap in the context.
 */
export const SectionHoverContext = createContext<HoverPopoverHandle<HoverPayload> | null>(null);

export function useSectionHover(): HoverPopoverHandle<HoverPayload> | null {
  return useContext(SectionHoverContext);
}
