import { describe, expect, it } from "vitest";
import {
  DEFINITION_ID_RE,
  DefinitionIdSchema,
  DefinitionSchema,
  ModuleDefinitionsSchema,
  formatDefinitionId,
  type Definition,
} from "@/types";

const validDefinition: Definition = {
  id: "sf-housing/h401#a1b2c3d4",
  term: "Apartment",
  defined_in: "h401",
  body_anchor: { start: 0, end: 9 },
  excerpt: "'Apartment' means a dwelling unit…",
  scope: { kind: "hierarchy", prefix: ["Housing Code"] },
  extracted_by: "amlegal:pattern:shall-mean",
};

describe("DefinitionIdSchema", () => {
  it("matches <module>/<section>#<sha8>", () => {
    expect(DefinitionIdSchema.parse("sf-housing/h401#a1b2c3d4")).toBe("sf-housing/h401#a1b2c3d4");
    expect(DefinitionIdSchema.parse("sf-charter/c-101#deadbeef")).toBe("sf-charter/c-101#deadbeef");
  });

  it("accepts section ids that include dots, dashes, and underscores", () => {
    expect(DefinitionIdSchema.parse("sf-municipal/10.04.020#0123abcd")).toBe(
      "sf-municipal/10.04.020#0123abcd",
    );
    expect(DefinitionIdSchema.parse("sf-park/title-10_chapter-04#ffffffff")).toBe(
      "sf-park/title-10_chapter-04#ffffffff",
    );
  });

  it("rejects a sha that is too short", () => {
    expect(DefinitionIdSchema.safeParse("sf-housing/h401#a1b2c3").success).toBe(false);
  });

  it("rejects a sha that is too long", () => {
    expect(DefinitionIdSchema.safeParse("sf-housing/h401#a1b2c3d4ef").success).toBe(false);
  });

  it("rejects non-hex characters in the sha", () => {
    expect(DefinitionIdSchema.safeParse("sf-housing/h401#a1b2c3dG").success).toBe(false);
  });

  it("rejects uppercase hex in the sha", () => {
    expect(DefinitionIdSchema.safeParse("sf-housing/h401#A1B2C3D4").success).toBe(false);
  });

  it("rejects a missing module segment", () => {
    expect(DefinitionIdSchema.safeParse("/h401#a1b2c3d4").success).toBe(false);
  });

  it("rejects a missing section segment", () => {
    expect(DefinitionIdSchema.safeParse("sf-housing/#a1b2c3d4").success).toBe(false);
  });

  it("rejects a missing # separator", () => {
    expect(DefinitionIdSchema.safeParse("sf-housing/h401a1b2c3d4").success).toBe(false);
  });

  it("DEFINITION_ID_RE matches the schema regex", () => {
    expect(DEFINITION_ID_RE.test("sf-housing/h401#a1b2c3d4")).toBe(true);
    expect(DEFINITION_ID_RE.test("bad")).toBe(false);
  });

  // Load-bearing for section-view's defined_term render path: the renderer
  // reads `ctx.definitions[def_id]` as a naked object lookup, which is safe
  // ONLY because no valid DefinitionId can collide with an Object.prototype
  // key. The `<module>/<section>#<sha8>` shape contains `/` and `#`, which
  // appear in none of the prototype property names. If this regex is ever
  // widened to allow keys lacking those separators, the renderer becomes
  // vulnerable to prototype-chain reads and must restore its Object.hasOwn
  // guard. Pin the invariant here so the regression turns red.
  it.each([
    "__proto__",
    "toString",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
  ])("rejects %s (Object.prototype-key safety)", (key) => {
    expect(DEFINITION_ID_RE.test(key)).toBe(false);
  });

  // Exhaustiveness backstop: any Object.prototype key V8 adds in the
  // future (or that an older Node runtime exposes) must also be rejected.
  // Pairs with the explicit list above — the list names the canonical
  // danger surface for human readers; this guard catches additions.
  it("rejects every Object.prototype own-property name", () => {
    for (const key of Object.getOwnPropertyNames(Object.prototype)) {
      expect(DEFINITION_ID_RE.test(key)).toBe(false);
    }
  });
});

describe("formatDefinitionId", () => {
  it("composes <module>/<section>#<sha8>", () => {
    expect(formatDefinitionId("sf-housing", "h401", "a1b2c3d4")).toBe("sf-housing/h401#a1b2c3d4");
  });

  it("output round-trips through DefinitionIdSchema for canonical inputs", () => {
    const id = formatDefinitionId("sf-housing", "h401", "a1b2c3d4");
    expect(DefinitionIdSchema.parse(id)).toBe(id);
  });
});

