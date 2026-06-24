import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CorpusMetaSchema } from "@/types/corpus-meta";
import { DistributedModuleManifestSchema } from "@/types/manifest";
import {
  CatalogIndexSchema,
  JurisdictionCatalogSchema,
  type CatalogModule,
} from "@/corpus/catalog";

interface PackOptions {
  modulesDir: string;
  outputDir: string;
}

export async function packModules(opts: PackOptions): Promise<void> {
  const { modulesDir, outputDir } = opts;

  await mkdir(outputDir, { recursive: true });

  const entries = await readdir(modulesDir, { withFileTypes: true });
  const moduleDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  if (moduleDirs.length === 0) {
    throw new Error(`no module directories found in ${modulesDir}`);
  }

  // Build catalog entries per jurisdiction id
  const byJd = new Map<string, { name: string; modules: CatalogModule[] }>();

  for (const moduleId of moduleDirs) {
    const moduleDir = join(modulesDir, moduleId);

    const [rawMeta, rawManifest] = await Promise.all([
      readFile(join(moduleDir, "corpus-meta.json"), "utf8"),
      readFile(join(moduleDir, "manifest.json"), "utf8"),
    ]);

    const meta = CorpusMetaSchema.parse(JSON.parse(rawMeta));
    const manifest = DistributedModuleManifestSchema.parse(JSON.parse(rawManifest));

    // Derive jurisdiction id from module id prefix (before first hyphen)
    const jdId = moduleId.split("-")[0] ?? moduleId;
    const jdName = manifest.jurisdiction;

    const archiveName = `${moduleId}@${meta.module_version}.tar.gz`;
    const archivePath = join(outputDir, archiveName);

    // Create tar.gz of the module directory
    execFileSync("tar", ["-czf", archivePath, "-C", modulesDir, moduleId]);

    const archiveBytes = await readFile(archivePath);
    const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
    const sizeBytes = archiveBytes.length;

    const entry: CatalogModule = {
      id: meta.module_id,
      name: manifest.name,
      module_version: meta.module_version,
      schema_version: meta.schema_version,
      jurisdiction: jdName,
      archive: archiveName,
      content_checksum: meta.checksum,
      archive_sha256: archiveSha256,
      size_bytes: sizeBytes,
    };

    if (!byJd.has(jdId)) {
      byJd.set(jdId, { name: jdName, modules: [] });
    }
    byJd.get(jdId)?.modules.push(entry);
  }

  const generatedAt = new Date().toISOString();
  const schemaVersion = 5;

  // Write per-jurisdiction catalogs
  for (const [jdId, { name, modules }] of byJd) {
    const catalog = JurisdictionCatalogSchema.parse({
      schema_version: schemaVersion,
      jurisdiction: name,
      generated_at: generatedAt,
      modules,
    });
    await writeFile(
      join(outputDir, `catalog-${jdId}.json`),
      JSON.stringify(catalog, null, 2),
      "utf8",
    );
  }

  // Write index.json
  const index = CatalogIndexSchema.parse({
    schema_version: schemaVersion,
    generated_at: generatedAt,
    jurisdictions: [...byJd.entries()].map(([id, { name, modules }]) => ({
      id,
      name,
      module_count: modules.length,
      catalog: `catalog-${id}.json`,
    })),
  });
  await writeFile(join(outputDir, "index.json"), JSON.stringify(index, null, 2), "utf8");
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  let modulesDir = "build/modules";
  let outputDir = "build/dist";

  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--modules-dir" && next) { modulesDir = next; i++; }
    else if (args[i] === "--output" && next) { outputDir = next; i++; }
    else if (args[i] === "--help") {
      console.log("Usage: pack-modules [--modules-dir DIR] [--output DIR]");
      return 0;
    }
  }

  try {
    await packModules({ modulesDir, outputDir });
    console.log(`packed modules from ${modulesDir} → ${outputDir}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv).then(process.exit);
}
