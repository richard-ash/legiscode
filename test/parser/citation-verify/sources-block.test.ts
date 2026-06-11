// Sources-block parser + verifier-extension tests (commit 4,
// feat/agent-polish). The parser is the single shared surface
// consumed by both the verifier and the chat renderer (D3 lock);
// drift between consumers is impossible by construction.

import { describe, expect, it } from "vitest";
import {
  type FetchedBill,
  parseSourcesBlock,
  splitProseAndSources,
  verifySourcesBlock,
} from "@/parser/citation-verify";

describe("parseSourcesBlock — heading detection", () => {
  it("finds a bold-heading Sources block", () => {
    const text =
      "Paragraph one.\n\n" +
      "**Sources**\n" +
      "- [sf-planning § 106] — Zoning Map Incorporated Herein\n" +
      "- [Bill #260543] — Police Code Penalty\n";
    const parsed = parseSourcesBlock(text);
    expect(parsed.present).toBe(true);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      kind: "section",
      module_id: "sf-planning",
      section_id: "106",
      title: "Zoning Map Incorporated Herein",
    });
    expect(parsed.entries[1]).toMatchObject({
      kind: "bill",
      file_no: "260543",
      title: "Police Code Penalty",
    });
  });

  it("finds an ATX heading Sources block (## Sources)", () => {
    const text = "Body.\n\n## Sources\n- [sf-fire § 1.1] — Authority\n";
    const parsed = parseSourcesBlock(text);
    expect(parsed.present).toBe(true);
    expect(parsed.entries[0]?.module_id).toBe("sf-fire");
  });

  it("returns present=false when no heading is found", () => {
    const text = "Body that mentions Sources offhand but has no block.";
    const parsed = parseSourcesBlock(text);
    expect(parsed.present).toBe(false);
    expect(parsed.entries).toEqual([]);
  });

  it("tolerates a title-less entry", () => {
    const text = "**Sources**\n- [sf-planning § 106]\n";
    const parsed = parseSourcesBlock(text);
    expect(parsed.entries[0]?.title).toBe("");
  });

  it("classifies unparseable bracket content as kind=unknown", () => {
    const text = "**Sources**\n- [not a real ref] — junk\n";
    const parsed = parseSourcesBlock(text);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.kind).toBe("unknown");
  });

  it("stops at the first non-list non-blank line", () => {
    const text =
      "**Sources**\n- [sf-planning § 106] — Title\n\n" +
      "This trailing paragraph is not part of the block.\n";
    const parsed = parseSourcesBlock(text);
    expect(parsed.entries).toHaveLength(1);
  });

  it("ReDoS guard: oversized input returns not-present without scanning", () => {
    // 60KB of repetitive almost-but-not-quite-matching input.
    const huge = `**Sources**\n${"- [aaaaaaaaaa § 1.1]\n".repeat(3000)}`;
    expect(huge.length).toBeGreaterThan(50_000);
    const parsed = parseSourcesBlock(huge);
    expect(parsed.present).toBe(false);
  });
});

describe("splitProseAndSources — body / block split", () => {
  it("returns the body before the heading and the block after", () => {
    const text = "Body paragraph.\n\n**Sources**\n- [sf-fire § 1.1] — T\n";
    const split = splitProseAndSources(text);
    expect(split.body).toBe("Body paragraph.");
    expect(split.block.startsWith("**Sources**")).toBe(true);
  });

  it("returns the full text as body when no block is present", () => {
    const text = "Just a body paragraph.";
    const split = splitProseAndSources(text);
    expect(split.body).toBe(text);
    expect(split.block).toBe("");
  });
});

