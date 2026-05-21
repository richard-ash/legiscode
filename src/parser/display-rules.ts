// Display-rules DSL evaluator. Given a section ref text the extractor
// captured ("102A", "109.0", "8.559") plus the target module's
// display_rules, produce an ordered list of candidate anchor_ids the
// build-time binder looks up in the target module's anchor index. First
// candidate that hits wins.
//
// The DSL ships three first-class knobs (prefix, alpha_suffix,
// strip_trailing_zero) plus an override_regex escape hatch — see the
// refoundation plan's "Locked decisions" for the principle. New knobs
// earn first-class status by appearing across >1 jurisdiction module;
// until then, the long tail lives under override_regex.
//
// Candidate generation rules (in order, dedup'd downstream by Set):
//
//   1. The input ref is lowercased; alpha-suffix letters keep position.
//   2. If strip_trailing_zero, both "<x>.0" and "<x>" forms are tried
//      (sf-plumbing anchors drop the ".0"; sf-housing anchors keep it —
//      a cite captured one way still binds against the other).
//   3. For each form, candidates are emitted in this order:
//        a. "<prefix><form>"        — the canonical "drop-the-prefix"
//                                     cite shape (sf-plumbing cites say
//                                     "109.0" but the anchor is "p109").
//        b. "<form>"                — bare. Wins when the cite already
//                                     names the canonical anchor.
//        c. "<extra><form>" for each extra_prefixes entry — appendix
//           fallbacks (sf-charter's `a`/`d` appendix). MUST come after
//           bare so a normal `Section 8.559` cite doesn't bind to an
//           appendix anchor `a8.559` when both exist.
//   4. override_regex matches the lowercased ref; its first capture
//      group becomes an additional candidate. Use for the long tail
//      (e.g. structural-Roman mapping "Article V" → "5.100") that
//      doesn't recur across modules.
//
// Pure function. No side effects, no IO, no jurisdiction context. The
// caller (binder.ts) walks the candidates against an anchor index.

import type { DisplayRules } from "@/types";

export function candidatesFor(sectionRef: string, rules?: DisplayRules): string[] {
  if (!sectionRef) return [];
  const out = new Set<string>();
  const base = sectionRef.toLowerCase();
  const forms = new Set<string>([base]);

  // strip_trailing_zero is bidirectional — the cite-text form and the
  // anchor form may disagree on a trailing ".0". Generate both
  // candidates so the lookup wins either way.
  if (rules?.strip_trailing_zero) {
    if (base.endsWith(".0")) forms.add(base.slice(0, -2));
    else forms.add(`${base}.0`);
  }

  for (const form of forms) {
    if (rules?.prefix) out.add(`${rules.prefix}${form}`);
    out.add(form);
    for (const extra of rules?.extra_prefixes ?? []) {
      out.add(`${extra}${form}`);
    }
  }

  // override_regex: a per-module escape hatch. Regex's first capture
  // group, lowercased, becomes a candidate. Invalid regex is silently
  // skipped — the Phase 4 build gate surfaces the resulting unbindable
  // cite with a clearer diagnostic than a regex-compile error here
  // would produce.
  if (rules?.override_regex) {
    try {
      const re = new RegExp(rules.override_regex, "i");
      const m = base.match(re);
      const capture = m?.[1];
      if (capture) out.add(capture.toLowerCase());
    } catch {
      // intentional: see comment above
    }
  }

  return Array.from(out);
}
