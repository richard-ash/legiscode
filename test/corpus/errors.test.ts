// Table test for errorsToExitCode. Every BuildError.kind must produce
// the right ExitCode; a new kind that lacks a mapping is a TypeScript
// compile error (exhaustiveness check in mapKindToExitCode), so this
// test is the runtime confirmation of the table.

import { describe, expect, it } from "vitest";
import { type BuildError, ExitCodes, errorsToExitCode } from "@/corpus";

const cases: ReadonlyArray<{ name: string; error: BuildError; expected: number }> = [
  {
    name: "manifest_invalid → PARSE",
    error: { kind: "manifest_invalid", path: "/x", issues: [], reason: "missing" },
    expected: ExitCodes.PARSE,
  },
  {
    name: "source_unreadable → PARSE",
    error: { kind: "source_unreadable", path: "/y", errno: "ENOENT" },
    expected: ExitCodes.PARSE,
  },
  {
    name: "parse_aborted → PARSE",
    error: { kind: "parse_aborted", moduleId: "sf-charter", reason: "bad anchor" },
    expected: ExitCodes.PARSE,
  },
  {
    name: "skip_gate_exceeded → PARSE",
    error: { kind: "skip_gate_exceeded", moduleId: "sf-charter", count: 5, max: 0 },
    expected: ExitCodes.PARSE,
  },
  {
    name: "toc_coverage_failed → PARSE",
    error: { kind: "toc_coverage_failed", moduleId: "sf-charter", missing: [] },
    expected: ExitCodes.PARSE,
  },
  {
    name: "citation_resolution_failed → PARSE",
    error: { kind: "citation_resolution_failed", unresolved: [] },
    expected: ExitCodes.PARSE,
  },
  {
    name: "atomic_write_failed → WRITE",
    error: { kind: "atomic_write_failed", moduleId: "sf-charter", errno: "ENOSPC" },
    expected: ExitCodes.WRITE,
  },
  {
    name: "atomic_write_lock_held → LOCK_HELD",
    error: { kind: "atomic_write_lock_held", moduleId: "sf-charter", reason: "held by pid 4321" },
    expected: ExitCodes.LOCK_HELD,
  },
  {
    name: "atomic_write_recovery_refused → RECOVERY_REFUSED",
    error: {
      kind: "atomic_write_recovery_refused",
      moduleId: "sf-charter",
      reason: "stale tempdir refused for review",
    },
    expected: ExitCodes.RECOVERY_REFUSED,
  },
  {
    name: "corpus_meta_write_failed → WRITE",
    error: { kind: "corpus_meta_write_failed", errno: "ENOSPC" },
    expected: ExitCodes.WRITE,
  },
];

describe("errorsToExitCode", () => {
  it("returns OK for an empty error list", () => {
    expect(errorsToExitCode([])).toBe(ExitCodes.OK);
  });

  for (const { name, error, expected } of cases) {
    it(name, () => {
      expect(errorsToExitCode([error])).toBe(expected);
    });
  }

  it("first error decides the code", () => {
    const errors: BuildError[] = [
      { kind: "atomic_write_failed", moduleId: "x", errno: "EIO" },
      { kind: "corpus_meta_write_failed", errno: "ENOSPC" },
    ];
    expect(errorsToExitCode(errors)).toBe(ExitCodes.WRITE);
  });
});
