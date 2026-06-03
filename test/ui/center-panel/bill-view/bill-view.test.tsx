// @vitest-environment jsdom
//
// Covers the r11 BillView: kicker + h1 + meta row, parse-status notice
// variants, Amends chips, the Legistar IPC seam, and the empty/not-
// pending fallback. The kind labels + per-section bodies are gone per
// CR-1; chips ARE the navigation.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Bill, BillSchema } from "@/types";
import { BillView } from "@/ui/center-panel/bill-view/bill-view";
import type { OpenItem } from "@/workbench/open-items";

function makeBill(over: Partial<Bill> = {}): Bill {
  return BillSchema.parse({
    file_no: "260217",
    module_id: "sf-port",
    short_title: "Residential Speed Reduction Act",
    long_title: "Ordinance amending the Port Code…",
    sponsor: "Sup. Walton (District 10)",
    introduced_at: "2026-05-12",
    legistar_url: "https://sfgov.legistar.com/Detail?ID=1&GUID=g",
    legistar_status: "Pending — Land Use Cmte",
    bill_status: "committee",
    affected_sections: ["1.1", "1.2"],
    text_diff: [],
    parse_status: "manual_review",
    structural_change_scope: null,
    body: { preamble: "", amendments: [], closing: "" },
    ...over,
  });
}

const TAB_PANEL = { id: "tabpanel-bill::260217", labelledBy: "tab-bill::260217" };

