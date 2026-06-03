// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { useCommandPalette } from "../../../src/ui/command-palette/use-command-palette";

const corpus: CorpusModuleSummary = {
  jurisdiction: "City and County of San Francisco",
  rootLabel: "San Francisco Municipal Code",
  jurisdictionVersion: "2026.05.01",
  codeCount: 1,
  sectionCount: 3,
  defaultRef: { moduleId: "sf-port", sectionId: "1.1" },
  tree: [
    {
      id: "sf-port",
      code: "Port Code",
      name: "San Francisco Port Code",
      kind: "code",
      kids: [
        {
          id: "sf-port::ART1",
          code: "ARTICLE 1",
          name: "",
          kind: "chapter",
          kids: [
            {
              id: "sf-port::1.1",
              code: "§ 1.1",
              name: "Definitions",
              kind: "section",
              ref: { moduleId: "sf-port", sectionId: "1.1" },
            },
            {
              id: "sf-port::133",
              code: "§ 133",
              name: "Side Yards",
              kind: "section",
              ref: { moduleId: "sf-port", sectionId: "133" },
            },
            {
              id: "sf-port::1.33",
              code: "§ 1.33",
              name: "Subpart",
              kind: "section",
              ref: { moduleId: "sf-port", sectionId: "1.33" },
            },
          ],
        },
      ],
    },
  ],
  definitions: [
    { term: "Director", moduleId: "sf-port", definers: ["1.1"] },
    { term: "Director", moduleId: "sf-administrative", definers: ["1.1"] },
    { term: "Commissioner", moduleId: "sf-port", definers: ["1.1"] },
  ],
  sessionBills: { count: 0, bills: [], classBMeta: [] },
};

describe("useCommandPalette — initial state", () => {
  it("initial state: closed, q empty, mode default, results = all sections", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    expect(result.current.open).toBe(false);
    expect(result.current.q).toBe("");
    expect(result.current.mode).toBe("section");
    // Empty q in section mode → 3 sections (defined-terms are scoped
    // to `:def ` mode by the kind filter).
    expect(result.current.results.length).toBe(3);
    expect(result.current.results.every((r) => r.kind === "section")).toBe(true);
    expect(result.current.isStale).toBe(false);
  });
  it("renders empty results when corpus is null (boot)", () => {
    const { result } = renderHook(() => useCommandPalette(null));
    expect(result.current.results).toEqual([]);
    expect(result.current.open).toBe(false);
  });
});

describe("useCommandPalette — toggle + close + q persistence (U3)", () => {
  it("toggle flips open", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.open).toBe(false);
  });
  it("close() flips open to false but preserves q (U3)", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.toggle());
    act(() => result.current.setQ("speed"));
    expect(result.current.q).toBe("speed");
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.q).toBe("speed");
    // Re-opening preserves the search.
    act(() => result.current.toggle());
    expect(result.current.q).toBe("speed");
  });
  it("close() when already closed is a no-op", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });
});

describe("useCommandPalette — mode detection (Codex F9 + C3)", () => {
  it("plain text keeps mode 'section'", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.setQ("Director"));
    expect(result.current.mode).toBe("section");
    // Director appears in section names too — section-mode search picks
    // up both sections AND nothing from defined-term (mode filter).
    expect(result.current.results.every((r) => r.kind === "section")).toBe(true);
  });
  it("':def ' (trailing space) triggers defined-term mode and strips the prefix", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.setQ(":def Director"));
    expect(result.current.mode).toBe("defined-term");
    expect(result.current.results.every((r) => r.kind === "defined-term")).toBe(true);
    // Two rows for "Director" across modules (D5 — never collapse).
    expect(result.current.results).toHaveLength(2);
  });
  it("':de' alone does NOT trigger mode (incomplete prefix)", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.setQ(":de"));
    expect(result.current.mode).toBe("section");
    // Treated as a literal substring search.
  });
  it("':def' without trailing space does NOT trigger mode (Codex F9)", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.setQ(":def"));
    expect(result.current.mode).toBe("section");
  });
  it("Deleting past the ':def ' prefix reverts mode to default", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.setQ(":def Director"));
    expect(result.current.mode).toBe("defined-term");
    act(() => result.current.setQ(""));
    expect(result.current.mode).toBe("section");
  });
});

describe("useCommandPalette — searchableItems memoization (C3)", () => {
  it("results recompute when q changes but corpus doesn't", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.setQ("133"));
    expect(
      result.current.results[0]?.kind === "section" ? result.current.results[0].num : null,
    ).toBe("§ 133");
    act(() => result.current.setQ("Definitions"));
    expect(
      result.current.results[0]?.kind === "section" ? result.current.results[0].name : null,
    ).toBe("Definitions");
  });
  it("U1 headline: typing '133' ranks § 133 above § 1.33", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.setQ("133"));
    const sections = result.current.results.filter((r) => r.kind === "section");
    expect(sections[0]?.kind === "section" ? sections[0].num : null).toBe("§ 133");
  });
});

describe("useCommandPalette — empty-state cap", () => {
  it("caps empty-q results at EMPTY_STATE_CAP (15) when corpus is large", () => {
    // Synthesize a corpus with 20 sections so the cap actually fires.
    // The 3-section fixture in this file is under the cap; this guards
    // the cap behavior independently.
    const big: CorpusModuleSummary = {
      ...corpus,
      sectionCount: 20,
      tree: [
        {
          id: "sf-port",
          code: "Port Code",
          name: "San Francisco Port Code",
          kind: "code",
          kids: Array.from({ length: 20 }, (_, i) => ({
            id: `sf-port::s${i}`,
            code: `§ ${i + 1}`,
            name: `Section ${i + 1}`,
            kind: "section" as const,
            ref: { moduleId: "sf-port", sectionId: `s${i}` },
          })),
        },
      ],
    };
    const { result } = renderHook(() => useCommandPalette(big));
    expect(result.current.results).toHaveLength(15);
  });
  it("releases the cap as soon as a token is typed", () => {
    const big: CorpusModuleSummary = {
      ...corpus,
      sectionCount: 20,
      tree: [
        {
          id: "sf-port",
          code: "Port Code",
          name: "San Francisco Port Code",
          kind: "code",
          kids: Array.from({ length: 20 }, (_, i) => ({
            id: `sf-port::s${i}`,
            code: `§ ${i + 1}`,
            name: `Section ${i + 1}`,
            kind: "section" as const,
            ref: { moduleId: "sf-port", sectionId: `s${i}` },
          })),
        },
      ],
    };
    const { result } = renderHook(() => useCommandPalette(big));
    expect(result.current.results).toHaveLength(15);
    // Typing "Section" matches every row by name prefix — cap releases,
    // all 20 surface.
    act(() => result.current.setQ("Section"));
    expect(result.current.results).toHaveLength(20);
  });
});

describe("useCommandPalette — isStale", () => {
  it("isStale is false when q is empty", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    expect(result.current.isStale).toBe(false);
  });
  it("isStale is false after the deferred value catches up (sync today)", () => {
    const { result } = renderHook(() => useCommandPalette(corpus));
    act(() => result.current.setQ("Director"));
    // useDeferredValue is synchronous in this test environment — by
    // the time we sample, q === deferredQ. Forward-compat field.
    expect(result.current.isStale).toBe(false);
  });
});
