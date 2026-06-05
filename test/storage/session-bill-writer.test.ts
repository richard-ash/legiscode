import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeStaleSessionBills, writeSessionBill } from "@/storage/writer";
import { type Bill, BillSchema } from "@/types";

function makeBill(overrides: Partial<Bill> = {}): Bill {
  const base: Bill = {
    file_no: "260217",
    module_id: "sf-administrative",
    short_title: "Multi-code update",
    long_title: "Ordinance amending the Administrative Code…",
    sponsor: "Sup. Walton",
    introduced_at: "2026-05-15",
    legistar_url: "https://sfgov.legistar.com/LegislationDetail.aspx?ID=1&GUID=g",
    legistar_status: "Pending Committee Hearing",
    bill_status: "committee",
    section_outcomes: [
      { section_id: "10.04.020", status: "classification_low_confidence", detail: null },
    ],
    text_diff: [],
    parse_status: "manual_review",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
  };
  return BillSchema.parse({ ...base, ...overrides });
}

describe("writeSessionBill", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "legiscode-session-bill-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a canonical-JSON file at bills/<file_no>.json", async () => {
    const bill = makeBill({ file_no: "260217" });
    const { path } = await writeSessionBill({ moduleDir: dir, bill });
    expect(path).toBe(join(dir, "bills", "260217.json"));
    const text = await readFile(path, "utf8");
    // Trailing newline + 2-space indent + sorted keys per canonical-json.
    expect(text.endsWith("\n")).toBe(true);
    const reparsed = JSON.parse(text);
    expect(BillSchema.parse(reparsed).file_no).toBe("260217");
  });

  it("overwrites an existing session-bill file at the same file_no", async () => {
    await writeSessionBill({
      moduleDir: dir,
      bill: makeBill({ file_no: "260217", short_title: "v1" }),
    });
    await writeSessionBill({
      moduleDir: dir,
      bill: makeBill({ file_no: "260217", short_title: "v2" }),
    });
    const text = await readFile(join(dir, "bills", "260217.json"), "utf8");
    expect(JSON.parse(text).short_title).toBe("v2");
    // Only one entry; no leftover .tmp file.
    expect(await readdir(join(dir, "bills"))).toEqual(["260217.json"]);
  });

  it("creates the bills directory on first write", async () => {
    expect(await readdir(dir).then((entries) => entries.includes("bills"))).toBe(false);
    await writeSessionBill({ moduleDir: dir, bill: makeBill() });
    expect(await readdir(dir).then((entries) => entries.includes("bills"))).toBe(true);
  });
});

describe("purgeStaleSessionBills", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "legiscode-purge-session-"));
    await mkdir(join(dir, "bills"), { recursive: true });
    await writeFile(join(dir, "bills", "260217.json"), "{}");
    await writeFile(join(dir, "bills", "260296.json"), "{}");
    await writeFile(join(dir, "bills", "260541.json"), "{}");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("deletes files whose file_no isn't in keepFileNos", async () => {
    const { deleted } = await purgeStaleSessionBills({
      moduleDir: dir,
      keepFileNos: new Set(["260217"]),
    });
    expect(deleted).toHaveLength(2);
    expect(deleted.some((p) => p.endsWith("260296.json"))).toBe(true);
    expect(deleted.some((p) => p.endsWith("260541.json"))).toBe(true);
    const remaining = await readdir(join(dir, "bills"));
    expect(remaining).toEqual(["260217.json"]);
  });

  it("deletes everything when keepFileNos is empty", async () => {
    const { deleted } = await purgeStaleSessionBills({
      moduleDir: dir,
      keepFileNos: new Set(),
    });
    expect(deleted).toHaveLength(3);
    expect(await readdir(join(dir, "bills"))).toEqual([]);
  });

  it("returns empty delete list when the directory doesn't exist", async () => {
    await rm(join(dir, "bills"), { recursive: true });
    const result = await purgeStaleSessionBills({
      moduleDir: dir,
      keepFileNos: new Set(["260217"]),
    });
    expect(result.deleted).toEqual([]);
  });

  it("ignores non-.json files in the directory", async () => {
    await writeFile(join(dir, "bills", "scratch.txt"), "ignored");
    await purgeStaleSessionBills({
      moduleDir: dir,
      keepFileNos: new Set(["260217", "260296", "260541"]),
    });
    expect(await readdir(join(dir, "bills"))).toContain("scratch.txt");
  });
});
