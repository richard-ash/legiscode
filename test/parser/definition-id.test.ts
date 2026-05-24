import { describe, expect, it } from "vitest";
import { buildDefinitionId, canonicalizeTerm, sha8 } from "@/parser/definition-id";
import { DefinitionIdSchema } from "@/types";

describe("canonicalizeTerm", () => {
  it("trims leading and trailing whitespace", () => {
    expect(canonicalizeTerm("  Director  ")).toBe("Director");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(canonicalizeTerm("Director  of   Transportation")).toBe("Director of Transportation");
  });

  it("normalizes tabs and newlines to single spaces", () => {
    expect(canonicalizeTerm("Director\tof\nTransportation")).toBe("Director of Transportation");
  });

  it("preserves case (legal drafting is case-sensitive)", () => {
    expect(canonicalizeTerm("DEPARTMENT")).toBe("DEPARTMENT");
    expect(canonicalizeTerm("Department")).toBe("Department");
  });
});

describe("sha8", () => {
  it("returns 8 lowercase hex chars", () => {
    expect(sha8("Apartment")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic for the same input", () => {
    expect(sha8("Apartment")).toBe(sha8("Apartment"));
  });

  it("differs for different inputs", () => {
    expect(sha8("Apartment")).not.toBe(sha8("Tenant"));
  });
});

describe("buildDefinitionId", () => {
  it("composes <module>/<section>#<sha8(canonical_term)>", () => {
    const id = buildDefinitionId("sf-housing", "h401", "Apartment");
    expect(id).toMatch(/^sf-housing\/h401#[0-9a-f]{8}$/);
  });

  it("output round-trips through DefinitionIdSchema", () => {
    const id = buildDefinitionId("sf-housing", "h401", "Apartment");
    expect(DefinitionIdSchema.parse(id)).toBe(id);
  });

  it("is stable across calls with the same arguments", () => {
    expect(buildDefinitionId("sf-housing", "h401", "Apartment")).toBe(
      buildDefinitionId("sf-housing", "h401", "Apartment"),
    );
  });

  it("differs when the term differs (id is term-derived, not position-derived)", () => {
    expect(buildDefinitionId("sf-housing", "h401", "Apartment")).not.toBe(
      buildDefinitionId("sf-housing", "h401", "Tenant"),
    );
  });

  it("canonicalizes the term before hashing", () => {
    expect(buildDefinitionId("sf-housing", "h401", "  Director  ")).toBe(
      buildDefinitionId("sf-housing", "h401", "Director"),
    );
    expect(buildDefinitionId("sf-housing", "h401", "Director  of  Transportation")).toBe(
      buildDefinitionId("sf-housing", "h401", "Director of Transportation"),
    );
  });

  it("produces different ids across modules even when section + term match", () => {
    expect(buildDefinitionId("sf-housing", "h401", "Director")).not.toBe(
      buildDefinitionId("sf-port", "h401", "Director"),
    );
  });
});
