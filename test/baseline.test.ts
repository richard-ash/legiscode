import { describe, expect, it } from "vitest";
import type { SectionFile } from "@/types";

describe("baseline", () => {
  it("vitest runs", () => {
    expect(1 + 1).toBe(2);
  });

  it("the @/* path alias resolves to src in vitest", () => {
    const placeholder = {} as SectionFile;
    expect(placeholder).toBeDefined();
  });
});
