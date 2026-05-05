import { describe, expect, it } from "vitest";
import { KNOWN_SCHEMA_VERSION } from "@/types";

describe("baseline", () => {
  it("vitest runs", () => {
    expect(1 + 1).toBe(2);
  });

  it("the @/* path alias resolves to src in vitest", () => {
    expect(KNOWN_SCHEMA_VERSION).toBe(1);
  });
});
