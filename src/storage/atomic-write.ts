// Atomic-write primitive for the corpus build. The full state-machine
// diagram lives in the plan (see See: trailer below). This file's
// responsibility is the lockfile + the 3-step swap + startup recovery,
// each invariant under crash and concurrent access.
//
// LOCK PROTOCOL — write-then-link(2) + mtime staleness
//
//   acquireLock(output) writes a token JSON to <output>.lock.tmp.<uuid>,
//   fsyncs the file + parent dir, then link(2)s the .tmp onto <output>.lock.
//   POSIX guarantees only one caller's link succeeds; the linked file is
//   non-empty by construction, so there is no partial-lockfile crash window.
//
//   On EEXIST, examine the existing lockfile:
//     - malformed JSON: refuse + fail (corrupt lock; operator investigates)
//       UNLESS its mtime is older than GRACE_SECONDS, in which case we
//       treat it as orphaned and retry once.
//     - well-formed token, start_time_iso within MAX_BUILD_AGE: live builder
//       wins the race; we exit with LOCK_HELD.
//     - well-formed token, start_time_iso older than MAX_BUILD_AGE: stale
//       (the holder is gone; PID-alive checks are unsound under PID reuse,
//       so we don't probe). Unlink + retry once.
//
//   releaseLock checks the lockfile's uuid token matches ours before
//   unlinking; otherwise we no longer own it and silent deletion would
//   break the rightful holder.
//
// SWAP — 3 steps with parent-dir fsync after every rename/rm/unlink. The
// completion sentinel is corpus-meta.json with a checksum that re-validates
// against the other files; recover() never promotes <output>.new without it.
//
// RECOVERY — runs UNDER the lock, never outside. Phase A handles
// <output>.old first and is fatal-on-failure (closes the
// <output>+<output>.old+<output>.new reachable-state gap). Phase B handles
// <output>.new only after Phase A succeeds.

import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import type { CorpusMeta } from "@/types";
import { CorpusMetaSchema } from "@/types";
import { fsyncDir, writeJson } from "./canonical-json";

export const SENTINEL_FILENAME = "corpus-meta.json";
export const DEFAULT_MAX_BUILD_AGE_SECONDS = 7200;
export const DEFAULT_GRACE_SECONDS = 7200;

export const ExitCodes = {
  OK: 0,
  ARGS: 2,
  FETCH: 3,
  PARSE: 4,
  WRITE: 5,
  LOCK_HELD: 6,
  RECOVERY_REFUSED: 7,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

export class AtomicWriteError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AtomicWriteError";
  }
}

const LockTokenSchema = z
  .object({
    hostname: z.string().min(1),
    pid: z.number().int().nonnegative(),
    start_time_iso: z.iso.datetime({ offset: true }),
    uuid: z.string().min(1),
  })
  .strict();

export type LockToken = z.infer<typeof LockTokenSchema>;

export interface Lock {
  readonly output: string;
  readonly lockPath: string;
  readonly token: LockToken;
}

export interface AcquireLockOptions {
  /** Override staleness threshold (default 7200s = 2h). Tests use a small value. */
  maxBuildAgeSeconds?: number;
  /** Override corrupt-orphan grace window. */
  graceSeconds?: number;
  /** Override now() — tests inject. */
  now?: () => Date;
}

const lockPathFor = (output: string): string => `${output}.lock`;
const newDirFor = (output: string): string => `${output}.new`;
const oldDirFor = (output: string): string => `${output}.old`;
const tmpLockPathFor = (output: string, uuid: string): string => `${output}.lock.tmp.${uuid}`;

async function readLockFile(path: string): Promise<{ token: LockToken | null; mtime: Date }> {
  const [raw, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { token: null, mtime: st.mtime };
  }
  const result = LockTokenSchema.safeParse(parsed);
  return { token: result.success ? result.data : null, mtime: st.mtime };
}

async function writeLockTmp(tmpPath: string, token: LockToken): Promise<void> {
  await writeJson(tmpPath, token);
}

