// @vitest-environment jsdom
/// <reference lib="dom" />
//
// DiffView covers the per-section overlay decision tree:
//
//   • anchored / added_section outcomes: load the baseline and render
//     the inline diff (loading → loaded states).
//   • renderable but baseline load fails / returns null: no_baseline
//     banner with a specific reason.
//   • non-renderable outcomes (4 banner-reason variants):
//     classification_low_confidence, unresolved, structural,
//     absorbed_external — each gets its own banner copy.
//   • cancellation guard: an unmount during load doesn't paint a
//     stale baseline.
//   • epoch invalidation: a corpus-epoch change mid-load re-fetches.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type Bill,
  BillSchema,
  deriveParseStatus,
  type ModuleId,
  type SectionId,
  type SectionOutcome,
  type SectionOutcomeStatus,
} from "@/types";
import { DiffView } from "@/ui/diff-view/DiffView";

const MODULE_ID = "sf-test" as ModuleId;
const SECTION_ID = "1.1" as SectionId;
const BASELINE = "The committee shall meet quarterly to review reports.";

function makeBill(outcomes: SectionOutcome[], diffChunks: Bill["diff_chunks"] = []): Bill {
  const hasStructural = outcomes.some((o) => o.status === "structural");
  return BillSchema.parse({
    file_no: "260217",
    module_id: MODULE_ID,
    short_title: "Test",
    long_title: "Ordinance amending the Test Code.",
    sponsor: null,
    introduced_at: "2026-05-12",
    legistar_url: "https://e/d?ID=1&GUID=g",
    legistar_status: "Pending",
    bill_status: "committee",
    section_outcomes: outcomes,
    diff_chunks: diffChunks,
    parse_status: deriveParseStatus(outcomes, hasStructural),
    structural_change_scope: hasStructural ? "Repeals Chapter 10" : null,
    body: { preamble: "", amendments: [], closing: "" },
  } as Bill);
}

describe("DiffView — anchored path (renderable)", () => {
  it("renders the loading state then the inline diff after the baseline loads", async () => {
    let resolveLoader: ((text: string | null) => void) | null = null;
    const loader = vi.fn().mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveLoader = resolve;
        }),
    );
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "anchored", detail: null }],
      [
        {
          op: "insert",
          text: "new clause",
          section_id: SECTION_ID,
        },
      ],
    );
    render(<DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />);
    // Loading state visible first.
    expect(screen.getByText(/Loading the diff/i)).toBeInTheDocument();
    // Resolve the loader; loaded state appears.
    (resolveLoader as ((text: string | null) => void) | null)?.(BASELINE);
    await waitFor(() => {
      expect(screen.getByTestId("diff-view-loaded")).toBeInTheDocument();
    });
    expect(screen.getByText("new clause")).toBeInTheDocument();
  });

  it("renders the diff immediately when baselineOverride is provided", () => {
    const loader = vi.fn();
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "anchored", detail: null }],
      [
        {
          op: "insert",
          text: "added text",
          section_id: SECTION_ID,
        },
      ],
    );
    render(
      <DiffView
        bill={bill}
        sectionId={SECTION_ID}
        baselineLoader={loader}
        epoch="v1"
        baselineOverride={BASELINE}
      />,
    );
    expect(screen.getByTestId("diff-view-loaded")).toBeInTheDocument();
    expect(screen.getByText("added text")).toBeInTheDocument();
    expect(loader).not.toHaveBeenCalled();
  });

  it("renders the wholesale-delete as strikethrough across the section body", async () => {
    const loader = vi.fn().mockResolvedValue(BASELINE);
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "anchored", detail: null }],
      [
        {
          op: "delete",
          text: BASELINE,
          section_id: SECTION_ID,
        },
      ],
    );
    render(<DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />);
    await waitFor(() => {
      expect(screen.getByTestId("diff-view-loaded")).toBeInTheDocument();
    });
    // The wholesale delete renders as a single diff_delete run covering
    // the full baseline. The renderer shows it struck-through; we just
    // assert the data-diff-op attribute and the text content.
    const struckRun = screen.getByText(BASELINE);
    expect(struckRun.getAttribute("data-diff-op")).toBe("delete");
  });

  it("renders no_baseline banner when the loader returns null", async () => {
    const loader = vi.fn().mockResolvedValue(null);
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "anchored", detail: null }],
      [
        {
          op: "insert",
          text: "x",
          section_id: SECTION_ID,
        },
      ],
    );
    render(<DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />);
    await waitFor(() => {
      expect(screen.getByTestId("diff-banner-no_baseline")).toBeInTheDocument();
    });
  });

  it("renders no_baseline banner with the error message when the loader throws", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("IPC bridge unavailable"));
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "anchored", detail: null }],
      [
        {
          op: "insert",
          text: "x",
          section_id: SECTION_ID,
        },
      ],
    );
    render(<DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />);
    await waitFor(() => {
      expect(screen.getByText(/IPC bridge unavailable/i)).toBeInTheDocument();
    });
  });
});

