import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatZodError } from "@/types/validate/format-error";

const ExampleSchema = z
  .object({
    name: z.string().min(1),
    nested: z.object({ count: z.number().int() }),
  })
  .strict();

describe("formatZodError", () => {
  it("formats a single-field error as <path>: <reason>", () => {
    const result = ExampleSchema.safeParse({ name: "", nested: { count: 0 } });
    if (result.success) throw new Error("expected failure");
    const message = formatZodError(result.error);
    expect(message).toContain("name");
  });

  it("formats nested-path errors with dot notation", () => {
    const result = ExampleSchema.safeParse({ name: "ok", nested: { count: 1.5 } });
    if (result.success) throw new Error("expected failure");
    expect(formatZodError(result.error)).toContain("nested.count");
  });

  it("joins multiple errors with semicolons", () => {
    const result = ExampleSchema.safeParse({ name: "", nested: { count: 1.5 } });
    if (result.success) throw new Error("expected failure");
    const message = formatZodError(result.error);
    expect(message).toContain("name");
    expect(message).toContain("nested.count");
    expect(message).toContain(";");
  });
});