async function tryLink(src: string, dest: string): Promise<boolean> {
  try {
    await link(src, dest);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export async function acquireLock(output: string, options: AcquireLockOptions = {}): Promise<Lock> {
  const maxBuildAgeMs = (options.maxBuildAgeSeconds ?? DEFAULT_MAX_BUILD_AGE_SECONDS) * 1000;
  const graceMs = (options.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000;
  const now = options.now ?? (() => new Date());

  await mkdir(dirname(output), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    const token: LockToken = {
      hostname: hostname(),
      pid: process.pid,
      start_time_iso: now().toISOString(),
      uuid: randomUUID(),
    };
    const lockPath = lockPathFor(output);
    const tmpPath = tmpLockPathFor(output, token.uuid);
    await writeLockTmp(tmpPath, token);

    const linked = await tryLink(tmpPath, lockPath);
    // Always clean up our own .tmp file regardless of outcome.
    await unlink(tmpPath).catch(() => {});

    if (linked) {
      return { output, lockPath, token };
    }

    // EEXIST — examine the existing lock.
    const { token: existing, mtime } = await readLockFile(lockPath).catch(() => ({
      token: null as LockToken | null,
      mtime: new Date(0),
    }));

    if (existing === null) {
      // Corrupt or unparseable. If recently modified, fail loudly — operator
      // investigates. Only treat as orphan if it has aged past the grace window.
      const ageMs = now().getTime() - mtime.getTime();
      if (ageMs <= graceMs) {
        throw new AtomicWriteError(
          ExitCodes.RECOVERY_REFUSED,
          `lockfile ${lockPath} is corrupt and recently modified (mtime ${mtime.toISOString()}); manual investigation required`,
        );
      }
      await unlink(lockPath).catch(() => {});
      continue;
    }

    const tokenAgeMs = now().getTime() - new Date(existing.start_time_iso).getTime();
    if (tokenAgeMs <= maxBuildAgeMs) {
      throw new AtomicWriteError(
        ExitCodes.LOCK_HELD,
        `lockfile ${lockPath} held by ${existing.hostname}/pid=${existing.pid} since ${existing.start_time_iso}`,
      );
    }

    // Stale: token's start_time is older than MAX_BUILD_AGE. Unlink + retry once.
    await unlink(lockPath).catch(() => {});
  }

  throw new AtomicWriteError(
    ExitCodes.LOCK_HELD,
    `lockfile ${lockPathFor(output)} contention persisted after stale-lock retry`,
  );
}

export async function releaseLock(lock: Lock): Promise<void> {
  const current = await readLockFile(lock.lockPath).catch(() => null);
  if (!current?.token || current.token.uuid !== lock.token.uuid) {
    // We no longer own this lockfile; deleting it would break the rightful
    // holder. Silent return is the right behavior on release.
    return;
  }
  await unlink(lock.lockPath).catch(() => {});
  await fsyncDir(dirname(lock.lockPath));
}

async function pathExists(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

export async function computeChecksum(moduleDir: string): Promise<string> {
  const files = await listFilesRecursive(moduleDir);
  const relPaths = files
    .map((f) => relative(moduleDir, f).split(sep).join("/"))
    .filter((p) => p !== SENTINEL_FILENAME)
    .sort();

  const hash = createHash("sha256");
  for (const rel of relPaths) {
    hash.update(rel);
    hash.update("\n");
    hash.update(await readFile(join(moduleDir, rel)));
  }
  return hash.digest("hex");
}

async function readSentinel(moduleDir: string): Promise<CorpusMeta | null> {
  const path = join(moduleDir, SENTINEL_FILENAME);
  if ((await pathExists(path)) === null) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = CorpusMetaSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export async function isSentinelValid(moduleDir: string): Promise<boolean> {
  const meta = await readSentinel(moduleDir);
  if (!meta) return false;
  const computed = await computeChecksum(moduleDir);
  return computed === meta.checksum;
}

async function rmRf(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function renameAndFsync(src: string, dest: string): Promise<void> {
  await rename(src, dest);
  await fsyncDir(dirname(dest));
  if (dirname(src) !== dirname(dest)) {
    await fsyncDir(dirname(src));
  }
}

// Phase A: handle <output>.old first. Fatal on cleanup failure — never
// silent. Closes the <output>+<output>.old+<output>.new state gap.
async function recoverPhaseA(output: string, _lock: Lock): Promise<void> {
  const oldPath = oldDirFor(output);
  const livePath = output;
  const oldExists = await pathExists(oldPath);
  if (!oldExists) return;
  const liveExists = await pathExists(livePath);

  if (liveExists) {
    // Leftover .old next to a live output. Remove .old.
    try {
      await rmRf(oldPath);
      await fsyncDir(dirname(output));
    } catch (cause) {
      throw new AtomicWriteError(
        ExitCodes.RECOVERY_REFUSED,
        `cannot remove leftover ${oldPath}; manual investigation required`,
        { cause },
      );
    }
    return;
  }

  // .old alone — rollback to live.
  await renameAndFsync(oldPath, livePath);
}

// Phase B: handle <output>.new. Only runs after Phase A succeeds.
async function recoverPhaseB(output: string, _lock: Lock): Promise<void> {
  const newPath = newDirFor(output);
  const livePath = output;
  const newExists = await pathExists(newPath);
  if (!newExists) return;

  const valid = await isSentinelValid(newPath);
  if (!valid) {
    await rmRf(newPath);
    await fsyncDir(dirname(output));
    return;
  }

  const liveExists = await pathExists(livePath);
  if (!liveExists) {
    // First install — promote .new to live.
    await renameAndFsync(newPath, livePath);
    return;
  }

  // <output> + valid <output>.new (Phase A guarantees no .old here).
  // Resume the swap: rename live -> .old, rename .new -> live, rm -rf .old.
  await renameAndFsync(livePath, oldDirFor(output));
  await renameAndFsync(newPath, livePath);
  await rmRf(oldDirFor(output));
  await fsyncDir(dirname(output));
}

export async function recover(output: string, lock: Lock): Promise<void> {
  await recoverPhaseA(output, lock);
  await recoverPhaseB(output, lock);
}

export async function promote(output: string, _lock: Lock): Promise<void> {
  const newPath = newDirFor(output);
  const newExists = await pathExists(newPath);
  if (!newExists) {
    throw new AtomicWriteError(ExitCodes.WRITE, `promote() called but ${newPath} does not exist`);
  }
  const valid = await isSentinelValid(newPath);
  if (!valid) {
    await rmRf(newPath);
    await fsyncDir(dirname(output));
    throw new AtomicWriteError(
      ExitCodes.RECOVERY_REFUSED,
      `${newPath} sentinel/checksum invalid; refusing to promote`,
    );
  }

  const liveExists = await pathExists(output);
  if (liveExists) {
    await renameAndFsync(output, oldDirFor(output));
  }
  await renameAndFsync(newPath, output);
  if (liveExists) {
    await rmRf(oldDirFor(output));
    await fsyncDir(dirname(output));
  }
}

export async function ensureCleanNew(output: string): Promise<string> {
  const newPath = newDirFor(output);
  await rmRf(newPath);
  await mkdir(newPath, { recursive: true });
  await fsyncDir(dirname(newPath));
  return newPath;
}
