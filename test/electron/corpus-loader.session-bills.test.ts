import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Bill, BillSchema } from "@/types";
import {
  __resetCorpusForTests,
  listCorpus,
  listPendingBills,
  loadCorpus,
} from "../../electron/corpus-loader";

// Minimal corpus skeleton — just enough for loadCorpus to succeed so we
// can exercise the session-bills scan. Each module gets one section so
// the loader's "non-empty sections" rule passes; the actual bill scan
// is the test surface.
async function buildFixtureModule(
  root: string,
  opts: { id: string; bills?: readonly Bill[] | string },
): Promise<void> {
  const moduleDir = join(root, opts.id);
  await mkdir(moduleDir, { recursive: true });
  await writeFile(
    join(moduleDir, "manifest.json"),
    JSON.stringify({
      id: opts.id,
      name: `Module ${opts.id}`,
      code_title: opts.id,
      jurisdiction: "Test City",
      module_version: "2026.05.30",
      citation_patterns: [],
      defined_term_patterns: [],
    }),
  );
  await writeFile(
    join(moduleDir, "corpus-meta.json"),
    JSON.stringify({ module_version: "2026.05.30", jurisdiction: "Test City" }),
  );
  await mkdir(join(moduleDir, "sections"), { recursive: true });
  await writeFile(
    join(moduleDir, "sections", "1.0.json"),
    JSON.stringify({
      kind: "section",
      id: "1.0",
      display_label: "1.0",
      title: "Stub",
      text: "Stub.",
      citations: [],
      defined_terms: [],
      hierarchy: [opts.id],
      editorial_status: "active",
      body: [{ kind: "text", text: "Stub." }],
    }),
  );
  if (opts.bills === undefined) return;
  await mkdir(join(moduleDir, "bills"), { recursive: true });
  if (typeof opts.bills === "string") {
    // Raw escape hatch for malformed-file tests.
    await writeFile(join(moduleDir, "bills", "raw.json"), opts.bills);
    return;
  }
  for (const bill of opts.bills) {
    await writeFile(join(moduleDir, "bills", `${bill.file_no}.json`), JSON.stringify(bill));
  }
}

function makeBill(over: Partial<Bill> = {}): Bill {
  return BillSchema.parse({
    file_no: "260217",
    module_id: "sf-test",
    short_title: "x",
    long_title: "Ordinance amending the Test Code…",
    sponsor: null,
    introduced_at: null,
    legistar_url: "https://e/d?ID=1&GUID=g",
    legistar_status: "Pending",
    bill_status: "filed",
    section_outcomes: [],
    diff_chunks: [],
    parse_status: "body_only",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
    ...over,
  } as Bill);
}

describe("corpus-loader: bills/ scan", () => {
  let root: string;
  beforeEach(async () => {
    __resetCorpusForTests();
    root = await mkdtemp(join(tmpdir(), "legiscode-loader-bills-"));
  });
  afterEach(async () => {
    __resetCorpusForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty array when no module has a bills directory", async () => {
    await buildFixtureModule(root, { id: "sf-test" });
    const result = await loadCorpus(root);
    expect(result.kind).toBe("ok");
    expect(listPendingBills()).toEqual([]);
  });

  it("loads validated Bills from bills/<file_no>.json, sorted by file_no", async () => {
    await buildFixtureModule(root, {
      id: "sf-test",
      bills: [
        makeBill({ file_no: "260296", module_id: "sf-test", short_title: "B" }),
        makeBill({ file_no: "260217", module_id: "sf-test", short_title: "A" }),
      ],
    });
    const result = await loadCorpus(root);
    expect(result.kind).toBe("ok");
    const bills = listPendingBills();
    expect(bills.map((b) => b.file_no)).toEqual(["260217", "260296"]);
  });

  it("hard-fails the loader when a session-bill file is malformed JSON", async () => {
    await buildFixtureModule(root, { id: "sf-test", bills: "{not json" });
    const result = await loadCorpus(root);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error.kind).toBe("corrupt");
    }
  });

  it("hard-fails the loader when a session-bill fails BillSchema", async () => {
    // file_no missing — BillSchema requires it.
    await buildFixtureModule(root, {
      id: "sf-test",
      bills: JSON.stringify({ module_id: "sf-test" }),
    });
    const result = await loadCorpus(root);
    expect(result.kind).toBe("error");
  });

  it("ignores non-.json files in the bills directory", async () => {
    await buildFixtureModule(root, {
      id: "sf-test",
      bills: [makeBill({ file_no: "260217", module_id: "sf-test" })],
    });
    // Drop a stray file directly.
    await writeFile(join(root, "sf-test", "bills", "README.md"), "ignored");
    const result = await loadCorpus(root);
    expect(result.kind).toBe("ok");
    expect(listPendingBills()).toHaveLength(1);
  });

  it("aggregates session bills across multiple modules", async () => {
    await buildFixtureModule(root, {
      id: "sf-admin",
      bills: [makeBill({ file_no: "260217", module_id: "sf-admin" })],
    });
    await buildFixtureModule(root, {
      id: "sf-health",
      bills: [makeBill({ file_no: "260218", module_id: "sf-health" })],
    });
    const result = await loadCorpus(root);
    expect(result.kind).toBe("ok");
    const bills = listPendingBills();
    expect(bills).toHaveLength(2);
    expect(new Set(bills.map((b) => b.module_id))).toEqual(new Set(["sf-admin", "sf-health"]));
  });
});

