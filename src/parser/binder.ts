// Build-time citation binder. Walks every section's citations, asks
// display-rules for candidate anchor_ids, looks them up in the target
// module's anchor index, and rewrites the citation target as a
// section-ref when a candidate hits.
//
// Two-pass design lives upstream (pipeline.ts):
//   Pass A — extract + body-build (existing). Citation targets land as
//            the legacy internal / cross_module / structural / vague /
//            internal_appendix shapes.
//   Pass B — binder. After every module has been parsed, build a
//            per-module anchor index (parsed section.id ∪ tocAnchors)
//            and rewrite citations whose target resolves to an anchor.
//            Unbindable cites keep their legacy target so the corpus
//            still ships during the Phase 2 → Phase 4 transition; the
//            Phase 4 gate then refuses to promote unbound cites.
//
// The binder is the single code path Phase 4 collapses validator and
// resolver onto. The same candidates this file produces at build time
// become the runtime lookup keys after Phase 3 — except the runtime
// only ever sees the winning candidate, baked into the disk shape.

import type { Citation, CitationTarget, DisplayRules, ModuleId, SectionFile } from "@/types";
import { candidatesFor } from "./display-rules";

// Per-module anchor index. Keys are lowercase anchor strings (parsed
// section ids ∪ tocAnchors from the slicer). Values aren't used; the
// binder only asks for membership.
export type AnchorIndex = ReadonlySet<string>;

export interface BindContext {
  /** module_id of the section the citation lives in. */
  readonly citingModuleId: ModuleId;
  /** anchor index keyed by module_id; missing modules are unbindable. */
  readonly anchorsByModule: ReadonlyMap<ModuleId, AnchorIndex>;
  /** display_rules keyed by module_id; missing modules use bare lookup. */
  readonly rulesByModule: ReadonlyMap<ModuleId, DisplayRules | undefined>;
}

// Rewrite a single citation if its target can be bound to a concrete
// anchor. Returns the citation with one of three target shapes:
//
//   section-ref — the binder found a hit (either in the citing module,
//                 a sibling module via sibling-fallback, or the target
//                 module of a cross_module cite). Phase 3 runtime
//                 dereferences these in O(1) against titleMap.
//   vague       — Phase 4 reclassification. The cite looked like it
//                 wanted to be internal / cross_module but no anchor
//                 hit exists in this build's union of modules. Almost
//                 always: a cite to an external code (CA / US) without
//                 a phrase prefix the registry could pick up, or a
//                 stale source reference to a renumbered section.
//                 The renderer shows the cite text in citation chrome
//                 but ⌘-click is a no-op (the resolver returns
//                 unresolvable for vague). This collapses the legacy
//                 cross-unresolved demotion bucket the build gate
//                 quietly leaned on.
//   structural / internal_appendix — passed through unchanged. The
//                 binder has no anchor to bind to.
//
// cross_module cites to modules NOT in this build (typical ca-*, us-*
// references) stay as cross_module — the runtime resolver renders the
// "module not installed" popover. Those aren't unbindable; they're
// install-time-bindable, which the install path handles.
//
// section_id values in legacy targets are already lowercase per the
// SectionIdSchema; candidatesFor lowercases again as defense in depth.
export function bindCitation(citation: Citation, ctx: BindContext): Citation {
  const target = citation.target;
  switch (target.kind) {
    case "internal": {
      // Try the citing module first.
      const sameModule = tryBind(target.section_id, ctx.citingModuleId, ctx, {
        subsection: target.subsection,
        range: target.range,
      });
      if (sameModule) return { ...citation, target: sameModule };
      // Sibling-module fallback: legacy authors sometimes write
      // "Section 8.509" inside sf-administrative when they mean
      // sf-charter::8.509 (no "of the Charter" code phrase in the
      // text). When exactly one sibling module's anchor index hits, we
      // can promote the cite to a cross-module section-ref. Multiple
      // hits → ambiguous; leave for reclassification as vague below.
      const sibling = tryBindSibling(target.section_id, ctx, {
        subsection: target.subsection,
        range: target.range,
      });
      if (sibling) return { ...citation, target: sibling };
      // Nothing matched anywhere. Reclassify as vague so the runtime
      // resolver and validator both treat it as an informational
      // citation (no navigation, no build failure). Per the Phase 4
      // gate: only bindable-shape-but-actually-unbindable targets
      // remain internal / cross_module past this point; the validator
      // then refuses to ship them. D9: preserve source_target so the
      // validator can bucket newly-vague cites by reason.
      return {
        ...citation,
        target: {
          kind: "vague",
          raw: citation.display_text,
          source_target: target,
        },
      };
    }
    case "cross_module": {
      const bound = tryBind(target.section_id, target.module_id, ctx, {
        subsection: target.subsection,
        range: target.range,
      });
      if (bound) return { ...citation, target: bound };
      // Foreign module not in this build — install-time concern, leave
      // as cross_module so the runtime popover shows "X Code not
      // downloaded". Anchor lookup will run when the module installs.
      if (!ctx.anchorsByModule.has(target.module_id)) return citation;
      // Target module IS in build but anchor missing — bindable-shape
      // unbindable. Reclassify as vague to fall outside the Phase 4
      // intra-gate; the source corpus is the actual culprit. D9:
      // preserve the original target so the validator can attribute
      // the failure to a cross_module reclass.
      return {
        ...citation,
        target: {
          kind: "vague",
          raw: citation.display_text,
          source_target: target,
        },
      };
    }
    case "section-ref":
    case "structural":
    case "vague":
    case "internal_appendix":
      return citation;
  }
}

