import * as fsp from "node:fs/promises";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  computeChecksum,
  ExitCodes,
  ensureCleanNew,
  isSentinelValid,
  type Lock,
  promote,
  recover,
  releaseLock,
} from "@/storage";

// Mock node:fs/promises so the fs ops we want to observe (open, rm) are
// vi.fns. Existing tests still use the real implementations because
// vi.fn(actual.X) delegates by default; only the targeted tests override
// with mockImplementationOnce. Sidesteps "namespace not configurable in
// ESM" that vi.spyOn would hit.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rm: vi.fn(actual.rm),
  };
});

import { composeCorpusMeta, writeCorpusMeta, writeJson } from "@/storage";
import type { ModuleConfig } from "@/types";

const moduleConfig: ModuleConfig = {
  id: "sf-municipal",
  name: "SF",
  code_title: "Municipal Code",
  module_version: "2026.04.30",
  citation_patterns: ["x"],
  max_skip_count: 0,
  defined_term_patterns: ["x"],
};

const jurisdiction = "City and County of San Francisco";
// 64-char hex placeholder; opaque to composeCorpusMeta and atomic-write.
const sourceSha256 = "b".repeat(64);

async function tmpOutput(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "legiscode-aw-"));
  return join(root, "module");
}

async function makeValidNew(output: string): Promise<string> {
  const newDir = await ensureCleanNew(output);
  await writeJson(join(newDir, "manifest.json"), { id: moduleConfig.id });
  await writeJson(join(newDir, "definitions.json"), {});
  const meta = await composeCorpusMeta({
    jurisdiction,
    module: moduleConfig,
    moduleDir: newDir,
    snapshotAt: "2026-04-30T12:34:56Z",
    skipped: [],
    corpusEntryKinds: ["section"],
    sourceSha256,
  });
  await writeCorpusMeta(newDir, meta);
  return newDir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acquireLock — mkdir parent (P2 #5)", () => {
  it("creates dirname(output) idempotently on a fresh checkout", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    expect((await stat(`${output}.lock`)).isFile()).toBe(true);
    await releaseLock(lock);
  });

  it("does not error if dirname already exists", async () => {
    const output = await tmpOutput();
    await mkdir(join(output, ".."), { recursive: true });
    const lock = await acquireLock(output);
    await releaseLock(lock);
  });
});

describe("acquireLock — link(2) atomic create", () => {
  it("returns a Lock with a non-empty token on a clean directory", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    expect(lock.token.uuid.length).toBeGreaterThan(0);
    expect(lock.token.hostname.length).toBeGreaterThan(0);
    expect(lock.lockPath).toBe(`${output}.lock`);
    await releaseLock(lock);
  });

  it("never leaves a .lock.tmp.* orphan on success", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    await releaseLock(lock);
    const entries = await readdir(join(output, ".."));
    expect(entries.filter((e) => e.includes(".lock.tmp."))).toEqual([]);
  });
});

describe("acquireLock — concurrent builds (mandatory)", () => {
  it("second concurrent builder fails fast with LOCK_HELD (exit 6)", async () => {
    const output = await tmpOutput();
    const first = await acquireLock(output);
    await expect(acquireLock(output)).rejects.toMatchObject({
      name: "AtomicWriteError",
      exitCode: ExitCodes.LOCK_HELD,
    });
    await releaseLock(first);
  });
});

describe("acquireLock — stale-lock (mtime / start_time staleness)", () => {
  it("removes a lock whose start_time_iso is older than MAX_BUILD_AGE and retries once", async () => {
    const output = await tmpOutput();
    await mkdir(join(output, ".."), { recursive: true });
    // Plant a lockfile that looks "alive" by file mtime but ancient by token.
    await writeFile(
      `${output}.lock`,
      `${JSON.stringify({
        hostname: "stale-host",
        pid: 99999,
        start_time_iso: "2000-01-01T00:00:00Z",
        uuid: "old-uuid",
      })}\n`,
      "utf8",
    );
    const lock = await acquireLock(output, { maxBuildAgeSeconds: 60 });
    expect(lock.token.uuid).not.toBe("old-uuid");
    await releaseLock(lock);
  });

  it("fails fast when an existing token is still within MAX_BUILD_AGE", async () => {
    const output = await tmpOutput();
    await mkdir(join(output, ".."), { recursive: true });
    await writeFile(
      `${output}.lock`,
      JSON.stringify({
        hostname: "alive-host",
        pid: 12345,
        start_time_iso: new Date().toISOString(),
        uuid: "alive-uuid",
      }),
      "utf8",
    );
    await expect(acquireLock(output, { maxBuildAgeSeconds: 7200 })).rejects.toMatchObject({
      exitCode: ExitCodes.LOCK_HELD,
    });
  });
});

