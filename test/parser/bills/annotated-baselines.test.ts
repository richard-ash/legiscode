// Regression baselines for classify-spans against the committed SF
// fixture PDFs. The companion `.annotated.json` files capture the
// minimum expected classification structure (page count + per-kind
// span floors). Per the locked plan's A15+C10 locks, exhaustive
// per-span ground truth waits on operator validation of the rendered
// diffs — these baselines guard against regression without fighting
// routine parser improvements.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifySpans } from "@/parser/bills/classify-spans";
import { loadPdfBuffer } from "@/parser/pdf/load";
import {
  extractFontMetadata,
  extractGraphicsOps,
  extractTextRuns,
} from "@/parser/pdf/page-extractor";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BILLS_FIXTURE = join(REPO_ROOT, "test", "fixtures", "sf", "bills");

type Baseline = {
  description: string;
  fixture: string;
  file_no: string;
  page_count: number;
  expected_classifications: {
    min_context_spans: number;
    min_amendment_spans: number;
  };
};

const FIXTURES = ["260217.pdf", "260544.pdf", "260545.pdf", "260296.pdf"];

describe("classify-spans regression against committed .annotated.json baselines", () => {
  for (const pdfName of FIXTURES) {
    it(`${pdfName} meets its committed classification floor`, async () => {
      const fileNo = pdfName.replace(".pdf", "");
      const baseline = JSON.parse(
        await readFile(join(BILLS_FIXTURE, `${fileNo}.annotated.json`), "utf8"),
      ) as Baseline;

      const bytes = await readFile(join(BILLS_FIXTURE, pdfName));
      const loaded = await loadPdfBuffer(new Uint8Array(bytes));
      try {
        const [runs, ops, fontMeta] = await Promise.all([
          extractTextRuns(loaded.doc),
          extractGraphicsOps(loaded.doc),
          extractFontMetadata(loaded.doc),
        ]);
        const classified = classifySpans(runs, ops, fontMeta);
        const counts = { context: 0, insert: 0, delete: 0, elision: 0, ambiguous: 0 };
        for (const s of classified) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
        const amendmentSpans = counts.insert + counts.delete + counts.elision;
        expect(counts.context).toBeGreaterThanOrEqual(
          baseline.expected_classifications.min_context_spans,
        );
        expect(amendmentSpans).toBeGreaterThanOrEqual(
          baseline.expected_classifications.min_amendment_spans,
        );
      } finally {
        await loaded.destroy();
      }
    }, 120_000);
  }
});