describe("DefinitionSchema", () => {
  it("accepts a valid Definition", () => {
    expect(DefinitionSchema.parse(validDefinition).id).toBe("sf-housing/h401#a1b2c3d4");
  });

  it("rejects extra fields under strict()", () => {
    const result = DefinitionSchema.safeParse({ ...validDefinition, extra: "no" });
    expect(result.success).toBe(false);
  });

  it("rejects missing id", () => {
    const { id: _omit, ...incomplete } = validDefinition;
    expect(DefinitionSchema.safeParse(incomplete).success).toBe(false);
  });

  it("rejects missing term", () => {
    const { term: _omit, ...incomplete } = validDefinition;
    expect(DefinitionSchema.safeParse(incomplete).success).toBe(false);
  });

  it("rejects missing defined_in", () => {
    const { defined_in: _omit, ...incomplete } = validDefinition;
    expect(DefinitionSchema.safeParse(incomplete).success).toBe(false);
  });

  it("rejects an invalid id format", () => {
    expect(DefinitionSchema.safeParse({ ...validDefinition, id: "not-an-id" }).success).toBe(false);
  });

  it("rejects a defined_in section id that doesn't match SectionIdSchema", () => {
    expect(
      DefinitionSchema.safeParse({ ...validDefinition, defined_in: "INVALID ID" }).success,
    ).toBe(false);
  });

  describe("body_anchor", () => {
    it("accepts start === end (degenerate zero-width anchor)", () => {
      const result = DefinitionSchema.safeParse({
        ...validDefinition,
        body_anchor: { start: 5, end: 5 },
      });
      expect(result.success).toBe(true);
    });

    it("rejects start > end", () => {
      const result = DefinitionSchema.safeParse({
        ...validDefinition,
        body_anchor: { start: 10, end: 5 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative start", () => {
      const result = DefinitionSchema.safeParse({
        ...validDefinition,
        body_anchor: { start: -1, end: 5 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative end", () => {
      const result = DefinitionSchema.safeParse({
        ...validDefinition,
        body_anchor: { start: 0, end: -1 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer start/end", () => {
      const result = DefinitionSchema.safeParse({
        ...validDefinition,
        body_anchor: { start: 0.5, end: 5 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects extra fields under strict()", () => {
      const result = DefinitionSchema.safeParse({
        ...validDefinition,
        body_anchor: { start: 0, end: 5, extra: "no" },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("scope", () => {
    it("accepts hierarchy scope", () => {
      expect(
        DefinitionSchema.parse({
          ...validDefinition,
          scope: { kind: "hierarchy", prefix: ["Housing Code", "Chapter 4"] },
        }).scope.kind,
      ).toBe("hierarchy");
    });

    it("accepts module scope", () => {
      expect(
        DefinitionSchema.parse({ ...validDefinition, scope: { kind: "module" } }).scope.kind,
      ).toBe("module");
    });

    it("accepts cross_module scope", () => {
      expect(
        DefinitionSchema.parse({
          ...validDefinition,
          scope: { kind: "cross_module", module_id: "sf-charter" },
        }).scope.kind,
      ).toBe("cross_module");
    });

    it("rejects an unknown scope kind", () => {
      expect(
        DefinitionSchema.safeParse({
          ...validDefinition,
          scope: { kind: "global" },
        }).success,
      ).toBe(false);
    });
  });

  describe("extracted_by", () => {
    it("accepts three-token form (amlegal:pattern:shall-mean)", () => {
      const result = DefinitionSchema.safeParse({
        ...validDefinition,
        extracted_by: "amlegal:pattern:curly-quoted-means",
      });
      expect(result.success).toBe(true);
    });

    it("accepts two-token form (manifest:declared-global)", () => {
      const result = DefinitionSchema.safeParse({
        ...validDefinition,
        extracted_by: "manifest:declared-global",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a single token (no colons)", () => {
      expect(
        DefinitionSchema.safeParse({ ...validDefinition, extracted_by: "amlegal" }).success,
      ).toBe(false);
    });

    it("rejects an empty extracted_by", () => {
      expect(DefinitionSchema.safeParse({ ...validDefinition, extracted_by: "" }).success).toBe(
        false,
      );
    });

    it("rejects uppercase characters in extracted_by tokens", () => {
      expect(
        DefinitionSchema.safeParse({
          ...validDefinition,
          extracted_by: "AmLegal:pattern:shall-mean",
        }).success,
      ).toBe(false);
    });
  });

  describe("excerpt", () => {
    it("rejects an empty excerpt", () => {
      expect(DefinitionSchema.safeParse({ ...validDefinition, excerpt: "" }).success).toBe(false);
    });
  });
});

describe("ModuleDefinitionsSchema", () => {
  it("accepts an empty array", () => {
    expect(ModuleDefinitionsSchema.parse([])).toEqual([]);
  });

  it("accepts multiple distinct Definitions", () => {
    const a = validDefinition;
    const b: Definition = {
      ...validDefinition,
      id: "sf-housing/h402#deadbeef",
      defined_in: "h402",
    };
    expect(ModuleDefinitionsSchema.parse([a, b])).toHaveLength(2);
  });

  it("rejects duplicate Definition ids within a module", () => {
    const a = validDefinition;
    const b: Definition = { ...validDefinition, term: "Tenant" };
    const result = ModuleDefinitionsSchema.safeParse([a, b]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/duplicate Definition\.id/);
    }
  });
});
