import * as fsp from "node:fs/promises";
import { mkdtemp, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalStringify, fsyncDir, writeJson } from "@/storage";

// vi.mock replaces the entire module so that `open` becomes a vi.fn we can
// observe; that sidesteps the ESM-namespace-not-configurable error you'd
// hit with vi.spyOn(fsp, "open"). Existing tests still work because the
// wrapper delegates to the real implementation by default.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
  };
});

describe("canonicalStringify", () => {
  it("sorts object keys recursively", () => {
    const out = canonicalStringify({ b: 1, a: { z: 1, y: 2 } });
    expect(out).toBe('{\n  "a": {\n    "y": 2,\n    "z": 1\n  },\n  "b": 1\n}\n');
  });

  it("preserves array order", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[\n  3,\n  1,\n  2\n]\n");
  });

  it("ends with a single LF newline", () => {
    expect(canonicalStringify({})).toMatch(/}\n$/);
    expect(canonicalStringify({})).not.toMatch(/}\n\n$/);
  });

  it("uses 2-space indentation", () => {
    expect(canonicalStringify({ a: 1 })).toContain('\n  "a"');
  });

  it("is stable across runs", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });
});

describe("writeJson", () => {
  let dir: string;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the canonical body and round-trips", async () => {
    dir = await mkdtemp(join(tmpdir(), "legiscode-canonical-"));
    const path = join(dir, "out.json");
    await writeJson(path, { z: 1, a: { c: 2, b: 1 } });
    const body = await readFile(path, "utf8");
    expect(body).toBe('{\n  "a": {\n    "b": 1,\n    "c": 2\n  },\n  "z": 1\n}\n');
  });

  it("calls FileHandle.sync() before close() (durability ordering)", async () => {
    dir = await mkdtemp(join(tmpdir(), "legiscode-canonical-"));
    const path = join(dir, "ordered.json");

    // Wrap the open() vi.fn so it returns a FileHandle whose .sync() and
    // .close() methods record their call order. Restored by afterEach.
    const events: string[] = [];
    const realOpen = vi.mocked(fsp.open);
    realOpen.mockImplementationOnce(async (...args) => {
      const handle = await (await vi.importActual<typeof fsp>("node:fs/promises")).open(
        ...(args as Parameters<typeof fsp.open>),
      );
      const realSync = handle.sync.bind(handle);
      const realClose = handle.close.bind(handle);
      handle.sync = async () => {
        events.push(`sync(${args[0]})`);
        await realSync();
      };
      handle.close = async () => {
        events.push(`close(${args[0]})`);
        await realClose();
      };
      return handle;
    });

    await writeJson(path, { ok: true });

    const fileSyncIndex = events.indexOf(`sync(${path})`);
    const fileCloseIndex = events.indexOf(`close(${path})`);
    expect(fileSyncIndex).toBeGreaterThanOrEqual(0);
    expect(fileCloseIndex).toBeGreaterThan(fileSyncIndex);
  });
});

describe("fsyncDir", () => {
  it("opens, syncs, and closes the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "legiscode-fsync-"));
    // No throw == pass; on macOS dir.sync() works, on Windows it would no-op.
    await expect(fsyncDir(dir)).resolves.toBeUndefined();
    // Ensure we can still open it afterwards (handle was closed).
    const dirHandle = await open(dir, "r");
    await dirHandle.close();
  });
});