describe("verifySourcesBlock — citation-driven enforcement (D3/D8)", () => {
  it("ok when the answer cites nothing", () => {
    const result = verifySourcesBlock({
      text: "The corpus doesn't include sf-fire.",
      fetchedSections: [],
      fetchedBills: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe("no_citations");
  });

  it("ok when every cite appears in the block AND every entry was fetched", () => {
    const text =
      "Per [sf-planning § 106], the zoning map is incorporated. " +
      "[Bill #260543] amends the penalty.\n\n" +
      "**Sources**\n" +
      "- [sf-planning § 106] — Zoning Map Incorporated Herein\n" +
      "- [Bill #260543] — Police Code Penalty\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [{ module_id: "sf-planning", section_id: "106" }],
      fetchedBills: [{ file_no: "260543" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "block_valid") {
      expect(result.entryCount).toBe(2);
    }
  });

  it("fails when the prose cites but no Sources block is present", () => {
    const result = verifySourcesBlock({
      text: "Per [sf-planning § 106] the rule applies.",
      fetchedSections: [{ module_id: "sf-planning", section_id: "106" }],
      fetchedBills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("block_missing");
  });

  it("fails when prose cites a section that's missing from the block", () => {
    const text =
      "Per [sf-planning § 106] and [sf-planning § 302], the rule applies.\n\n" +
      "**Sources**\n" +
      "- [sf-planning § 106] — Zoning Map\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [
        { module_id: "sf-planning", section_id: "106" },
        { module_id: "sf-planning", section_id: "302" },
      ],
      fetchedBills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "cited_but_not_in_block") {
      expect(result.missing.map((m) => m.display)).toContain("[sf-planning § 302]");
    }
  });

  it("fails when a block entry was not fetched this turn", () => {
    const text =
      "Per [sf-planning § 106] the rule applies.\n\n" +
      "**Sources**\n" +
      "- [sf-planning § 106] — Zoning Map\n" +
      "- [sf-planning § 999] — Phantom Section\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [{ module_id: "sf-planning", section_id: "106" }],
      fetchedBills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "block_entry_not_fetched") {
      expect(result.missing.map((m) => m.display)).toContain("[sf-planning § 999]");
    }
  });

  it("tracks bill citations alongside section citations (D8/codex #3)", () => {
    const text =
      "[Bill #260543] amends Penalty section.\n\n" +
      "**Sources**\n" +
      "- [Bill #260543] — Police Code Penalty\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [],
      fetchedBills: [{ file_no: "260543" }],
    });
    expect(result.ok).toBe(true);
  });

  it("fails when a cited bill is missing from the Sources block", () => {
    const text =
      "[Bill #260543] and [Bill #260544] both apply.\n\n" +
      "**Sources**\n" +
      "- [Bill #260543] — Police Code Penalty\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [],
      fetchedBills: [{ file_no: "260543" }, { file_no: "260544" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "cited_but_not_in_block") {
      expect(result.missing.map((m) => m.display)).toContain("[Bill #260544]");
    }
  });

  it("flags unparseable block entries before checking fetched / missing", () => {
    const text =
      "Per [sf-planning § 106] the rule applies.\n\n" +
      "**Sources**\n" +
      "- [sf-planning § 106] — Zoning Map\n" +
      "- [garbage entry] — meaningless\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [{ module_id: "sf-planning", section_id: "106" }],
      fetchedBills: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("block_entry_unparseable");
  });
});

describe("verifySourcesBlock — R23 affected-section completeness", () => {
  // Bill 260545 (the doc's acceptance test) amends Health Code Secs.
  // 407, 694, 695. R20 / R21 answers must cover all three.
  const bill260545: FetchedBill = {
    file_no: "260545",
    module_id: "sf-health",
    affected_section_ids: ["407", "694", "695"],
  };

  it("memo (R20) with all affected sections cited passes", () => {
    const text =
      "## Memo: [Bill #260545]\n" +
      "**Re:** Health code cleanup\n" +
      "**Summary** — Three sections updated.\n" +
      "**Affected Sections** — [sf-health § 407], [sf-health § 694], [sf-health § 695].\n\n" +
      "**Sources**\n" +
      "- [Bill #260545] — Health code cleanup\n" +
      "- [sf-health § 407] — Sec 407\n" +
      "- [sf-health § 694] — Sec 694\n" +
      "- [sf-health § 695] — Sec 695\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [
        { module_id: "sf-health", section_id: "407" },
        { module_id: "sf-health", section_id: "694" },
        { module_id: "sf-health", section_id: "695" },
      ],
      fetchedBills: [bill260545],
    });
    expect(result.ok).toBe(true);
  });

  it("memo (R20) missing one affected section fails with the omitted set", () => {
    // 695 is in the bill's affected_section_ids but absent from prose and block.
    const text =
      "## Memo: [Bill #260545]\n" +
      "**Re:** Health code cleanup\n" +
      "**Affected Sections** — [sf-health § 407] and [sf-health § 694].\n\n" +
      "**Sources**\n" +
      "- [Bill #260545] — Health code cleanup\n" +
      "- [sf-health § 407] — Sec 407\n" +
      "- [sf-health § 694] — Sec 694\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [
        { module_id: "sf-health", section_id: "407" },
        { module_id: "sf-health", section_id: "694" },
      ],
      fetchedBills: [bill260545],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "bill_affected_sections_omitted") {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]?.file_no).toBe("260545");
      expect(result.missing[0]?.sections.map((s) => s.section_id)).toEqual(["695"]);
    }
  });

  it("bill-impact-table (R21) heading triggers the same completeness check", () => {
    const text =
      "## What [Bill #260545] does to [sf-health § 407]\n" +
      "**Current law:** ...\n" +
      "**Proposed change:** ...\n\n" +
      "**Sources**\n" +
      "- [Bill #260545] — Health cleanup\n" +
      "- [sf-health § 407] — Sec 407\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [{ module_id: "sf-health", section_id: "407" }],
      fetchedBills: [bill260545],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "bill_affected_sections_omitted") {
      // 694 and 695 are missing.
      expect(result.missing[0]?.sections.map((s) => s.section_id).sort()).toEqual(["694", "695"]);
    }
  });

  it("free prose about a single section of a multi-section bill is exempt", () => {
    // No memo/impact heading — narrow question, R23 doesn't enforce.
    const text =
      "Yes, [Bill #260545] changes [sf-health § 695] by adding a fine schedule.\n\n" +
      "**Sources**\n" +
      "- [Bill #260545] — Health cleanup\n" +
      "- [sf-health § 695] — Sec 695\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [{ module_id: "sf-health", section_id: "695" }],
      fetchedBills: [bill260545],
    });
    expect(result.ok).toBe(true);
  });

  it("memo about a bill whose affected_section_ids is unknown is exempt", () => {
    // Path-only harvest: file_no known, but module_id and affected_section_ids
    // are absent. R23 has no data to enforce against, so the answer passes.
    const text =
      "## Memo: [Bill #260545]\n" +
      "Brief notes.\n\n" +
      "**Sources**\n" +
      "- [Bill #260545] — Health cleanup\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [],
      fetchedBills: [{ file_no: "260545" }],
    });
    expect(result.ok).toBe(true);
  });

  it("reading-order (R22) heading is exempt — only memo/impact promise full coverage", () => {
    const text =
      "## Reading order from [sf-health § 407]\n" +
      "**Read next:**\n" +
      "1. [sf-health § 407] — Sec 407 — start here.\n\n" +
      "[Bill #260545] amends this section.\n\n" +
      "**Sources**\n" +
      "- [sf-health § 407] — Sec 407\n" +
      "- [Bill #260545] — Health cleanup\n";
    const result = verifySourcesBlock({
      text,
      fetchedSections: [{ module_id: "sf-health", section_id: "407" }],
      fetchedBills: [bill260545],
    });
    expect(result.ok).toBe(true);
  });
});
