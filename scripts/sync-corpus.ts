#!/usr/bin/env node
// Build-time CLI: convert a jurisdiction's source export (today: AmLegal
// HTML) into N typed, validated module bundles — one per code declared in
// the jurisdiction manifest.
//
// This file is genuinely thin. It owns argv parsing, --only validation
// against the manifest's modules[], source-path resolution + sandbox
// check (the security boundary stays here, not duplicated in @/corpus),
// output-formatting BuildErrors for the terminal, and exit-code
// propagation. All orchestration lives in `@/corpus.buildCorpus`.
// See docs/ARCHITECTURE.md.
//
// HTTP fetch is deliberately NOT in this CLI — it's feat/build-pipeline's
// problem. CI is hermetic and reads a committed HTML fixture.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type BuildError, type BuildResult, buildCorpus, type ExitCode, ExitCodes } from "@/corpus";
import type { JurisdictionManifest } from "@/types";
import { readJurisdictionManifest } from "@/types/validate";

const HELP_TEXT = `\
Usage: tsx scripts/sync-corpus.ts --source <jurisdiction-manifest> [options]

Required:
  --source <path>        Path to manifests/<jurisdiction>/jurisdiction.json.

Optional:
  --output <dir>         Base directory for module bundles (default: build/modules/).
                         Each module is built at <output>/<module-id>/.
  --only <module-id>     Build only the named module (must appear in modules[]).
                         Default: build every module declared in the manifest.
  --snapshot-at <iso>    Override snapshot_at timestamp (test determinism).
                         Applied to every module built in this invocation.
  --max-skips <N>        Override every module's max_skip_count for this run.
                         Default: each module's own max_skip_count (0 in v1).
  --help                 Show this help.
  --version              Show package version.

Exit codes:
  0  success
  2  argument error
  3  fetch error (reserved; this CLI does not fetch)
  4  parse error (manifest invalid, slicer abort, unrecognized anchor, drift, etc.)
  5  write error
  6  another build holds the lock
  7  recovery refused (corrupt sentinel — manual investigation required)
`;

interface Args {
  source: string;
  output: string;
  only: string | null;
  snapshotAt: string | null;
  maxSkipsOverride: number | null;
}

function parseArgs(argv: string[]): Args | { help: true } | { version: true } | { error: string } {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--version") return { version: true };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `flag ${flag} requires a value` };
    }
    switch (flag) {
      case "--source":
        args.source = value;
        break;
      case "--output":
        args.output = value;
        break;
      case "--only":
        args.only = value;
        break;
      case "--snapshot-at":
        args.snapshotAt = value;
        break;
      case "--max-skips": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return { error: `--max-skips requires a non-negative integer, got "${value}"` };
        }
        args.maxSkipsOverride = parsed;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!args.source) return { error: "missing required --source" };
  return {
    source: args.source,
    output: args.output ?? "build/modules/",
    only: args.only ?? null,
    snapshotAt: args.snapshotAt ?? null,
    maxSkipsOverride: args.maxSkipsOverride ?? null,
  };
}

function normalizeOutput(rawOutput: string): string {
  return rawOutput.replace(/\/+$/, "");
}

// Walk up from the manifest's directory to find the nearest package.json
// whose name is "legiscode". Falls back to `git rev-parse --show-toplevel`.
// We do not use process.cwd() because the CLI may be invoked from outside
// the repo with --source pointing at an absolute path inside it.
function deriveRepoRoot(manifestPath: string): string | { error: string } {
  let dir = dirname(resolve(manifestPath));
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "legiscode") return dir;
      } catch {
        // fall through to parent
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirname(resolve(manifestPath)),
      encoding: "utf8",
    }).trim();
    if (top.length > 0) return top;
  } catch {
    // fall through
  }
  return {
    error: `could not derive repo root from manifest path "${manifestPath}" (no package.json with name "legiscode" walking up, no git top-level)`,
  };
}

function resolveSourcePath(
  manifestPath: string,
  manifest: JurisdictionManifest,
): { sourcePath: string } | { error: string; exitCode: ExitCode } {
  const repoRoot = deriveRepoRoot(manifestPath);
  if (typeof repoRoot !== "string") {
    return { error: repoRoot.error, exitCode: ExitCodes.ARGS };
  }
  const sourcePath = manifest.source.path;
  if (isAbsolute(sourcePath)) {
    return {
      error: `manifest.source.path must be relative; got absolute path "${sourcePath}"`,
      exitCode: ExitCodes.PARSE,
    };
  }
  const resolved = resolve(repoRoot, sourcePath);
  let realResolved: string;
  let realRepoRoot: string;
  try {
    realResolved = realpathSync(resolved);
    realRepoRoot = realpathSync(repoRoot);
  } catch (err) {
    return {
      error: `could not resolve source.path "${sourcePath}": ${(err as Error).message}`,
      exitCode: ExitCodes.PARSE,
    };
  }
  if (!realResolved.startsWith(realRepoRoot + sep) && realResolved !== realRepoRoot) {
    return {
      error: `source.path "${sourcePath}" resolves outside the repo root (${realResolved} not under ${realRepoRoot})`,
      exitCode: ExitCodes.PARSE,
    };
  }
  return { sourcePath: realResolved };
}

