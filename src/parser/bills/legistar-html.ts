// Pure parsers for the Legistar legislation-search + legislation-detail
// HTML pages. Extracted from scripts/fetch-bills.ts so the structural
// transforms can be tested hermetically against committed HTML fixtures
// while the orchestrator (HTTP + cache + rate-limit) stays operator-driven.
//
// These parsers know nothing about HTTP, files, or time. Inputs are HTML
// strings; outputs are typed POJOs the caller assembles into BillMeta rows.
// Schema validation happens in the caller — these functions return raw
// strings (possibly null) so the caller can attach scrape-time context
// (scraped_at, source URL) before validating.

import * as cheerio from "cheerio";

export type SearchPageRow = {
  /** Legistar internal matter ID (NOT file_no). Half of the cache key. */
  matter_id: string;
  /** GUID that pairs with matter_id in the LegislationDetail URL. */
  matter_guid: string;
  /** Display file_no — "260217". Stable across Leg Ver{N} versions. */
  file_no: string;
  /** Matter type — filtered to "Ordinance" by the caller. */
  type: string;
  /** Free-text status from the search row — also re-read on detail. */
  status: string;
  /** Short title from the search row. */
  short_title: string;
  /** Absolute URL the caller follows for the LegislationDetail hop. */
  detail_url: string;
};

export class LegistarParseError extends Error {
  constructor(
    readonly page: "search" | "detail",
    message: string,
  ) {
    super(`legistar ${page}: ${message}`);
    this.name = "LegistarParseError";
  }
}

// Legistar's legislation search results table is rendered as a server-
// generated `<table class="rgMasterTable">` (Telerik RadGrid). The
// production page has a single such table per response; if the layout
// drifts we want to fail loudly here, not silently emit zero rows.
export function parseLegistarSearchPage(html: string, baseUrl: string): SearchPageRow[] {
  const $ = cheerio.load(html);
  const table = $("table.rgMasterTable").first();
  if (table.length === 0) {
    throw new LegistarParseError("search", "no rgMasterTable found — page structure changed");
  }
  // Collapse every run of whitespace (including the NBSP that Legistar
  // emits inside "File&nbsp;#") into a single regular space so the
  // comparison against the required-column literals isn't tripped by
  // unicode whitespace the trim() pass leaves in place.
  const headerCells = table
    .find("thead th")
    .toArray()
    .map((th) => $(th).text().replace(/\s+/g, " ").trim());
  // The search-grid columns are operator-configurable in Legistar but the
  // SF deployment ships a consistent header order. Assert the columns we
  // depend on are present so a Legistar config change surfaces at parse
  // time instead of silently shifting which column we read.
  const required = ["File #", "Type", "Status", "Title"];
  for (const col of required) {
    if (!headerCells.some((h) => h.toLowerCase() === col.toLowerCase())) {
      throw new LegistarParseError(
        "search",
        `required column "${col}" missing from header (got: ${headerCells.join(" | ")})`,
      );
    }
  }
  const colIndex = (label: string): number =>
    headerCells.findIndex((h) => h.toLowerCase() === label.toLowerCase());
  const idxFileNo = colIndex("File #");
  const idxType = colIndex("Type");
  const idxStatus = colIndex("Status");
  const idxTitle = colIndex("Title");

  const rows: SearchPageRow[] = [];
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td").toArray();
    if (cells.length < headerCells.length) return;
    const fileLink = $(cells[idxFileNo]).find("a").first();
    const detailHref = fileLink.attr("href") ?? "";
    const detailUrl = absolutizeUrl(detailHref, baseUrl);
    const { matterId, guid } = extractDetailIdGuid(detailUrl);
    if (matterId === null || guid === null) {
      // The grid sometimes includes a header-spacer row with no link; skip
      // those silently. A genuine data row with no link would be a Legistar
      // bug worth flagging, but we don't have a way to distinguish without
      // false positives.
      return;
    }
    rows.push({
      matter_id: matterId,
      matter_guid: guid,
      file_no: fileLink.text().trim(),
      type: $(cells[idxType]).text().trim(),
      status: $(cells[idxStatus]).text().trim(),
      short_title: $(cells[idxTitle]).text().trim().replace(/\s+/g, " "),
      detail_url: detailUrl,
    });
  });
  return rows;
}

// Live Legistar's Legislation.aspx is an ASP.NET WebForms page that returns
// an empty rgMasterTable on a bare GET — the grid populates only when the
// page is POSTed back with the user's search submission (the magnifying-
// glass button targets ctl00$ContentPlaceHolder1$btnSearch). Two helpers
// below let the fetcher do the GET → harvest hidden inputs → POST handshake
// against the live site without inventing a parallel HTTP client.