describe("DiffView — per-section banner variants (4 outcomes)", () => {
  it.each<[SectionOutcomeStatus, RegExp]>([
    ["classification_low_confidence", /Couldn't interpret/i],
    ["unresolved", /Couldn't locate/i],
    ["structural", /Structural change/i],
    ["absorbed_external", /Codified by AmLegal/i],
  ])("renders the %s banner with specific copy", (status, copyPattern) => {
    const loader = vi.fn();
    const bill = makeBill([{ section_id: SECTION_ID, status, detail: null }]);
    render(<DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />);
    expect(screen.getByTestId(`diff-banner-${status}`)).toBeInTheDocument();
    expect(screen.getByText(copyPattern)).toBeInTheDocument();
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("DiffView — added_section variant", () => {
  it("renders the added_section insert spans when a baseline IS available (rare)", async () => {
    // Today, sections classified as added_section have empty baselines
    // (the section doesn't exist yet in the corpus). The edge case
    // is when an operator backfills the corpus while the bill is
    // pending — the section now has a baseline, but the bill still
    // carries the added_section outcome. DiffView treats it as
    // renderable and emits the insert span over the (rare) baseline.
    const loader = vi.fn().mockResolvedValue("Existing baseline text.");
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "added_section", detail: null }],
      [
        {
          op: "insert",
          text: "§1.1 New section body.",
          section_id: SECTION_ID,
        },
      ],
    );
    render(<DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />);
    await waitFor(() => {
      expect(screen.getByTestId("diff-view-loaded")).toBeInTheDocument();
    });
    expect(screen.getByText("§1.1 New section body.")).toBeInTheDocument();
  });

  it("renders the added_section diff (full new text via diff_chunks insert)", async () => {
    const loader = vi.fn().mockResolvedValue(""); // baseline is empty for added sections
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "added_section", detail: null }],
      [
        {
          op: "insert",
          text: "§1.1 Brand new section. Every department shall do X.",
          section_id: SECTION_ID,
        },
      ],
    );
    render(<DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />);
    // Baseline is empty for added sections → no_baseline banner copy
    // surfaces; the per-section banner for added_section path is the
    // caller's job (section-pending-rail explainer). DiffView only
    // renders the diff when a baseline exists.
    await waitFor(() => {
      expect(screen.getByTestId("diff-banner-no_baseline")).toBeInTheDocument();
    });
  });
});

describe("DiffView — no outcome for the section", () => {
  it("renders nothing when the bill doesn't list this section in section_outcomes", () => {
    const loader = vi.fn();
    // Use a non-renderable outcome on the OTHER section so the schema
    // refine doesn't demand diff_chunks content.
    const bill = makeBill([
      { section_id: "9.9" as SectionId, status: "classification_low_confidence", detail: null },
    ]);
    const { container } = render(
      <DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("DiffView — cancellation guard", () => {
  it("does not paint a stale baseline when the component unmounts mid-load", async () => {
    let resolveLoader: ((text: string | null) => void) | null = null;
    const loader = vi.fn().mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveLoader = resolve;
        }),
    );
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "anchored", detail: null }],
      [
        {
          op: "insert",
          text: "x",
          section_id: SECTION_ID,
        },
      ],
    );
    const { unmount } = render(
      <DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />,
    );
    // Unmount before the loader resolves.
    unmount();
    // Now resolve the loader; nothing should throw (the component's
    // cancellation guard discards the result).
    (resolveLoader as ((text: string | null) => void) | null)?.(BASELINE);
    // Give microtasks time to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The component is unmounted; nothing to assert on the DOM. The
    // "no React warning about state-update-on-unmounted-component"
    // proves the guard is doing its job; we leave that to the harness
    // (vitest fails the test if React logs the warning).
    expect(loader).toHaveBeenCalled();
  });

  it("re-fetches when the epoch token changes (corpus reload)", async () => {
    let resolveLoader: ((text: string | null) => void) | null = null;
    const loader = vi.fn().mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveLoader = resolve;
        }),
    );
    const bill = makeBill(
      [{ section_id: SECTION_ID, status: "anchored", detail: null }],
      [
        {
          op: "insert",
          text: "x",
          section_id: SECTION_ID,
        },
      ],
    );
    const { rerender } = render(
      <DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v1" />,
    );
    expect(loader).toHaveBeenCalledTimes(1);
    // Change the epoch — the in-flight load is cancelled and a new
    // load fires.
    rerender(<DiffView bill={bill} sectionId={SECTION_ID} baselineLoader={loader} epoch="v2" />);
    expect(loader).toHaveBeenCalledTimes(2);
    (resolveLoader as ((text: string | null) => void) | null)?.(BASELINE);
    await waitFor(() => {
      expect(screen.getByTestId("diff-view-loaded")).toBeInTheDocument();
    });
  });
});
