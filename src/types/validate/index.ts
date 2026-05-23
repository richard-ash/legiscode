// All corpus reads go through this module's exports. Raw fs.readFile +
// JSON.parse skips zod validation and risks downstream type/data drift; if
// you need a reader that doesn't exist, add one here.
//
// Validation policy: validate-on-every-read. Profile if it shows up in
// flame graphs; if it does, switch to validate-on-load + readonly cached
// objects — DON'T silently bypass.
//
// Errors are produced by formatZodError (a single formatter for the whole
// codebase) so messages name the offending field. Tests assert the field
// appears in the string; they don't depend on raw zod internal text.

import { readFile } from "node:fs/promises";
import { type ZodType, z } from "zod";
import type { CorpusMeta } from "../corpus-meta";
import { CorpusMetaSchema } from "../corpus-meta";
import type { ModuleDefinitions } from "../definitions";
import { ModuleDefinitionsSchema } from "../definitions";
import type { DistributedModuleManifest, JurisdictionManifest } from "../manifest";
import { DistributedModuleManifestSchema, JurisdictionManifestSchema } from "../manifest";
import type { OrdinanceFile } from "../ordinance";
import { OrdinanceFileSchema } from "../ordinance";
import type { SectionFile } from "../section";
import { SectionFileSchema } from "../section";
import { formatZodError } from "./format-error";

export class CorpusReadError extends Error {
  constructor(
    readonly path: string,
    readonly stage: "read" | "parse" | "validate",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CorpusReadError";
  }
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new CorpusReadError(path, "read", `${path}: ${(cause as Error).message}`, { cause });
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new CorpusReadError(
      path,
      "parse",
      `${path}: invalid JSON (${(cause as Error).message})`,
      {
        cause,
      },
    );
  }
}

async function parseFile<T>(path: string, schema: ZodType<T>): Promise<T> {
  const raw = await readJson(path);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new CorpusReadError(path, "validate", `${path}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export const readSection = (path: string): Promise<SectionFile> =>
  parseFile(path, SectionFileSchema);

export const readOrdinance = (path: string): Promise<OrdinanceFile> =>
  parseFile(path, OrdinanceFileSchema);

export const readJurisdictionManifest = (path: string): Promise<JurisdictionManifest> =>
  parseFile(path, JurisdictionManifestSchema);

export const readDistributedModuleManifest = (path: string): Promise<DistributedModuleManifest> =>
  parseFile(path, DistributedModuleManifestSchema);

export const readDefinitions = (path: string): Promise<ModuleDefinitions> =>
  parseFile(path, ModuleDefinitionsSchema);

export const readCorpusMeta = (path: string): Promise<CorpusMeta> =>
  parseFile(path, CorpusMetaSchema);

export type { ZodType };
// Re-export z for downstream tests that want to construct fixtures with the
// schemas directly without depending on zod's path inside node_modules.
export { formatZodError, z };
