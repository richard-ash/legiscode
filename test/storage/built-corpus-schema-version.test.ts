// Guards against a stale `build/modules/` rotting silently while the
// app's KNOWN_SCHEMA_VERSION moves forward. The loader's
// MIN_SUPPORTED_SCHEMA_VERSION gate fires at runtime in dev, so without
// this test the developer learns about the drift by booting the app
// and seeing a load failure. The CI build-matrix smoke spec rebuilds
// the corpus from `manifests/sf/jurisdiction.json` before launching,
// so CI never trips the gate; the gap is exclusively local-dev.
//
// Skips cleanly when `build/modules/` is absent — that's the state on
// a fresh clone, inside the Linux Docker vitest job, or before the
// first `mise run corpus:build`. When present, every per-module
// corpus-meta.json is asserted at KNOWN_SCHEMA_VERSION.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_SCHEMA_VERSION } from "@/types";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BUILD_MODULES = join(REPO_ROOT, "build", "modules");

function listModuleDirs(root: string): string[] {
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory());
}

describe("built corpus schema version", () => {
  if (!existsSync(BUILD_MODULES)) {
    it.skip("build/modules absent — run `mise run corpus:build` to enable this gate", () => {});
    return;
  }

  const moduleDirs = listModuleDirs(BUILD_MODULES);

  if (moduleDirs.length === 0) {
    it.skip("build/modules is empty — run `mise run corpus:build` to populate it", () => {});
    return;
  }

  for (const moduleDir of moduleDirs) {
    const metaPath = join(moduleDir, "corpus-meta.json");
    it(`${moduleDir.slice(REPO_ROOT.length + 1)} matches KNOWN_SCHEMA_VERSION`, () => {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { schema_version?: number };
      expect(
        meta.schema_version,
        `${metaPath} is at schema_version ${meta.schema_version}, app is at ${KNOWN_SCHEMA_VERSION}. ` +
          "Rebuild: `mise run corpus:build -- --source manifests/sf/jurisdiction.json --output build/modules`",
      ).toBe(KNOWN_SCHEMA_VERSION);
    });
  }
});
