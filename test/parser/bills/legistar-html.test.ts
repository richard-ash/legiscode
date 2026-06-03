import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLegistarSearchSubmission,
  extractLegistarSearchForm,
  LegistarParseError,
  parseLegistarDetailPage,
  parseLegistarSearchPage,
  pickLatestLegVer,
} from "@/parser/bills/legistar-html";

const FIXTURE_DIR = join(import.meta.dirname, "..", "..", "fixtures", "sf", "legistar-html");
const SEARCH_URL = "https://sfgov.legistar.com/Legislation.aspx";

function read(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

describe("parseLegistarSearchPage", () => {
  it("extracts every row including non-Ordinance types", () => {
    const rows = parseLegistarSearchPage(read("search.html"), SEARCH_URL);
    expect(rows).toHaveLength(4);
    const fileNos = rows.map((r) => r.file_no);
    expect(fileNos).toEqual(["260217", "260296", "260541", "260612"]);
  });

  it("absolutizes detail URLs against the search page base", () => {
    const rows = parseLegistarSearchPage(read("search.html"), SEARCH_URL);
    expect(rows[0]?.detail_url).toBe(
      "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789012&GUID=AAAAAAAA-BBBB-CCCC-DDDD-111111111111",
    );
  });

  it("extracts matter_id + guid from the detail URL", () => {
    const rows = parseLegistarSearchPage(read("search.html"), SEARCH_URL);
    expect(rows[1]).toMatchObject({
      file_no: "260296",
      matter_id: "6789013",
      matter_guid: "AAAAAAAA-BBBB-CCCC-DDDD-222222222222",
      type: "Ordinance",
    });
  });

  it("preserves the type column so the caller can filter for Ordinance", () => {
    const rows = parseLegistarSearchPage(read("search.html"), SEARCH_URL);
    expect(rows.filter((r) => r.type === "Ordinance")).toHaveLength(3);
    expect(rows.filter((r) => r.type === "Resolution")).toHaveLength(1);
  });

  it("throws if the rgMasterTable is missing", () => {
    expect(() => parseLegistarSearchPage("<html><body>nope</body></html>", SEARCH_URL)).toThrow(
      LegistarParseError,
    );
  });

  it("throws if a required column header is missing", () => {
    const broken = `<table class="rgMasterTable"><thead><tr><th>File #</th><th>Type</th></tr></thead><tbody></tbody></table>`;
    expect(() => parseLegistarSearchPage(broken, SEARCH_URL)).toThrow(/required column/);
  });

  // Live Legistar emits `File&nbsp;#` (and similar NBSP-spaced labels)
  // inside the search-grid <th>. cheerio decodes the entity to U+00A0,
  // which String.prototype.trim() leaves in place, so an exact-match
  // against the literal "File #" used to throw "required column missing"
  // before the parser collapsed runs of whitespace.
  it("accepts NBSP-spaced column headers (Legistar emits 'File&nbsp;#')", () => {
    const html = `
      <table class="rgMasterTable">
        <thead><tr>
          <th>File&nbsp;#</th>
          <th>Type</th>
          <th>Status</th>
          <th>Title</th>
        </tr></thead>
        <tbody>
          <tr>
            <td><a href="LegislationDetail.aspx?ID=6789012&GUID=AAAAAAAA-BBBB-CCCC-DDDD-111111111111">260217</a></td>
            <td>Ordinance</td>
            <td>Pending Committee Hearing</td>
            <td>A title</td>
          </tr>
        </tbody>
      </table>
    `;
    const rows = parseLegistarSearchPage(html, SEARCH_URL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.file_no).toBe("260217");
    expect(rows[0]?.type).toBe("Ordinance");
  });
});

describe("parseLegistarDetailPage", () => {
  const DETAIL_URL = "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789012&GUID=AAAA";

  it("extracts all label fields from a multi-sponsor detail page", () => {
    const detail = parseLegistarDetailPage(read("detail-260217.html"), DETAIL_URL);
    expect(detail.short_title).toBe(
      "Multi-code update to Administrative, Building, Health, Police, Planning Codes",
    );
    expect(detail.long_title).toContain("Ordinance amending");
    expect(detail.legistar_status).toBe("Pending Committee Hearing");
    expect(detail.sponsor).toBe("Sup. Walton (District 10), Sup. Mar (District 4)");
    expect(detail.introduced_at).toBe("2026-05-15");
  });

  it("returns multiple attachments in document order with parsed View.ashx IDs", () => {
    const detail = parseLegistarDetailPage(read("detail-260217.html"), DETAIL_URL);
    expect(detail.attachments).toHaveLength(2);
    expect(detail.attachments[0]).toMatchObject({
      attachment_id: "9001001",
      label: "Leg Ver1",
    });
    expect(detail.attachments[1]).toMatchObject({
      attachment_id: "9001002",
      label: "Leg Ver2 - Committee Amendments",
    });
  });

  it("normalizes an empty sponsor sentinel (dash) to null", () => {
    const detail = parseLegistarDetailPage(read("detail-260296.html"), DETAIL_URL);
    expect(detail.sponsor).toBeNull();
  });

  it("returns null introduced_at when the label is blank", () => {
    const detail = parseLegistarDetailPage(read("detail-260296.html"), DETAIL_URL);
    expect(detail.introduced_at).toBeNull();
  });

  it("absolutizes View.ashx URLs against the detail page base", () => {
    const detail = parseLegistarDetailPage(read("detail-260541.html"), DETAIL_URL);
    expect(detail.attachments[0]?.view_url).toContain("https://sfgov.legistar.com/View.ashx");
  });

  it("throws when a required label is missing from the detail page", () => {
    const broken = `<html><body><span id="lblTitle">x</span></body></html>`;
    expect(() => parseLegistarDetailPage(broken, DETAIL_URL)).toThrow(LegistarParseError);
  });

  it("returns an empty action_history when the detail page omits a history table", () => {
    // detail-260217.html ships no tblHistory — parser must return [].
    const detail = parseLegistarDetailPage(read("detail-260217.html"), DETAIL_URL);
    expect(detail.action_history).toEqual([]);
  });

  it("parses action_history rows from the LegislationDetail history table", () => {
    const detail = parseLegistarDetailPage(read("detail-260700-enacted.html"), DETAIL_URL);
    expect(detail.action_history.length).toBeGreaterThan(0);
    const dates = detail.action_history.map((r) => r.date);
    expect(dates).toEqual(["2026-02-03", "2026-03-10", "2026-03-24", "2026-04-03", "2026-05-03"]);
    const signedRow = detail.action_history.find((r) => /Signed by Mayor/.test(r.action));
    expect(signedRow?.date).toBe("2026-04-03");
  });
});

describe("extractLegistarSearchForm", () => {
  it("collects every hidden input from the search-page form", () => {
    const form = extractLegistarSearchForm(read("search.html"), SEARCH_URL);
    expect(form.hidden.__VIEWSTATE).toBe("FIXTURE-VIEWSTATE-token");
    expect(form.hidden.__VIEWSTATEGENERATOR).toBe("FEB39A26");
    expect(form.hidden.__EVENTVALIDATION).toBe("FIXTURE-EVENTVALIDATION");
  });

  it("absolutizes the form action against the base url", () => {
    const form = extractLegistarSearchForm(read("search.html"), SEARCH_URL);
    expect(form.actionUrl).toBe("https://sfgov.legistar.com/Legislation.aspx");
  });

  it("throws when the page has no __VIEWSTATE — likely wrong endpoint", () => {
    const broken = `<html><body><form><input type="hidden" name="other" value="x"/></form></body></html>`;
    expect(() => extractLegistarSearchForm(broken, SEARCH_URL)).toThrow(/__VIEWSTATE/);
  });

  it("throws when the page has no <form>", () => {
    expect(() => extractLegistarSearchForm("<html><body>nope</body></html>", SEARCH_URL)).toThrow(
      /no <form>/,
    );
  });
});

describe("buildLegistarSearchSubmission", () => {
  it("targets the magnifying-glass button and forwards __VIEWSTATE", () => {
    const form = extractLegistarSearchForm(read("search.html"), SEARCH_URL);
    const body = buildLegistarSearchSubmission(form);
    expect(body.get("__EVENTTARGET")).toBe("ctl00$ContentPlaceHolder1$btnSearch");
    expect(body.get("__VIEWSTATE")).toBe("FIXTURE-VIEWSTATE-token");
  });

  it("sets default year=All Years and type=Ordinance with chkID=on", () => {
    const form = extractLegistarSearchForm(read("search.html"), SEARCH_URL);
    const body = buildLegistarSearchSubmission(form);
    expect(body.get("ctl00$ContentPlaceHolder1$lstYears_Input")).toBe("All Years");
    expect(body.get("ctl00$ContentPlaceHolder1$lstTypeBasic_Input")).toBe("Ordinance");
    expect(body.get("ctl00$ContentPlaceHolder1$chkID")).toBe("on");
  });

  it("encodes the RadComboBox ClientState as JSON the postback handler accepts", () => {
    const form = extractLegistarSearchForm(read("search.html"), SEARCH_URL);
    const body = buildLegistarSearchSubmission(form, { type: "Resolution" });
    const state = body.get("ctl00_ContentPlaceHolder1_lstTypeBasic_ClientState");
    expect(state).not.toBeNull();
    const parsed = JSON.parse(state ?? "{}");
    expect(parsed).toMatchObject({
      value: "Resolution",
      text: "Resolution",
      enabled: true,
    });
  });
});

describe("pickLatestLegVer", () => {
  it("picks the highest-N Leg Ver across multiple attachments", () => {
    const detail = parseLegistarDetailPage(read("detail-260217.html"), "https://e/d");
    const pick = pickLatestLegVer(detail.attachments);
    expect(pick?.attachment_id).toBe("9001002");
    expect(pick?.label).toContain("Leg Ver2");
  });

  it("returns null when the attachments list is empty", () => {
    expect(pickLatestLegVer([])).toBeNull();
  });

  it("falls back to the first non-tagged attachment when no Leg Ver labels exist", () => {
    const fallback = [
      {
        attachment_id: "1",
        attachment_guid: "g",
        label: "Resolution Body",
        view_url: "https://e/v",
      },
    ];
    expect(pickLatestLegVer(fallback)?.attachment_id).toBe("1");
  });
});
