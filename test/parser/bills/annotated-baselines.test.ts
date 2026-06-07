// Per-span regression baselines for classify-spans against the
// committed SF fixture PDFs. The companion `.annotated.json` files
// capture the exact expected classification counts per kind. Any drift
// surfaces as a CI failure rather than the previous min-floor shape,
// which let silent regressions slip past CI as long as the counts
// stayed above the floor. Per the feat/diff-completeness lock the
// counts here are the load-bearing "we shipped what we said we
// shipped" gate.

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
    context: number;
    insert: number;
    delete: number;
    elision: number;
    ambiguous: number;
  };
};

const FIXTURES = ["260217.pdf", "260544.pdf", "260545.pdf", "260296.pdf"];

describe("classify-spans regression against committed .annotated.json baselines", () => {
  for (const pdfName of FIXTURES) {
    it(`${pdfName} matches its committed per-span classification counts`, async () => {
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
        // Exact-count regression: each kind must match the committed
        // baseline. Updates require regenerating the fixture and
        // committing the new numbers, on purpose.
        expect(counts).toEqual(baseline.expected_classifications);
      } finally {
        await loaded.destroy();
      }
    }, 120_000);
  }
});