describe("acquireLock — lock-corrupt-orphan (mandatory)", () => {
  it("refuses to delete a recently-modified corrupt lockfile (exit 7)", async () => {
    const output = await tmpOutput();
    await mkdir(join(output, ".."), { recursive: true });
    await writeFile(`${output}.lock`, "{not json", "utf8");
    await expect(acquireLock(output, { graceSeconds: 7200 })).rejects.toMatchObject({
      exitCode: ExitCodes.RECOVERY_REFUSED,
    });
  });

  it("removes a corrupt lockfile older than GRACE_SECONDS and retries", async () => {
    const output = await tmpOutput();
    await mkdir(join(output, ".."), { recursive: true });
    await writeFile(`${output}.lock`, "{not json", "utf8");
    // grace=0 means even a fresh corrupt lock is past grace.
    const lock = await acquireLock(output, { graceSeconds: 0 });
    expect(lock).toBeDefined();
    await releaseLock(lock);
  });
});

describe("releaseLock — token-checked unlink (lock-release-token-check)", () => {
  it("does not unlink a lockfile whose uuid does not match", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    // Forge a "different builder" lock: same path, different uuid in our memory.
    const fakeLock: Lock = {
      output,
      lockPath: lock.lockPath,
      token: { ...lock.token, uuid: "WRONG" },
    };
    await releaseLock(fakeLock);
    // The real lockfile should still be there.
    expect((await stat(lock.lockPath)).isFile()).toBe(true);
    await releaseLock(lock);
  });
});

describe("ensureCleanNew + isSentinelValid", () => {
  it("creates a clean .new directory and reports invalid until the sentinel is written", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      const newDir = await ensureCleanNew(output);
      expect(await isSentinelValid(newDir)).toBe(false);
      await makeValidNew(output);
      expect(await isSentinelValid(`${output}.new`)).toBe(true);
    } finally {
      await releaseLock(lock);
    }
  });

  it("detects a tampered file via checksum mismatch", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      const newDir = await makeValidNew(output);
      await writeFile(join(newDir, "definitions.json"), '{"tampered": true}\n', "utf8");
      expect(await isSentinelValid(newDir)).toBe(false);
    } finally {
      await releaseLock(lock);
    }
  });
});

describe("promote — happy path + sentinel gate", () => {
  it("first install: rename .new -> output", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      await makeValidNew(output);
      await promote(output, lock);
      expect((await stat(output)).isDirectory()).toBe(true);
      // .new is gone after promotion.
      await expect(stat(`${output}.new`)).rejects.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });

  it("upgrade: live + .new -> live (with .old cleanup)", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      await makeValidNew(output);
      await promote(output, lock);
      const firstChecksum = await computeChecksum(output);
      // Second build with a different file content -> different checksum.
      const newDir = await ensureCleanNew(output);
      await writeJson(join(newDir, "manifest.json"), { id: moduleConfig.id });
      await writeJson(join(newDir, "references.json"), {
        changed: { citations: [], cited_by: [] },
      });
      await writeJson(join(newDir, "definitions.json"), {});
      const meta = await composeCorpusMeta({
        jurisdiction,
        module: moduleConfig,
        moduleDir: newDir,
        snapshotAt: "2026-04-30T12:35:00Z",
        skipped: [],
        corpusEntryKinds: ["section"],
        sourceSha256,
      });
      await writeCorpusMeta(newDir, meta);
      await promote(output, lock);
      const secondChecksum = await computeChecksum(output);
      expect(secondChecksum).not.toBe(firstChecksum);
      await expect(stat(`${output}.old`)).rejects.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });

  it("refuses to promote when the sentinel is missing (partial-new-no-sentinel, mandatory)", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      const newDir = await ensureCleanNew(output);
      await writeJson(join(newDir, "manifest.json"), { id: moduleConfig.id });
      // No corpus-meta.json written.
      await expect(promote(output, lock)).rejects.toMatchObject({
        exitCode: ExitCodes.RECOVERY_REFUSED,
      });
      await expect(stat(newDir)).rejects.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });

  it("refuses to promote when checksum mismatches (checksum-mismatch, mandatory)", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      const newDir = await makeValidNew(output);
      await writeFile(join(newDir, "references.json"), '{"tampered": true}\n', "utf8");
      await expect(promote(output, lock)).rejects.toMatchObject({
        exitCode: ExitCodes.RECOVERY_REFUSED,
      });
    } finally {
      await releaseLock(lock);
    }
  });
});