describe("BillView — header chrome (r11)", () => {
  it("renders the kicker with the code label and the status badge", () => {
    render(
      <BillView
        bills={[makeBill()]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
        codeLabel="Port Code"
      />,
    );
    // The kicker renders the code name first, then a separator, then
    // the status label colored by tone.
    expect(screen.getByText("Port Code")).toBeInTheDocument();
    expect(screen.getByText("Committee")).toBeInTheDocument();
  });

  it("falls back to module_id in the kicker when codeLabel isn't provided", () => {
    render(<BillView bills={[makeBill()]} navigate={vi.fn()} tabPanel={TAB_PANEL} />);
    expect(screen.getByText("sf-port")).toBeInTheDocument();
  });

  it("renders the title with #file_no + short_title", () => {
    render(<BillView bills={[makeBill()]} navigate={vi.fn()} tabPanel={TAB_PANEL} />);
    expect(
      screen.getByRole("heading", { name: /Residential Speed Reduction Act/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("#260217")).toBeInTheDocument();
  });

  it("renders the meta row with introduced date + sponsor", () => {
    render(<BillView bills={[makeBill()]} navigate={vi.fn()} tabPanel={TAB_PANEL} />);
    expect(screen.getByText("2026-05-12")).toBeInTheDocument();
    expect(screen.getByText("Sup. Walton (District 10)")).toBeInTheDocument();
  });

  it("does NOT duplicate the status pill in the meta row (Pass 7 lock #5)", () => {
    // The kicker badge is the single source of truth for status. The
    // meta row's status pill from the old design has been removed.
    render(<BillView bills={[makeBill()]} navigate={vi.fn()} tabPanel={TAB_PANEL} />);
    const status = screen.getAllByText("Committee");
    expect(status).toHaveLength(1);
  });
});

describe("BillView — Open in Legistar", () => {
  it("clicking Open in Legistar dispatches onOpenLegistar with the bill's URL", () => {
    const onOpenLegistar = vi.fn();
    render(
      <BillView
        bills={[makeBill()]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
        onOpenLegistar={onOpenLegistar}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open Ord\. 260217 in Legistar/i }));
    expect(onOpenLegistar).toHaveBeenCalledWith("https://sfgov.legistar.com/Detail?ID=1&GUID=g");
  });

  it("when onOpenLegistar isn't wired, the button is still focusable but inert", () => {
    render(<BillView bills={[makeBill()]} navigate={vi.fn()} tabPanel={TAB_PANEL} />);
    const btn = screen.getByRole("button", { name: /Open Ord\. 260217 in Legistar/i });
    expect(() => fireEvent.click(btn)).not.toThrow();
  });
});

describe("BillView — parse-status notices", () => {
  it("shows the manual-review notice (pre-typography-spike) when no module has parsed cleanly", () => {
    render(<BillView bills={[makeBill()]} navigate={vi.fn()} tabPanel={TAB_PANEL} />);
    expect(screen.getByText(/Insertions and deletions aren't styled yet/i)).toBeInTheDocument();
  });

  it("shows a structural-change notice with the scope description", () => {
    render(
      <BillView
        bills={[
          makeBill({
            parse_status: "structural_change",
            structural_change_scope: "Repeals Chapter 10 in its entirety",
            affected_sections: [],
          }),
        ]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
      />,
    );
    expect(screen.getByText(/structural change/i)).toBeInTheDocument();
    expect(screen.getByText(/repeals chapter 10/i)).toBeInTheDocument();
  });
});

describe("BillView — Amends chips", () => {
  it("renders one chip per (module, section) pair", () => {
    render(<BillView bills={[makeBill()]} navigate={vi.fn()} tabPanel={TAB_PANEL} />);
    // Amends label + 2 chips
    expect(screen.getByText(/Amends/i)).toBeInTheDocument();
    expect(screen.getByText("§ 1.1")).toBeInTheDocument();
    expect(screen.getByText("§ 1.2")).toBeInTheDocument();
  });

  it("includes the section title in the chip when lookupSectionTitle returns one", () => {
    const lookupSectionTitle = vi.fn().mockReturnValue("Speed Limits");
    render(
      <BillView
        bills={[makeBill({ affected_sections: ["1.1"] })]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
        lookupSectionTitle={lookupSectionTitle}
      />,
    );
    expect(screen.getByText("Speed Limits")).toBeInTheDocument();
  });

  it("clicking a chip navigates to that section under the bill's module", () => {
    const navigate = vi.fn();
    render(<BillView bills={[makeBill()]} navigate={navigate} tabPanel={TAB_PANEL} />);
    fireEvent.click(screen.getByText("§ 1.1"));
    expect(navigate).toHaveBeenCalledTimes(1);
    const [item, intent] = navigate.mock.calls[0] ?? [];
    expect((item as OpenItem | undefined)?.kind).toBe("section");
    expect(intent).toBe("primary");
    if (item && item.kind === "section") {
      expect(item.ref.module).toBe("sf-port");
      expect(item.ref.section).toBe("1.1");
    }
  });

  it("Cmd+click opens the section in background (no tab switch)", () => {
    const navigate = vi.fn();
    render(<BillView bills={[makeBill()]} navigate={navigate} tabPanel={TAB_PANEL} />);
    fireEvent.click(screen.getByText("§ 1.2"), { metaKey: true });
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "section" }),
      "background",
    );
  });

  it("dedupes (module, section) pairs across the per-module bill rows", () => {
    // A multi-code bill with the same section in two modules emits one
    // chip per (module, section) pair.
    render(
      <BillView
        bills={[
          makeBill({ module_id: "sf-port", affected_sections: ["1.1"] }),
          makeBill({ module_id: "sf-port", affected_sections: ["1.1"] }),
          makeBill({ module_id: "sf-fire", affected_sections: ["101"] }),
        ]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
      />,
    );
    expect(screen.getByText("§ 1.1")).toBeInTheDocument();
    expect(screen.getByText("§ 101")).toBeInTheDocument();
    // Exactly two chips (the duplicate 1.1 collapsed).
    expect(screen.getAllByText(/§/).filter((el) => el.tagName === "CODE")).toHaveLength(2);
  });

  it("hides the Amends section entirely when no bill row touches any section", () => {
    // Pass 7 lock #6 + CR-1: no chips, no count, no 'Amends' label —
    // the surface is suppressed entirely. The parse-status notice
    // (structural change) still surfaces because that's a separate
    // signal.
    render(
      <BillView
        bills={[
          makeBill({
            affected_sections: [],
            parse_status: "structural_change",
            structural_change_scope: "Repeals Chapter 10",
          }),
        ]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
      />,
    );
    expect(screen.queryByText(/Amends/i)).not.toBeInTheDocument();
  });
});

describe("BillView — empty state", () => {
  it("renders a 'no longer pending' notice when bills is empty", () => {
    render(<BillView bills={[]} navigate={vi.fn()} tabPanel={TAB_PANEL} />);
    expect(screen.getByText(/no longer pending/i)).toBeInTheDocument();
  });
});

describe("BillView — long_title + proposed text", () => {
  it("renders the long_title as the purpose statement above the chips", () => {
    render(
      <BillView
        bills={[
          makeBill({
            long_title:
              "Ordinance amending the Port Code to reduce residential speed limits to 20 mph citywide.",
          }),
        ]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
        codeLabel="Port Code"
      />,
    );
    expect(screen.getByText(/reduce residential speed limits/i)).toBeInTheDocument();
  });

  it("renders the structured body — preamble, action line, SEC. header, paragraphs, closing", () => {
    render(
      <BillView
        bills={[
          makeBill({
            body: {
              preamble: "Be it ordained by the People.",
              amendments: [
                {
                  action: "Section 1. Article 8 of the Port Code is hereby amended.",
                  target: { module_id: "sf-port", raw_section_id: "1.1" },
                  body: [
                    { kind: "code_section_header", number: "1.1", title: "SPEED LIMITS." },
                    {
                      kind: "paragraph",
                      text: "The maximum residential speed shall be 20 mph.",
                    },
                  ],
                },
              ],
              closing: "Section 2. Effective Date. This ordinance takes effect immediately.",
            },
          }),
        ]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
        codeLabel="Port Code"
      />,
    );
    expect(screen.getByRole("heading", { name: /Ordinance text/i })).toBeInTheDocument();
    expect(screen.getByText(/Be it ordained by the People/)).toBeInTheDocument();
    expect(
      screen.getByText(/Section 1\. Article 8 of the Port Code is hereby amended\./),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /SEC\. 1\.1\.\s+SPEED LIMITS\./ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/maximum residential speed shall be 20 mph/i)).toBeInTheDocument();
    expect(screen.getByText(/Section 2\. Effective Date/)).toBeInTheDocument();
  });

  it("renders subsection markers in their own block alongside the body prose", () => {
    render(
      <BillView
        bills={[
          makeBill({
            body: {
              preamble: "",
              amendments: [
                {
                  action: "Section 1. The Port Code is hereby amended.",
                  target: { module_id: "sf-port", raw_section_id: "694" },
                  body: [
                    { kind: "code_section_header", number: "694", title: "WIPING RAGS." },
                    {
                      kind: "subsection",
                      marker: "(a)",
                      body: [{ kind: "paragraph", text: "Materials and Cleaning Thereof." }],
                    },
                  ],
                },
              ],
              closing: "",
            },
          }),
        ]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
        codeLabel="Port Code"
      />,
    );
    expect(screen.getByText("(a)")).toBeInTheDocument();
    expect(screen.getByText(/Materials and Cleaning Thereof/)).toBeInTheDocument();
  });

  it("omits the ordinance text block when the body has no preamble, amendments, or closing", () => {
    render(
      <BillView
        bills={[makeBill({ body: { preamble: "", amendments: [], closing: "" } })]}
        navigate={vi.fn()}
        tabPanel={TAB_PANEL}
        codeLabel="Port Code"
      />,
    );
    expect(screen.queryByRole("heading", { name: /Ordinance text/i })).not.toBeInTheDocument();
  });
});