export type LegistarSearchForm = {
  /** Absolute URL to POST the search submission to (form action). */
  actionUrl: string;
  /** Every <input type="hidden"> on the page, keyed by name. Includes
   *  __VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION which ASP.NET
   *  rejects the POST without. */
  hidden: Record<string, string>;
};

// Extract the hidden inputs and form action from the Legistar search page.
// Pure parser — does not perform HTTP. The caller stitches the result into
// a POST submission via buildLegistarSearchSubmission.
export function extractLegistarSearchForm(html: string, baseUrl: string): LegistarSearchForm {
  const $ = cheerio.load(html);
  const form = $("form").first();
  if (form.length === 0) {
    throw new LegistarParseError("search", "no <form> found — page structure changed");
  }
  const hidden: Record<string, string> = {};
  form.find("input[type='hidden']").each((_, el) => {
    const name = $(el).attr("name");
    if (typeof name !== "string" || name.length === 0) return;
    hidden[name] = $(el).attr("value") ?? "";
  });
  // __VIEWSTATE is server-signed; without it the POST is rejected as a
  // forged cross-page submission. Fail loudly if the page didn't ship one
  // — almost certainly the URL pointed at the wrong endpoint.
  if (typeof hidden.__VIEWSTATE !== "string" || hidden.__VIEWSTATE.length === 0) {
    throw new LegistarParseError(
      "search",
      "form is missing __VIEWSTATE — POST handshake won't work",
    );
  }
  const action = form.attr("action") ?? baseUrl;
  return { actionUrl: absolutizeUrl(action, baseUrl), hidden };
}

// Build the body for the POST that submits the search form. SF Legistar's
// Telerik RadGrid only returns rows when chkID is checked (the visible UI
// checks it by default but the bare GET ships it unchecked); the year and
// type RadComboBoxes need both an _Input value and a _ClientState JSON to
// be accepted by the postback handler.
export function buildLegistarSearchSubmission(
  form: LegistarSearchForm,
  opts: { year?: string; type?: string } = {},
): URLSearchParams {
  const year = opts.year ?? "All Years";
  const type = opts.type ?? "Ordinance";
  const body = new URLSearchParams(form.hidden);
  body.set("__EVENTTARGET", "ctl00$ContentPlaceHolder1$btnSearch");
  body.set("__EVENTARGUMENT", "");
  body.set("ctl00$ContentPlaceHolder1$txtSearch", "");
  body.set("ctl00$ContentPlaceHolder1$lstYears_Input", year);
  body.set("ctl00_ContentPlaceHolder1_lstYears_ClientState", radComboBoxClientState(year));
  body.set("ctl00$ContentPlaceHolder1$lstTypeBasic_Input", type);
  body.set("ctl00_ContentPlaceHolder1_lstTypeBasic_ClientState", radComboBoxClientState(type));
  // chkID is the "Match in: File #" toggle; on=true is what the live UI
  // sends, and the server returns zero rows without it even when the year
  // and type filters are set.
  body.set("ctl00$ContentPlaceHolder1$chkID", "on");
  body.set("ctl00$ContentPlaceHolder1$chkText", "on");
  body.set("ctl00$ContentPlaceHolder1$chkOther", "on");
  body.set("ctl00$ContentPlaceHolder1$chkAttachments", "on");
  return body;
}

function radComboBoxClientState(text: string): string {
  return JSON.stringify({
    logEntries: [],
    value: text,
    text,
    enabled: true,
    checkedIndices: [],
    checkedItemsTextOverflows: false,
  });
}

export type DetailAttachment = {
  /** Numeric attachment ID inside View.ashx URL. */
  attachment_id: string;
  /** GUID that pairs with attachment_id for the View.ashx download. */
  attachment_guid: string;
  /** Display label — drives "Leg Ver{N}" version selection. */
  label: string;
  /** Absolute View.ashx URL the caller hands to the HTTP layer. */
  view_url: string;
};

export type DetailPage = {
  /** Page heading h1 — used as short_title. */
  short_title: string;
  /** lblTitle2 — long-form title used by scope-filter. */
  long_title: string;
  /** Pending status free-text. */
  legistar_status: string;
  /** Sponsor display, or null when omitted. */
  sponsor: string | null;
  /** ISO date or null when omitted. */
  introduced_at: string | null;
  /** All attachment rows in the order Legistar lists them. */
  attachments: DetailAttachment[];
};