describe("recover — Phase A handles .old first, fatal on cleanup failure (mandatory)", () => {
  it("removes a leftover .old when live exists", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      await makeValidNew(output);
      await promote(output, lock);
      // Inject a leftover .old next to live.
      await mkdir(`${output}.old`, { recursive: true });
      await writeFile(`${output}.old/orphan.txt`, "leftover", "utf8");
      await recover(output, lock);
      await expect(stat(`${output}.old`)).rejects.toThrow();
      // Live output untouched.
      expect((await stat(output)).isDirectory()).toBe(true);
    } finally {
      await releaseLock(lock);
    }
  });

  it("rolls back when only .old exists (no live, no .new)", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      await mkdir(`${output}.old`, { recursive: true });
      await writeFile(`${output}.old/marker.txt`, "rollback me", "utf8");
      await recover(output, lock);
      expect(await readFile(`${output}/marker.txt`, "utf8")).toBe("rollback me");
      await expect(stat(`${output}.old`)).rejects.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });

  it("fatal-on-old-cleanup: exits 7 when .old cannot be removed", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      await makeValidNew(output);
      await promote(output, lock);
      // Plant a leftover .old next to the live output, then make rm throw
      // EBUSY exactly once (next call). recoverPhaseA must propagate.
      await mkdir(`${output}.old`, { recursive: true });
      const rmMock = vi.mocked(fsp.rm);
      rmMock.mockImplementationOnce(async () => {
        const err = new Error("EBUSY: device or resource busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      });
      await expect(recover(output, lock)).rejects.toMatchObject({
        name: "AtomicWriteError",
        exitCode: ExitCodes.RECOVERY_REFUSED,
      });
    } finally {
      await releaseLock(lock);
    }
  });
});

describe("recover — Phase B handles .new (orphan promotion + bad sentinel)", () => {
  it("promotes a stray .new with a valid sentinel (first install)", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      await makeValidNew(output);
      // Don't call promote; force recover() to do the first-install promotion.
      await recover(output, lock);
      expect((await stat(output)).isDirectory()).toBe(true);
      await expect(stat(`${output}.new`)).rejects.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });

  it("removes a .new without a sentinel", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      const newDir = await ensureCleanNew(output);
      await writeJson(join(newDir, "manifest.json"), { id: moduleConfig.id });
      await recover(output, lock);
      await expect(stat(newDir)).rejects.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });

  it("removes a .new with a tampered file (sentinel checksum invalid)", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      const newDir = await makeValidNew(output);
      await writeFile(join(newDir, "references.json"), '{"tampered": true}\n', "utf8");
      await recover(output, lock);
      await expect(stat(newDir)).rejects.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });
});

describe("recover — crash between rename1 and rename2 (crash-mid, mandatory)", () => {
  it("commits forward when .new has a valid sentinel", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      // Set up a valid initial install.
      await makeValidNew(output);
      await promote(output, lock);
      // Build a second .new and simulate crash between rename1 (output -> .old)
      // and rename2 (.new -> output).
      const newDir = await ensureCleanNew(output);
      await writeJson(join(newDir, "manifest.json"), { id: moduleConfig.id });
      await writeJson(join(newDir, "references.json"), { x: { citations: [], cited_by: [] } });
      await writeJson(join(newDir, "definitions.json"), {});
      const meta = await composeCorpusMeta({
        jurisdiction,
        module: moduleConfig,
        moduleDir: newDir,
        snapshotAt: "2026-04-30T13:00:00Z",
        skipped: [],
        corpusEntryKinds: ["section"],
        sourceSha256,
      });
      await writeCorpusMeta(newDir, meta);
      // Manually do rename1 only to simulate the crash window.
      await rename(output, `${output}.old`);
      // Now: <output>.old + <output>.new exist, no <output>. Run recover.
      await recover(output, lock);
      expect((await stat(output)).isDirectory()).toBe(true);
      expect(await isSentinelValid(output)).toBe(true);
      await expect(stat(`${output}.old`)).rejects.toThrow();
      await expect(stat(`${output}.new`)).rejects.toThrow();
    } finally {
      await releaseLock(lock);
    }
  });
});