interface PreflightOk {
  ok: true;
  manifest: JurisdictionManifest;
  sourcePath: string;
}
interface PreflightErr {
  ok: false;
  message: string;
  exitCode: ExitCode;
}

// Single manifest read powering both --only validation AND source.path
// resolution. Both checks happen at args time so a typo'd --only or a
// missing source file fails fast, before @/corpus does any work.
async function preflight(
  manifestPath: string,
  only: string | null,
): Promise<PreflightOk | PreflightErr> {
  let manifest: JurisdictionManifest;
  try {
    manifest = await readJurisdictionManifest(manifestPath);
  } catch (err) {
    return {
      ok: false,
      message: `jurisdiction manifest invalid: ${(err as Error).message}`,
      exitCode: ExitCodes.PARSE,
    };
  }
  if (only !== null && !manifest.modules.some((m) => m.id === only)) {
    return {
      ok: false,
      message: `--only "${only}" is not declared in modules[] of ${manifestPath}`,
      exitCode: ExitCodes.ARGS,
    };
  }
  const sourceResult = resolveSourcePath(manifestPath, manifest);
  if ("error" in sourceResult) {
    return { ok: false, message: sourceResult.error, exitCode: sourceResult.exitCode };
  }
  return { ok: true, manifest, sourcePath: sourceResult.sourcePath };
}

function formatBuildError(error: BuildError): string {
  switch (error.kind) {
    case "manifest_invalid":
      return `jurisdiction manifest invalid: ${error.reason ?? error.path}`;
    case "source_unreadable":
      return `failed to read source.path ${error.path}: ${error.errno}`;
    case "parse_aborted":
      return error.moduleId
        ? `module "${error.moduleId}": parse aborted: ${error.reason}`
        : `parse aborted: ${error.reason}`;
    case "skip_gate_exceeded":
      return `module "${error.moduleId}": parser skipped ${error.count} entries; max_skip_count is ${error.max}. Refusing to promote a corpus that silently drops content.`;
    case "toc_coverage_failed":
      return `module "${error.moduleId}": TOC coverage failed (${error.missing.length} missing sections)`;
    case "citation_resolution_failed":
      return `citation resolution failed (${error.unresolved.length} unresolved)`;
    case "duplicate_section_ids": {
      const sample = error.duplicates
        .slice(0, 5)
        .map((d) => `${d.id} (×${d.count})`)
        .join(", ");
      const tail =
        error.duplicates.length > 5 ? ` and ${error.duplicates.length - 5} more` : "";
      return `module "${error.moduleId}": duplicate section.ids detected — ${sample}${tail}. Refusing to ship a corpus with last-write-wins overwrites.`;
    }
    case "atomic_write_failed":
      return `module "${error.moduleId}": ${error.errno}`;
    case "atomic_write_lock_held":
      return `module "${error.moduleId}": atomic-write lock held by another builder: ${error.reason}`;
    case "atomic_write_recovery_refused":
      return `module "${error.moduleId}": atomic-write recovery refused: ${error.reason}`;
    case "corpus_meta_write_failed":
      return `corpus-meta.json write failed: ${error.errno}`;
    default: {
      // Exhaustiveness guard: a new BuildError variant added without a
      // case here becomes a compile-time error, matching the same
      // discipline `errorsToExitCode` enforces for exit codes.
      const _exhaustive: never = error;
      return `unknown error: ${JSON.stringify(error)}`;
    }
  }
}

async function run(argv: string[]): Promise<ExitCode> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(HELP_TEXT);
    return ExitCodes.OK;
  }
  if ("version" in parsed) {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    process.stdout.write(`legiscode-corpus-build/${pkg.version}\n`);
    return ExitCodes.OK;
  }
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n\n${HELP_TEXT}`);
    return ExitCodes.ARGS;
  }

  const args: Args = { ...parsed, output: normalizeOutput(parsed.output) };
  const manifestPath = resolve(args.source);

  const pre = await preflight(manifestPath, args.only);
  if (!pre.ok) {
    process.stderr.write(`${pre.message}\n`);
    return pre.exitCode;
  }

  const result: BuildResult = await buildCorpus({
    manifestPath,
    sourcePath: pre.sourcePath,
    outputDir: resolve(args.output),
    snapshotAt: args.snapshotAt ?? new Date().toISOString(),
    only: args.only ? [args.only] : undefined,
    maxSkips: args.maxSkipsOverride ?? undefined,
  });

  for (const err of result.errors) {
    process.stderr.write(`${formatBuildError(err)}\n`);
  }

  return result.exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("sync-corpus.ts") || process.argv[1].endsWith("sync-corpus.js"));

if (invokedDirectly) {
  void run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}

export { HELP_TEXT, parseArgs, run };
