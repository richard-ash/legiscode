// Build-time citation binder. Walks every section's citations, asks
// display-rules for candidate anchor_ids, looks them up in the target
// module's anchor index, and rewrites the citation target as a
// section-ref when a candidate hits.
//
// Two-pass design lives upstream (pipeline.ts):
//   Pass A — extract + body-build. Citation targets land as the legacy
//            internal / cross_module / structural / vague /
//            internal_appendix shapes.
//   Pass B — binder. After every module has been parsed, build a
//            per-module anchor index (parsed section.id ∪ tocAnchors)
//            and rewrite citations whose target resolves to an anchor.
//
// The binder is the single code path the build-time gate collapses
// validator and resolver onto. The same candidates this file produces
// at build time become the runtime lookup keys — except the runtime
// only ever sees the winning candidate, baked into the disk shape.

import type { Citation, CitationTarget, DisplayRules, ModuleId, SectionFile } from "@/types";
import { candidatesFor } from "./display-rules";

// Per-module anchor index. Keys are lowercase anchor strings (parsed
// section ids ∪ tocAnchors from the slicer). Values aren't used; the
// binder only asks for membership.
export type AnchorIndex = ReadonlySet<string>;

// Per-module collision-family index. Keys are stripped-ordinal forms
// (the section.id with any trailing `-N[A]` suffix removed). Values are
// every SectionFile whose id shares that stripped form, but only when
// the family has more than one member — single-section families are
// elided so the lookup answers "is this id ambiguous?" in one Map.has.
//
// Drives the hierarchy-scoped fallback: a bare cite "Section 16.9" in
// a module with sections "16.9", "16.9-2", "16.9-21" carries the family
// {"16.9": [those three]}. The binder uses the citing section's
// hierarchy to pick which family member the author meant.
export type CollisionFamilyIndex = ReadonlyMap<string, readonly SectionFile[]>;

export interface BindContext {
  /** module_id of the section the citation lives in. */
  readonly citingModuleId: ModuleId;
  /** anchor index keyed by module_id; missing modules are unbindable. */
  readonly anchorsByModule: ReadonlyMap<ModuleId, AnchorIndex>;
  /** display_rules keyed by module_id; missing modules use bare lookup. */
  readonly rulesByModule: ReadonlyMap<ModuleId, DisplayRules | undefined>;
  /**
   * Per-module collision families keyed by module_id. Used by the
   * hierarchy-scoped fallback to disambiguate bare cites whose stripped
   * form has multiple disambiguator siblings in the target module.
   * Optional so legacy call sites that don't supply it fall back to
   * direct binding only.
   */
  readonly collisionFamiliesByModule?: ReadonlyMap<ModuleId, CollisionFamilyIndex>;
}

// Strip the trailing `-<digit>[A]?` ordinal disambiguator from a section
// id. Lossy on purpose: "16.9-2" → "16.9", "16.9-29A" → "16.9", but
// "10.04.020" → "10.04.020" (no suffix present). Used to group disambiguated
// siblings into collision families.
function stripOrdinalSuffix(id: string): string {
  return id.replace(/-\d+[a-z]?$/i, "");
}

// Strip the Pattern A appendix-container prefix from an id, returning
// the inner section number. "article10appendixb.1" → "1",
// "chapter5appendixa.10" → "10". Returns null when the id isn't
// appendix-prefixed. Used by buildCollisionFamilies so a bare cite like
// "Section 1" inside an appendix resolves via family lookup keyed by
// the leaf rather than the full qualified id (which only the cite's
// own section could produce verbatim).
const APPENDIX_PREFIX_RE = /^(?:article|chapter)[\da-z]+appendix[a-z]+\.(.+)$/i;
function stripAppendixPrefix(id: string): string | null {
  const m = id.match(APPENDIX_PREFIX_RE);
  return m?.[1] ?? null;
}

function isBareRef(sectionRef: string): boolean {
  return stripOrdinalSuffix(sectionRef) === sectionRef;
}

function hierarchiesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Family disambiguation. Pick the family member whose hierarchy best
// matches the citing section's. Verdicts:
//   - exact hierarchy match on exactly one member → bind that member
//   - exact hierarchy match on multiple members → ambiguous (vague)
//   - no exact match → walk citing's ancestor prefixes, pick the
//     deepest prefix where exactly one family member has the same
//     hierarchy; on multi-match or no-match at any depth, ambiguous
//
// The ancestor walk goes deepest-first so a citing section in
// ["Code", "ARTICLE I", "DIVISION A"] disambiguates against a family
// member at ["Code", "ARTICLE I"] before resorting to ["Code"] alone.
type DisambiguationVerdict = { kind: "bind"; section: SectionFile } | { kind: "ambiguous" };

