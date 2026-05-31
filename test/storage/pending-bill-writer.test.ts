import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeStalePendingBills, writePendingBill } from "@/storage/writer";
import { BillSchema, type Bill } from "@/types";

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
    affected_sections: ["10.04.020"],
    text_diff: [],
    parse_status: "manual_review",
    structural_change_scope: null,
    proposed_text: "",
  };
  return BillSchema.parse({ ...base, ...overrides });
}

describe("writePendingBill", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "legiscode-pending-bill-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a canonical-JSON file at pending-bills/<file_no>.json", async () => {
    const bill = makeBill({ file_no: "260217" });
    const { path } = await writePendingBill({ moduleDir: dir, bill });
    expect(path).toBe(join(dir, "pending-bills", "260217.json"));
    const text = await readFile(path, "utf8");
    // Trailing newline + 2-space indent + sorted keys per canonical-json.
    expect(text.endsWith("\n")).toBe(true);
    const reparsed = JSON.parse(text);
    expect(BillSchema.parse(reparsed).file_no).toBe("260217");
  });

  it("overwrites an existing pending-bill file at the same file_no", async () => {
    await writePendingBill({
      moduleDir: dir,
      bill: makeBill({ file_no: "260217", short_title: "v1" }),
    });
    await writePendingBill({
      moduleDir: dir,
      bill: makeBill({ file_no: "260217", short_title: "v2" }),
    });
    const text = await readFile(join(dir, "pending-bills", "260217.json"), "utf8");
    expect(JSON.parse(text).short_title).toBe("v2");
    // Only one entry; no leftover .tmp file.
    expect(await readdir(join(dir, "pending-bills"))).toEqual(["260217.json"]);
  });

  it("creates the pending-bills directory on first write", async () => {
    expect(await readdir(dir).then((entries) => entries.includes("pending-bills"))).toBe(false);
    await writePendingBill({ moduleDir: dir, bill: makeBill() });
    expect(await readdir(dir).then((entries) => entries.includes("pending-bills"))).toBe(true);
  });
});

describe("purgeStalePendingBills", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "legiscode-purge-pending-"));
    await mkdir(join(dir, "pending-bills"), { recursive: true });
    await writeFile(join(dir, "pending-bills", "260217.json"), "{}");
    await writeFile(join(dir, "pending-bills", "260296.json"), "{}");
    await writeFile(join(dir, "pending-bills", "260541.json"), "{}");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("deletes files whose file_no isn't in keepFileNos", async () => {
    const { deleted } = await purgeStalePendingBills({
      moduleDir: dir,
      keepFileNos: new Set(["260217"]),
    });
    expect(deleted).toHaveLength(2);
    expect(deleted.some((p) => p.endsWith("260296.json"))).toBe(true);
    expect(deleted.some((p) => p.endsWith("260541.json"))).toBe(true);
    const remaining = await readdir(join(dir, "pending-bills"));
    expect(remaining).toEqual(["260217.json"]);
  });

  it("deletes everything when keepFileNos is empty", async () => {
    const { deleted } = await purgeStalePendingBills({
      moduleDir: dir,
      keepFileNos: new Set(),
    });
    expect(deleted).toHaveLength(3);
    expect(await readdir(join(dir, "pending-bills"))).toEqual([]);
  });

  it("returns empty delete list when the directory doesn't exist", async () => {
    await rm(join(dir, "pending-bills"), { recursive: true });
    const result = await purgeStalePendingBills({
      moduleDir: dir,
      keepFileNos: new Set(["260217"]),
    });
    expect(result.deleted).toEqual([]);
  });

  it("ignores non-.json files in the directory", async () => {
    await writeFile(join(dir, "pending-bills", "scratch.txt"), "ignored");
    await purgeStalePendingBills({
      moduleDir: dir,
      keepFileNos: new Set(["260217", "260296", "260541"]),
    });
    expect(await readdir(join(dir, "pending-bills"))).toContain("scratch.txt");
  });
});
