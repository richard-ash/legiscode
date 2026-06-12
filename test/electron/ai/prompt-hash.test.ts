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

describe("SYSTEM_PROMPT_V1 — feat/agent-polish rules", () => {
  // Smoke check that R17/R18/R19 + the three templates survived a
  // refactor. The prompt body has no separate spec we can diff against;
  // these substrings encode the load-bearing surface each rule promises.
  it.each([
    ["R17 self-talk guard", '"I haven\'t fetched X yet"'],
    ["R18 article-range read", "/modules/{module_id}/articles/{article_id}"],
    ["R19 Sources block format", "**Sources**"],
    ["R20 analyst-memo template", "## Memo:"],
    ["R21 bill-impact-table template", "Current law:"],
    ["R22 reading-order template", "## Reading order"],
    ["R23 affected-section completeness", "affected_section_ids"],
    ["R24 packet-triage template", "## Packet triage"],
    ["R25 bill-claim discipline", "blockquotes"],
    ["bill impact path", "/bills/{file_no}/impact"],
    ["section dependencies path", "/modules/{module_id}/sections/{section_id}/dependencies"],
  ])("contains %s", (_label, needle) => {
    expect(SYSTEM_PROMPT_V1).toContain(needle);
  });
});
