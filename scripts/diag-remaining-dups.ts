// Diagnostic: for each collision, find the SOURCE anchors in the
// HTML and print their name/title attributes. Reveals whether the
// collision is parser-introduced or source-genuine.

import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { parseExport } from "@/parser";
import { readJurisdictionManifest } from "@/types/validate";

async function main(): Promise<void> {
  const manifest = await readJurisdictionManifest("manifests/sf/jurisdiction.json");
  const buf = await readFile("build/downloads/sf.html");
  const parsed = parseExport(buf, manifest);

  const $ = cheerio.load(buf.toString("utf-8"));
  for (const mod of parsed) {
    const byId = new Map<string, typeof mod.sections>();
    for (const s of mod.sections) {
      const arr = byId.get(s.id) ?? [];
      arr.push(s);
      byId.set(s.id, arr);
    }
    let printed = false;
    for (const [id, members] of byId) {
      if (members.length < 2) continue;
      if (!printed) {
        console.log(`\n=== ${mod.module.id} ===`);
        printed = true;
      }
      console.log(`  id="${id}" ×${members.length}`);
      for (const m of members) {
        console.log(
          `    hier=${JSON.stringify(m.hierarchy)} status=${m.editorial_status} title=${JSON.stringify(m.title.slice(0, 50))}`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
