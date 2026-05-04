// Single producer for every JSON file the parser writes. Output is
// canonical-form by construction (sorted object keys, 2-space indent, LF,
// trailing newline) so the corpus checksum is stable across runs.
//
// The fsync sequence is open -> write -> handle.sync() -> close, then
// open(parent dir) -> dirHandle.sync() -> close. fsync MUST happen before
// close; fsync-after-close is a no-op for durability and is the easiest
// way to ship a "data was there until the power went out" bug.

import { open } from "node:fs/promises";
import { dirname } from "node:path";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      out[key] = canonicalize(val);
    }
    return out;
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

// Open the containing directory and fsync it. Exposed for atomic-write.ts
// (renames + unlinks need parent-dir fsync to flush the dirent).
export async function fsyncDir(path: string): Promise<void> {
  const dir = await open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const body = canonicalStringify(value);
  const handle = await open(path, "w");
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDir(dirname(path));
}