describe("acquireLock — link race emulated via sequential acquire/release", () => {
  it("two acquire attempts in sequence both succeed (release frees the lock)", async () => {
    const output = await tmpOutput();
    const first = await acquireLock(output);
    await releaseLock(first);
    const second = await acquireLock(output);
    expect(second.token.uuid).not.toBe(first.token.uuid);
    await releaseLock(second);
  });

  it("loser of a link race sees EEXIST and fails fast", async () => {
    const output = await tmpOutput();
    await mkdir(join(output, ".."), { recursive: true });
    // Pre-create the lockfile via a temp file + link, simulating the winner.
    const tmpPath = `${output}.lock.tmp.preplant`;
    await writeFile(
      tmpPath,
      JSON.stringify({
        hostname: "winner",
        pid: 1,
        start_time_iso: new Date().toISOString(),
        uuid: "winner-uuid",
      }),
      "utf8",
    );
    await link(tmpPath, `${output}.lock`);
    await rm(tmpPath);
    await expect(acquireLock(output)).rejects.toMatchObject({
      exitCode: ExitCodes.LOCK_HELD,
    });
  });
});

describe("recover — fsync ordering after rename (fsync-after-rename, mandatory)", () => {
  it("calls dirHandle.sync() at least twice during the upgrade swap (rename1 + rename2)", async () => {
    const output = await tmpOutput();
    const lock = await acquireLock(output);
    try {
      // First install: produces the live <output>. Done before we instrument
      // so its writes don't pollute the call log.
      await makeValidNew(output);
      await promote(output, lock);

      // Build a second .new — this run will trigger the upgrade swap.
      const newDir = await ensureCleanNew(output);
      await writeJson(join(newDir, "manifest.json"), { id: moduleConfig.id });
      await writeJson(join(newDir, "references.json"), {
        upgraded: { citations: [], cited_by: [] },
      });
      await writeJson(join(newDir, "definitions.json"), {});
      const meta = await composeCorpusMeta({
        jurisdiction,
        module: moduleConfig,
        moduleDir: newDir,
        snapshotAt: "2026-04-30T13:00:00Z",
        skipped: [],
        corpusEntryKinds: ["section"],
        sourceSha256,
      });
      await writeCorpusMeta(newDir, meta);

      // NOW instrument: only the upgrade swap's directory syncs are counted.
      const dirSyncs: string[] = [];
      const realModule = await vi.importActual<typeof fsp>("node:fs/promises");
      const openMock = vi.mocked(fsp.open);
      openMock.mockImplementation(async (...args) => {
        const handle = await realModule.open(...(args as Parameters<typeof fsp.open>));
        if (args[1] === "r") {
          const realSync = handle.sync.bind(handle);
          handle.sync = async () => {
            dirSyncs.push(String(args[0]));
            await realSync();
          };
        }
        return handle;
      });

      try {
        await promote(output, lock);
      } finally {
        openMock.mockReset();
        openMock.mockImplementation(realModule.open);
      }

      // Upgrade path does:
      //   rename(live -> .old)  -> fsyncDir(parent)        [#1]
      //   rename(.new -> live)  -> fsyncDir(parent)        [#2]
      //   rm -rf .old           -> fsyncDir(parent)        [#3]
      // We assert >= 2 to allow for platforms that may collapse some syncs
      // (and to keep the test resilient to internal refactoring).
      expect(dirSyncs.length).toBeGreaterThanOrEqual(2);
    } finally {
      await releaseLock(lock);
    }
  });
});