// LegislationDetail renders inside an asp.net master page. The label cells
// follow a paired naming convention: `_lblFoo` holds the literal label
// ("Title:", "Status:") and `_lblFoo2` holds the value. We read from the
// value-bearing `_2` IDs and use attribute-ends-with selectors so any
// master-page rename in a sibling Legistar deployment doesn't break us.
// Sponsors are optional on the SF page — appropriations and mayoral
// requests skip the sponsors row entirely — so `_lblSponsors2` may be
// absent and the parser accepts null in that case.
export function parseLegistarDetailPage(html: string, baseUrl: string): DetailPage {
  const $ = cheerio.load(html);
  const shortTitle = readLabel($, "lblName2");
  const longTitle = readLabel($, "lblTitle2");
  const status = readLabel($, "lblStatus2");
  if (shortTitle === null || longTitle === null || status === null) {
    throw new LegistarParseError(
      "detail",
      `required labels missing (short=${shortTitle !== null}, long=${longTitle !== null}, status=${status !== null})`,
    );
  }
  const sponsorRaw = readLabel($, "lblSponsors2");
  const introducedRaw = readLabel($, "lblIntroduced2");
  const sponsor = normalizeSponsor(sponsorRaw);
  const introduced_at = parseLegistarDate(introducedRaw);

  const attachments: DetailAttachment[] = [];
  $("a[href*='View.ashx']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const viewUrl = absolutizeUrl(href, baseUrl);
    const { id, guid } = extractViewAshxIdGuid(viewUrl);
    if (id === null || guid === null) return;
    attachments.push({
      attachment_id: id,
      attachment_guid: guid,
      label: $(el).text().trim(),
      view_url: viewUrl,
    });
  });

  return {
    short_title: shortTitle,
    long_title: longTitle,
    legistar_status: status,
    sponsor,
    introduced_at,
    attachments,
  };
}

// Pick the latest Leg Ver{N} attachment from a LegislationDetail page.
// Falls back to the first non-tagged attachment if no Leg Ver labels exist
// — some matters ship a single anonymous PDF. Returns null when no PDF
// attachment is available at all (which the caller treats as a Class B
// matter with no parse output).
export function pickLatestLegVer(
  attachments: readonly DetailAttachment[],
): DetailAttachment | null {
  // Match "Leg Ver1", "Leg Ver2", etc. case-insensitive with optional
  // " - " separator and arbitrary tail.
  let best: { attachment: DetailAttachment; version: number } | null = null;
  const fallbacks: DetailAttachment[] = [];
  for (const att of attachments) {
    const m = /\bLeg\s+Ver\s*(\d+)\b/i.exec(att.label);
    if (m === null) {
      fallbacks.push(att);
      continue;
    }
    const version = Number(m[1]);
    if (!Number.isFinite(version)) continue;
    if (best === null || version > best.version) {
      best = { attachment: att, version };
    }
  }
  if (best !== null) return best.attachment;
  return fallbacks[0] ?? null;
}

// ── Internals ────────────────────────────────────────────────────────────

function readLabel($: cheerio.CheerioAPI, suffix: string): string | null {
  const node = $(`span[id$='_${suffix}']`).first();
  if (node.length === 0) return null;
  const text = node.text().trim();
  return text.length > 0 ? text.replace(/\s+/g, " ") : null;
}

function normalizeSponsor(raw: string | null): string | null {
  if (raw === null) return null;
  // Legistar joins multi-sponsor entries with comma+space. Treat the first
  // sponsor as primary; downstream UI shows "Sup. X +N" when needed (the
  // raw string is preserved here in case a renderer wants the full list).
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "-") return null;
  return trimmed;
}

function parseLegistarDate(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  // Legistar emits dates as "M/D/YYYY". Convert to ISO YYYY-MM-DD.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  const mm = m[1].padStart(2, "0");
  const dd = m[2].padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}

function absolutizeUrl(href: string, base: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    // Malformed href — return as-is so the caller can flag it.
    return href;
  }
}

function extractDetailIdGuid(url: string): { matterId: string | null; guid: string | null } {
  try {
    const u = new URL(url);
    return {
      matterId: u.searchParams.get("ID"),
      guid: u.searchParams.get("GUID"),
    };
  } catch {
    return { matterId: null, guid: null };
  }
}

function extractViewAshxIdGuid(url: string): { id: string | null; guid: string | null } {
  try {
    const u = new URL(url);
    return {
      id: u.searchParams.get("ID"),
      guid: u.searchParams.get("GUID"),
    };
  } catch {
    return { id: null, guid: null };
  }
}
