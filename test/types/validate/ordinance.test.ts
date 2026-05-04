import { describe, expect, it } from "vitest";
import { OrdinanceFileSchema } from "@/types";

describe("OrdinanceFileSchema", () => {
  it("accepts an ok ordinance with non-empty text_diff", () => {
    const result = OrdinanceFileSchema.parse({
      number: "Ord. 0231-25",
      title: "Amending § 10.04.020",
      status: "enacted",
      text_diff: [{ op: "context", text: "..." }],
      parse_status: "ok",
    });
    expect(result.parse_status).toBe("ok");
  });

  it("rejects ok parse_status with empty text_diff (conditional invariant)", () => {
    const result = OrdinanceFileSchema.safeParse({
      number: "Ord. 0231-25",
      title: "x",
      status: "enacted",
      text_diff: [],
      parse_status: "ok",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("text_diff");
    }
  });

  it("accepts manual_review with empty text_diff", () => {
    const result = OrdinanceFileSchema.parse({
      number: "Ord. 0231-25",
      title: "x",
      status: "enacted",
      text_diff: [],
      parse_status: "manual_review",
    });
    expect(result.parse_status).toBe("manual_review");
  });

  it("rejects unknown parse_status", () => {
    const result = OrdinanceFileSchema.safeParse({
      number: "Ord. 0231-25",
      title: "x",
      status: "enacted",
      text_diff: [],
      parse_status: "unknown_status",
    });
    expect(result.success).toBe(false);
  });
});