// Sibling-module fallback. Walks every module's anchor index (other
// than the citing module) looking for the section_id; returns a
// section-ref pointing at the first hit when exactly one sibling
// matches. Multiple hits are skipped — without a code phrase telling
// us which module the author meant, picking one would be guessing.
function tryBindSibling(
  sectionRef: string,
  ctx: BindContext,
  extras: { subsection?: string; range?: { from: string; to: string } },
): CitationTarget | null {
  let hit: { moduleId: ModuleId; anchor: string; rules: DisplayRules | undefined } | null = null;
  for (const [moduleId, anchors] of ctx.anchorsByModule) {
    if (moduleId === ctx.citingModuleId) continue;
    const rules = ctx.rulesByModule.get(moduleId);
    for (const candidate of candidatesFor(sectionRef, rules)) {
      if (!anchors.has(candidate)) continue;
      if (hit) return null; // ambiguous — multiple modules match
      hit = { moduleId, anchor: candidate, rules };
      break;
    }
  }
  if (!hit) return null;
  // Range citations: try to resolve the upper bound in the hit module's
  // anchor index, fall back to raw cite text. Mirrors tryBind's
  // range-preservation behavior so sibling-fallback range cites don't
  // silently drop their upper bound.
  if (extras.range) {
    const siblingAnchors = ctx.anchorsByModule.get(hit.moduleId);
    let boundTo: string = extras.range.to;
    if (siblingAnchors) {
      for (const toCandidate of candidatesFor(extras.range.to, hit.rules)) {
        if (siblingAnchors.has(toCandidate)) {
          boundTo = toCandidate;
          break;
        }
      }
    }
    return {
      kind: "section-ref",
      anchor_id: hit.anchor,
      module_id: hit.moduleId,
      range: { from: hit.anchor, to: boundTo },
    };
  }
  return {
    kind: "section-ref",
    anchor_id: hit.anchor,
    module_id: hit.moduleId,
    ...(extras.subsection ? { subsection: extras.subsection } : {}),
  };
}

function tryBind(
  sectionRef: string,
  targetModuleId: ModuleId,
  ctx: BindContext,
  extras: { subsection?: string; range?: { from: string; to: string } },
): CitationTarget | null {
  const anchors = ctx.anchorsByModule.get(targetModuleId);
  if (!anchors) return null;
  const rules = ctx.rulesByModule.get(targetModuleId);
  for (const candidate of candidatesFor(sectionRef, rules)) {
    if (!anchors.has(candidate)) continue;
    // Range citations land at range.from for v1 navigation. Preserve
    // the upper bound either as a bound anchor (when `to` resolves in
    // this module) or as the raw cite text (when it doesn't); collapsing
    // both ends to `candidate` discards the citation's actual upper
    // bound, which v1.1 range-aware navigation needs to recover.
    if (extras.range) {
      let boundTo: string = extras.range.to;
      for (const toCandidate of candidatesFor(extras.range.to, rules)) {
        if (anchors.has(toCandidate)) {
          boundTo = toCandidate;
          break;
        }
      }
      return {
        kind: "section-ref",
        anchor_id: candidate,
        module_id: targetModuleId,
        range: { from: candidate, to: boundTo },
      };
    }
    const out: CitationTarget = {
      kind: "section-ref",
      anchor_id: candidate,
      module_id: targetModuleId,
      ...(extras.subsection ? { subsection: extras.subsection } : {}),
    };
    return out;
  }
  return null;
}

// Build a per-module anchor index from parsed SectionFiles plus the
// slicer's tocAnchors (which catch deletion-marker stubs and Note
// sub-elements that aren't promoted to queryable sections but still
// count as bindable targets — same reasoning as the existing
// validate-corpus.ts ownTocAnchors set).
export function buildAnchorIndex(
  sections: readonly SectionFile[],
  tocAnchors: readonly string[],
): AnchorIndex {
  const out = new Set<string>();
  for (const s of sections) out.add(s.id);
  for (const a of tocAnchors) out.add(a.toLowerCase());
  return out;
}