function disambiguateFamilyByHierarchy(
  family: readonly SectionFile[],
  citingHierarchy: readonly string[],
): DisambiguationVerdict {
  const exact: SectionFile[] = [];
  for (const m of family) {
    if (hierarchiesEqual(m.hierarchy, citingHierarchy)) exact.push(m);
  }
  if (exact.length === 1) {
    const winner = exact[0];
    if (winner) return { kind: "bind", section: winner };
  }
  if (exact.length > 1) return { kind: "ambiguous" };

  // Ancestor walk. At each ancestor depth, check which family members'
  // OWN hierarchy is exactly that ancestor. Deepest unique winner.
  for (let depth = citingHierarchy.length - 1; depth >= 1; depth--) {
    const prefix = citingHierarchy.slice(0, depth);
    const matches: SectionFile[] = [];
    for (const m of family) {
      if (hierarchiesEqual(m.hierarchy, prefix)) matches.push(m);
    }
    if (matches.length === 1) {
      const winner = matches[0];
      if (winner) return { kind: "bind", section: winner };
    }
    if (matches.length > 1) return { kind: "ambiguous" };
  }
  return { kind: "ambiguous" };
}

// Rewrite a single citation if its target can be bound to a concrete
// anchor. Returns the citation with one of three target shapes:
//
//   section-ref — the binder found a hit (either in the citing module,
//                 a sibling module via sibling-fallback, or the target
//                 module of a cross_module cite). The runtime
//                 dereferences these in O(1) against titleMap.
//   vague       — reclassification. The cite looked like it wanted to
//                 be internal / cross_module but no anchor hit exists
//                 in this build's union of modules. Almost always: a
//                 cite to an external code (CA / US) without a phrase
//                 prefix the registry could pick up, or a stale source
//                 reference to a renumbered section. The renderer
//                 shows the cite text in citation chrome but ⌘-click
//                 is a no-op (the resolver returns unresolvable for
//                 vague).
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
//
// citingHierarchy supplies the per-section context the disambiguator
// needs for bare cites whose stripped form has multiple disambiguator
// siblings in the target module. Optional so legacy callers (older
// tests, sandboxed binder use) keep working without hierarchy info —
// they just lose the fallback for that call.
export function bindCitation(
  citation: Citation,
  ctx: BindContext,
  citingHierarchy?: readonly string[],
): Citation {
  const target = citation.target;
  switch (target.kind) {
    case "internal": {
      // Try the citing module first.
      const sameModule = tryBind(
        target.section_id,
        ctx.citingModuleId,
        ctx,
        {
          subsection: target.subsection,
          range: target.range,
        },
        citingHierarchy,
      );
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
      // citation (no navigation, no build failure). The build gate
      // then refuses to ship any internal / cross_module that survives
      // to validation. Preserve source_target so the validator can
      // bucket newly-vague cites by reason.
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
      const bound = tryBind(
        target.section_id,
        target.module_id,
        ctx,
        {
          subsection: target.subsection,
          range: target.range,
        },
        citingHierarchy,
      );
      if (bound) return { ...citation, target: bound };
      // Foreign module not in this build — install-time concern, leave
      // as cross_module so the runtime popover shows "X Code not
      // downloaded". Anchor lookup will run when the module installs.
      if (!ctx.anchorsByModule.has(target.module_id)) return citation;
      // Target module IS in build but anchor missing — bindable-shape
      // unbindable. Reclassify as vague so the intra-gate doesn't catch
      // it (the source corpus is the actual culprit). Preserve the
      // original target so the validator can attribute the failure to
      // a cross_module reclass.
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
  citingHierarchy?: readonly string[],
): CitationTarget | null {
  const anchors = ctx.anchorsByModule.get(targetModuleId);
  if (!anchors) return null;
  const rules = ctx.rulesByModule.get(targetModuleId);
  const families = ctx.collisionFamiliesByModule?.get(targetModuleId);

  for (const candidate of candidatesFor(sectionRef, rules)) {
    if (!anchors.has(candidate)) continue;

    // Bare-hit follow-up: if the cite was BARE (no `-N` suffix in the
    // source) and the directly-hit candidate belongs to a collision
    // family, run hierarchy disambiguation BEFORE returning. A unique
    // hierarchy winner redirects the bare cite to the implied
    // disambiguator sibling — without this, a bare cite to "16.9"
    // would direct-bind to the bare section "16.9" even when the
    // citing context strongly implies one of the siblings
    // ("16.9-2", "16.9-21", …) was intended.
    //
    // On an AMBIGUOUS verdict, keep the exact bare anchor we already
    // hit (`candidate`) rather than going vague: the author wrote the
    // bare id and a section with that exact id exists, so it is the
    // faithful target. The disambiguator siblings carry distinct ids
    // the author did not write. (When NO bare section exists this
    // branch is unreachable — the bare id never hits `anchors`, so the
    // no-hit fallback below produces the design's honest-vague.)
    //
    // Cites that already carry a `-N` suffix are trusted as-is —
    // the author named the specific disambiguator, no further
    // narrowing needed.
    if (families && isBareRef(sectionRef) && citingHierarchy) {
      const familyKey = stripOrdinalSuffix(candidate);
      const family = families.get(familyKey);
      if (family) {
        const verdict = disambiguateFamilyByHierarchy(family, citingHierarchy);
        if (verdict.kind === "bind") {
          return buildBoundTarget(verdict.section.id, targetModuleId, extras, anchors, rules);
        }
        // ambiguous → fall through to the exact bare bind below.
      }
    }

    // Range citations land at range.from for v1 navigation. Preserve
    // the upper bound either as a bound anchor (when `to` resolves in
    // this module) or as the raw cite text (when it doesn't); collapsing
    // both ends to `candidate` discards the citation's actual upper
    // bound, which v1.1 range-aware navigation needs to recover.
    return buildBoundTarget(candidate, targetModuleId, extras, anchors, rules);
  }

  // No primary candidate hit. Hierarchy fallback: when the cite's
  // stripped form has a collision family in the target module (i.e. the
  // bare cite "16.9" doesn't bind directly, but "16.9-2" / "16.9-5" /
  // "16.9-21" all exist), pick the family member whose hierarchy
  // matches the citing section's. Families that share their hierarchy
  // across all siblings stay as honest-vague.
  if (families && isBareRef(sectionRef) && citingHierarchy) {
    const familyKey = stripOrdinalSuffix(sectionRef.toLowerCase());
    const family = families.get(familyKey);
    if (family) {
      const verdict = disambiguateFamilyByHierarchy(family, citingHierarchy);
      if (verdict.kind === "bind") {
        return buildBoundTarget(verdict.section.id, targetModuleId, extras, anchors, rules);
      }
    }
  }
  return null;
}

function buildBoundTarget(
  candidate: string,
  targetModuleId: ModuleId,
  extras: { subsection?: string; range?: { from: string; to: string } },
  anchors: AnchorIndex,
  rules: DisplayRules | undefined,
): CitationTarget {
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
  return {
    kind: "section-ref",
    anchor_id: candidate,
    module_id: targetModuleId,
    ...(extras.subsection ? { subsection: extras.subsection } : {}),
  };
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

// Build the per-module collision-family index. Sections whose ids share
// a stripped-ordinal form land in the same family; single-member
// families are filtered out so the binder's lookup answers "is this
// id ambiguous?" in one `Map.has` rather than a length check.
export function buildCollisionFamilies(sections: readonly SectionFile[]): CollisionFamilyIndex {
  const grouped = new Map<string, SectionFile[]>();
  function push(key: string, s: SectionFile): void {
    let arr = grouped.get(key);
    if (!arr) {
      arr = [];
      grouped.set(key, arr);
    }
    arr.push(s);
  }
  for (const s of sections) {
    push(stripOrdinalSuffix(s.id), s);
    // Pattern A: also key by the appendix-stripped leaf so a bare cite
    // ("Section 1") inside Jackson Square Historic District finds
    // article10appendixb.1, article10appendixc.1, ..., as family
    // candidates and disambiguateFamilyByHierarchy can pick the right
    // one from the citing section's appendix hierarchy.
    const leaf = stripAppendixPrefix(s.id);
    if (leaf) push(stripOrdinalSuffix(leaf), s);
  }
  const out = new Map<string, readonly SectionFile[]>();
  for (const [key, members] of grouped) {
    // Keep singletons only when at least one member is appendix-prefixed.
    // For natural collisions the >1 filter is a perf optimization — the
    // binder's lookup answers "is this id ambiguous?" via Map.has. But
    // for appendix-leaf aliases, a singleton entry IS the only way a
    // bare cite ("Section 1") can resolve to a uniquely-named appendix
    // section (`article10appendixb.1`) when no other section in the
    // module shares the leaf. Without this exception, modules with a
    // single appendix produce vague cites for every bare local ref.
    if (members.length > 1 || members.some((m) => stripAppendixPrefix(m.id) !== null)) {
      out.set(key, members);
    }
  }
  return out;
}