describe("corpus-loader: jurisdiction-rooted tree", () => {
  let root: string;
  beforeEach(async () => {
    __resetCorpusForTests();
    root = await mkdtemp(join(tmpdir(), "legiscode-loader-jurisdiction-"));
  });
  afterEach(async () => {
    __resetCorpusForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("wraps every module under a single jurisdiction root", async () => {
    await buildFixtureModule(root, { id: "sf-admin" });
    await buildFixtureModule(root, { id: "sf-health" });
    const result = await loadCorpus(root);
    expect(result.kind).toBe("ok");
    const summary = listCorpus();
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.tree).toHaveLength(1);
    const root0 = summary.value.tree[0];
    expect(root0?.kind).toBe("jurisdiction");
    expect(root0?.name).toBe("Test City");
    expect(root0?.kids).toHaveLength(2);
    expect(root0?.kids?.map((k) => k.kind)).toEqual(["code", "code"]);
  });

  it("reports zero session bills when no module has bills entries", async () => {
    // r11: bills live on `summary.sessionBills`, not as tree nodes.
    // Field name kept until T5 reshape; semantics already widened.
    await buildFixtureModule(root, { id: "sf-admin" });
    await loadCorpus(root);
    const summary = listCorpus();
    if (!summary.ok) throw new Error("unreachable");
    const root0 = summary.value.tree[0];
    // Tree kids are only `code` modules — no bill branch ever appears.
    expect(root0?.kids?.map((k) => k.kind)).toEqual(["code"]);
    expect(summary.value.sessionBills.count).toBe(0);
    expect(summary.value.sessionBills.bills).toEqual([]);
  });

  it("exposes session bills via `sessionBills`, not as tree nodes", async () => {
    await buildFixtureModule(root, {
      id: "sf-admin",
      bills: [
        makeBill({ file_no: "260217", module_id: "sf-admin", short_title: "Speed Reduction" }),
      ],
    });
    await buildFixtureModule(root, {
      id: "sf-health",
      bills: [
        makeBill({ file_no: "260218", module_id: "sf-health", short_title: "School Buffer" }),
      ],
    });
    await loadCorpus(root);
    const summary = listCorpus();
    if (!summary.ok) throw new Error("unreachable");
    const root0 = summary.value.tree[0];
    // Tree only carries `code` modules — bills are not tree nodes.
    expect(root0?.kids?.map((k) => k.kind)).toEqual(["code", "code"]);
    expect(summary.value.sessionBills.count).toBe(2);
    expect(summary.value.sessionBills.bills.map((b) => b.file_no).sort()).toEqual([
      "260217",
      "260218",
    ]);
  });

  it("counts multi-code bills once by file_no", async () => {
    // Same file_no in two modules — the bill touches sf-admin AND sf-health.
    await buildFixtureModule(root, {
      id: "sf-admin",
      bills: [makeBill({ file_no: "260300", module_id: "sf-admin" })],
    });
    await buildFixtureModule(root, {
      id: "sf-health",
      bills: [makeBill({ file_no: "260300", module_id: "sf-health" })],
    });
    await loadCorpus(root);
    const summary = listCorpus();
    if (!summary.ok) throw new Error("unreachable");
    // count is the unique file_no count, not the row count.
    expect(summary.value.sessionBills.count).toBe(1);
    // bills carries every per-(module, file_no) row so the BillView can
    // aggregate across modules.
    expect(summary.value.sessionBills.bills).toHaveLength(2);
  });
});
