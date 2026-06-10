// Prompt-hash regression test (T8 / A5). The hash pins the
// SYSTEM_PROMPT_V1 + tool definitions; any intentional edit must be
// accompanied by a re-validation of every golden Q&A pair. Don't bump
// silently.

import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_HASH, SYSTEM_PROMPT_V1 } from "../../../electron/ai/prompt";

describe("SYSTEM_PROMPT_HASH", () => {
  it("is a 12-char hex string", () => {
    expect(SYSTEM_PROMPT_HASH).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when the prompt changes", async () => {
    const { createHash } = await import("node:crypto");
    const recompute = createHash("sha256")
      .update(SYSTEM_PROMPT_V1, "utf8")
      .digest("hex")
      .slice(0, 12);
    expect(recompute).toBe(SYSTEM_PROMPT_HASH);
  });
});
