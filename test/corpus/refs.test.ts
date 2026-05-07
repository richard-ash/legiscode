import { describe, expect, it } from "vitest";
import {
  CorpusRefParseError,
  type CorpusRef,
  corpusRefFromWire,
  corpusRefToWire,
  equals,
  hash,
  parse,
  serialize,
} from "@/corpus/refs";

describe("CorpusRef.parse", () => {
  it("accepts a valid object input", () => {
    const ref = parse({ module: "sf-port", section: "1.1" });
    expect(ref.module).toBe("sf-port");
    expect(ref.section).toBe("1.1");
  });

  it("accepts a serialized string and round-trips with serialize", () => {
    const original = parse({ module: "sf-port", section: "1.1" });
    const round = parse(serialize(original));
    expect(equals(round, original)).toBe(true);
  });

  it("preserves dotted/dashed/underscored section ids per SECTION_ID_RE", () => {
    expect(parse({ module: "sf-port", section: "title-10_chapter-04" }).section).toBe(
      "title-10_chapter-04",
    );
    expect(parse({ module: "sf-port", section: "1.04.020" }).section).toBe("1.04.020");
  });

  it("rejects invalid module ids", () => {
    expect(() => parse({ module: "SF-Port", section: "1.1" })).toThrow(CorpusRefParseError);
    expect(() => parse({ module: "1-bad", section: "1.1" })).toThrow(CorpusRefParseError);
    expect(() => parse({ module: "", section: "1.1" })).toThrow(CorpusRefParseError);
  });

  it("rejects invalid section ids", () => {
    expect(() => parse({ module: "sf-port", section: "BAD" })).toThrow(CorpusRefParseError);
    expect(() => parse({ module: "sf-port", section: "1..1" })).toThrow(CorpusRefParseError);
    expect(() => parse({ module: "sf-port", section: "" })).toThrow(CorpusRefParseError);
  });

  it("rejects serialized strings missing the :: separator", () => {
    expect(() => parse("sf-port-1.1")).toThrow(CorpusRefParseError);
  });
});

describe("CorpusRef.serialize", () => {
  it("uses :: as the separator", () => {
    expect(serialize(parse({ module: "sf-port", section: "1.1" }))).toBe("sf-port::1.1");
  });
});

describe("CorpusRef.equals", () => {
  const a = parse({ module: "sf-port", section: "1.1" });
  const b = parse({ module: "sf-port", section: "1.1" });
  const c = parse({ module: "sf-fire", section: "1.1" });

  it("is reflexive", () => {
    expect(equals(a, a)).toBe(true);
  });

  it("is symmetric", () => {
    expect(equals(a, b)).toBe(true);
    expect(equals(b, a)).toBe(true);
  });

  it("is transitive", () => {
    const a2 = parse({ module: "sf-port", section: "1.1" });
    expect(equals(a, b) && equals(b, a2)).toBe(true);
    expect(equals(a, a2)).toBe(true);
  });

  it("distinguishes refs that differ in module or section", () => {
    expect(equals(a, c)).toBe(false);
    expect(equals(a, parse({ module: "sf-port", section: "1.2" }))).toBe(false);
  });
});

describe("CorpusRef.hash", () => {
  it("produces distinct strings for distinct refs", () => {
    const r1 = parse({ module: "sf-port", section: "1.1" });
    const r2 = parse({ module: "sf-port", section: "1.2" });
    const r3 = parse({ module: "sf-fire", section: "1.1" });
    const set = new Set([hash(r1), hash(r2), hash(r3)]);
    expect(set.size).toBe(3);
  });

  it("produces identical strings for equal refs", () => {
    expect(hash(parse({ module: "sf-port", section: "1.1" }))).toBe(
      hash(parse({ module: "sf-port", section: "1.1" })),
    );
  });
});

describe("CorpusRef wire helpers", () => {
  it("corpusRefFromWire converts the IPC payload shape to CorpusRef", () => {
    const ref = corpusRefFromWire({ moduleId: "sf-port", sectionId: "1.1" });
    expect(ref.module).toBe("sf-port");
    expect(ref.section).toBe("1.1");
  });

  it("corpusRefToWire is the inverse", () => {
    const ref = parse({ module: "sf-port", section: "1.1" });
    expect(corpusRefToWire(ref)).toEqual({ moduleId: "sf-port", sectionId: "1.1" });
  });
});

describe("CorpusRef opaque tag (compile-time)", () => {
  it("rejects an unbranded literal at the type level", () => {
    // The opaque brand makes the next line a type error if uncommented; the
    // ts-expect-error directive here is the gate — if a future refactor
    // accidentally widens CorpusRef to a plain `{ module, section }` shape
    // the directive becomes unused and the test fails to compile.
    // @ts-expect-error CorpusRef requires the opaque brand from parse()
    const _bad: CorpusRef = { module: "sf-port", section: "1.1" };
    void _bad;
    expect(true).toBe(true);
  });

  it("accepts a parse() output", () => {
    const ok: CorpusRef = parse({ module: "sf-port", section: "1.1" });
    expect(ok.module).toBe("sf-port");
  });
});
