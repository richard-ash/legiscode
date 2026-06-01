// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CorpusModuleSummary } from "@/corpus/wire";
import { StatusBar } from "@/ui/chrome/status-bar";
import { usePendingBillsStatus } from "@/ui/chrome/use-pending-bills-status";

function Harness({ corpus }: { corpus: CorpusModuleSummary | null }) {
  usePendingBillsStatus(corpus);
  return <StatusBar rootLabel="SF" jurisdictionVersion="2026.05.30" codeCount={3} />;
}

const baseSummary: Omit<CorpusModuleSummary, "pendingBills"> = {
  jurisdiction: "Test",
  rootLabel: "SF",
  jurisdictionVersion: "2026.05.30",
  codeCount: 3,
  sectionCount: 10,
  defaultRef: { moduleId: "sf-test", sectionId: "1.0" },
  tree: [],
  definitions: [],
};

describe("usePendingBillsStatus", () => {
  it("hides the indicator when corpus is null (boot state)", () => {
    const { queryByText } = render(<Harness corpus={null} />);
    expect(queryByText(/pending$/)).toBeNull();
  });

  it("hides the indicator when count is 0 (no bills loaded)", () => {
    const { queryByText } = render(
      <Harness corpus={{ ...baseSummary, pendingBills: { count: 0, bills: [] } }} />,
    );
    expect(queryByText(/pending$/)).toBeNull();
  });

  it("renders 'N pending' with peach icon when count is positive", () => {
    const { queryByText } = render(
      <Harness corpus={{ ...baseSummary, pendingBills: { count: 3, bills: [] } }} />,
    );
    expect(queryByText("3 pending")).not.toBeNull();
  });

  it("singular tooltip when count is 1, plural otherwise", () => {
    const { container, rerender } = render(
      <Harness corpus={{ ...baseSummary, pendingBills: { count: 1, bills: [] } }} />,
    );
    expect(container.querySelector('[title="1 pending ordinance loaded"]')).not.toBeNull();
    rerender(<Harness corpus={{ ...baseSummary, pendingBills: { count: 5, bills: [] } }} />);
    expect(container.querySelector('[title="5 pending ordinances loaded"]')).not.toBeNull();
  });
});
