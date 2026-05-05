import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseArgs } from "../../scripts/sync-corpus";

describe("parseArgs", () => {
  it("returns help on --help", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });

  it("returns version on --version", () => {
    expect(parseArgs(["--version"])).toEqual({ version: true });
  });

  it("rejects missing --source", () => {
    const result = parseArgs([]);
    expect("error" in result && result.error).toContain("--source");
  });

  it("rejects unknown flag", () => {
    const result = parseArgs(["--source", "y", "--bogus", "z"]);
    expect("error" in result && result.error).toContain("--bogus");
  });

  it("rejects flag with no value", () => {
    const result = parseArgs(["--source"]);
    expect("error" in result && result.error).toContain("requires a value");
  });

  it("parses --source with default --output", () => {
    const result = parseArgs(["--source", "test/fixtures/sf/jurisdiction.json"]);
    expect("output" in result && result.output).toBe("build/modules/");
    expect("only" in result && result.only).toBeNull();
  });

  it("parses --only as a string filter", () => {
    const result = parseArgs([
      "--source",
      "test/fixtures/sf/jurisdiction.json",
      "--only",
      "sf-transportation",
    ]);
    expect("only" in result && result.only).toBe("sf-transportation");
  });

  it("HELP_TEXT documents exit codes", () => {
    expect(HELP_TEXT).toContain("Exit codes:");
    expect(HELP_TEXT).toContain("6  another build holds the lock");
  });

  it("HELP_TEXT documents the new --source / --only flags", () => {
    expect(HELP_TEXT).toContain("--source");
    expect(HELP_TEXT).toContain("--only");
    expect(HELP_TEXT).toContain("jurisdiction.json");
  });

  it("parses --max-skips as a non-negative integer override", () => {
    const result = parseArgs([
      "--source",
      "test/fixtures/sf/jurisdiction.json",
      "--max-skips",
      "5",
    ]);
    expect("maxSkipsOverride" in result && result.maxSkipsOverride).toBe(5);
  });

  it("defaults --max-skips override to null when flag absent", () => {
    const result = parseArgs(["--source", "test/fixtures/sf/jurisdiction.json"]);
    expect("maxSkipsOverride" in result && result.maxSkipsOverride).toBeNull();
  });

  it("rejects negative --max-skips", () => {
    const result = parseArgs([
      "--source",
      "test/fixtures/sf/jurisdiction.json",
      "--max-skips",
      "-1",
    ]);
    expect("error" in result && result.error).toContain("non-negative");
  });

  it("rejects non-integer --max-skips", () => {
    const result = parseArgs([
      "--source",
      "test/fixtures/sf/jurisdiction.json",
      "--max-skips",
      "abc",
    ]);
    expect("error" in result && result.error).toContain("non-negative");
  });

  it("HELP_TEXT documents --max-skips", () => {
    expect(HELP_TEXT).toContain("--max-skips");
  });
});
