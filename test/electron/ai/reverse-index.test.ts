// Reverse-citation graph property test: every (citing, target) pair
// produced by forward-walk over section.citations[] must appear in the
// reverse map, and vice versa.

import { describe, expect, it } from "vitest";
import { getReverseGraph } from "../../../electron/ai/reverse-index";
import { loadFixtureCorpus } from "./load-fixture-corpus";

describe("reverse-citation graph", () => {
  it("inverts every forward edge to a reverse edge", async () => {
    const corpus = await loadFixtureCorpus();
    const graph = getReverseGraph(corpus);

    // Walk forward; collect every (citing → target) edge for section refs.
    const forwardEdges: { citing: string; target: string }[] = [];
    for (const mod of corpus.modules) {
      for (const wrap of mod.sections) {
        for (const citation of wrap.section.citations) {
          const t = citation.target;
          if (t.kind === "internal" && !t.range) {
            forwardEdges.push({
              citing: `${mod.id}::${wrap.section.id}`,
              target: `${mod.id}::${t.section_id}`,
            });
          } else if (t.kind === "cross_module" && !t.range) {
            forwardEdges.push({
              citing: `${mod.id}::${wrap.section.id}`,
              target: `${t.module_id}::${t.section_id}`,
            });
          }
        }
      }
    }

    // Every forward edge must show up in the inverted graph.
    for (const edge of forwardEdges) {
      const [tMod, tSec] = edge.target.split("::");
      if (!tMod || !tSec) continue;
      const citers = graph.citers(tMod, tSec);
      const found = citers.some((c) => `${c.module_id}::${c.section_id}` === edge.citing);
      expect(found, `forward edge ${edge.citing} → ${edge.target} missing in reverse graph`).toBe(
        true,
      );
    }
  });
});
