import { z } from "zod";
import { ModuleIdSchema } from "@/types/identifiers";

const SHA256_RE = /^[0-9a-f]{64}$/;

export const CatalogModuleSchema = z.object({
  id: ModuleIdSchema,
  name: z.string().min(1),
  module_version: z.string().regex(/^\d{4}\.\d{2}\.\d{2}$/),
  schema_version: z.number().int().positive(),
  jurisdiction: z.string().min(1),
  archive: z.string().min(1),
  content_checksum: z.string().regex(SHA256_RE, "must be sha256 hex"),
  archive_sha256: z.string().regex(SHA256_RE, "must be sha256 hex"),
  size_bytes: z.number().int().nonnegative(),
});
export type CatalogModule = z.infer<typeof CatalogModuleSchema>;

const JurisdictionEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  module_count: z.number().int().nonnegative(),
  catalog: z.string().min(1),
});
export type JurisdictionEntry = z.infer<typeof JurisdictionEntrySchema>;

export const JurisdictionCatalogSchema = z.object({
  schema_version: z.number().int().positive(),
  jurisdiction: z.string().min(1),
  generated_at: z.iso.datetime({ offset: true }),
  modules: z.array(CatalogModuleSchema),
});
export type JurisdictionCatalog = z.infer<typeof JurisdictionCatalogSchema>;

export const CatalogIndexSchema = z.object({
  schema_version: z.number().int().positive(),
  generated_at: z.iso.datetime({ offset: true }),
  jurisdictions: z.array(JurisdictionEntrySchema),
});
export type CatalogIndex = z.infer<typeof CatalogIndexSchema>;
