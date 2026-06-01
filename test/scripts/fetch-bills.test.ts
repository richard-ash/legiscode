import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJurisdictionManifest } from "@/types/validate";
import {
  buildPdfCachePath,
  fetchPendingBills,
  type HttpClient,
  makeHttpClient,
  parseArgs,
  sha256Hex,
} from "../../scripts/fetch-bills";

const FIXTURE_HTML = join(import.meta.dirname, "..", "fixtures", "sf", "legistar-html");

const SEARCH_URL = "https://sfgov.legistar.com/Legislation.aspx";

async function loadFixture(name: string): Promise<string> {
  return readFile(join(FIXTURE_HTML, name), "utf8");
}

type TextCall = { url: string; method: "GET" | "POST"; body: string | null };

class StubHttp implements HttpClient {
  readonly textCalls: TextCall[] = [];
  readonly byteCalls: string[] = [];
  constructor(
    private readonly textMap: Record<string, string>,
    private readonly byteMap: Record<string, Uint8Array>,
  ) {}
  async fetchText(url: string, init?: RequestInit): Promise<string> {
    const method = (init?.method ?? "GET") as "GET" | "POST";
    const body = typeof init?.body === "string" ? init.body : null;
    this.textCalls.push({ url, method, body });
    const hit = this.textMap[url];
    if (hit === undefined) throw new Error(`no stub for text url: ${url}`);
    return hit;
  }
  async fetchBytes(url: string): Promise<Uint8Array> {
    this.byteCalls.push(url);
    const hit = this.byteMap[url];
    if (hit === undefined) throw new Error(`no stub for bytes url: ${url}`);
    return hit;
  }
}

const MANIFEST_PATH = join(import.meta.dirname, "..", "..", "manifests", "sf", "jurisdiction.json");

describe("parseArgs", () => {
  it("requires --manifest", () => {
    expect(parseArgs([])).toEqual({ error: "missing required --manifest" });
  });

  it("rejects --max-matters of zero", () => {
    expect(parseArgs(["--manifest", "m.json", "--max-matters", "0"])).toEqual({
      error: '--max-matters requires a positive integer, got "0"',
    });
  });

  it("returns defaults when only --manifest is given", () => {
    const parsed = parseArgs(["--manifest", "m.json"]);
    expect(parsed).toMatchObject({
      manifest: "m.json",
      output: "build/downloads/bills",
      maxMatters: null,
      userAgent: "legiscode-fetch/0.1",
    });
  });
});

describe("buildPdfCachePath", () => {
  it("composes filename from attachment_id + guid8 + sha16", () => {
    const path = buildPdfCachePath({
      outputDir: "/tmp/out",
      attachmentId: "9001002",
      matterGuid: "AAAAAAAA-BBBB-CCCC-DDDD-111111111111",
      contentSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    expect(path).toBe("/tmp/out/pdfs/9001002-aaaaaaaa-0123456789abcdef.pdf");
  });
});

describe("sha256Hex", () => {
  it("produces the canonical hex digest", () => {
    expect(sha256Hex(new Uint8Array([0]))).toBe(
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    );
  });
});

describe("makeHttpClient retry behavior", () => {
  it("retries on 5xx then succeeds, respecting the backoff schedule", async () => {
    const recordedSleeps: number[] = [];
    let attempt = 0;
    const fetchMock = async (): Promise<Response> => {
      attempt++;
      if (attempt < 3) return new Response("oops", { status: 503 });
      return new Response("ok", { status: 200 });
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const http = makeHttpClient({
        userAgent: "test",
        rateLimitMs: 0,
        backoffSchedule: [10, 20, 40],
        sleep: async (ms) => {
          recordedSleeps.push(ms);
        },
      });
      const text = await http.fetchText("https://x.example/path");
      expect(text).toBe("ok");
      // Sleeps come from: 3× waitForSlot (each is ≤0) + 2× backoff (10, 20)
      expect(recordedSleeps.filter((m) => m > 0)).toEqual([10, 20]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails fast on 4xx non-429 without consuming the backoff schedule", async () => {
    const recordedSleeps: number[] = [];
    const fetchMock = async (): Promise<Response> => new Response("nope", { status: 404 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const http = makeHttpClient({
        userAgent: "test",
        rateLimitMs: 0,
        backoffSchedule: [10, 20, 40],
        sleep: async (ms) => {
          recordedSleeps.push(ms);
        },
      });
      await expect(http.fetchText("https://x.example/path")).rejects.toThrow(/HTTP 404/);
      // No backoff sleeps (only the wait-for-slot which was 0).
      expect(recordedSleeps.filter((m) => m > 0)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("fetchPendingBills end-to-end (hermetic, stub HTTP)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "legiscode-fetch-bills-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes one BillMeta per Ordinance matter and caches the latest Leg Ver PDF", async () => {
    const manifest = await readJurisdictionManifest(MANIFEST_PATH);
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
    const http = new StubHttp(
      {
        [SEARCH_URL]: await loadFixture("search.html"),
        "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789012&GUID=AAAAAAAA-BBBB-CCCC-DDDD-111111111111":
          await loadFixture("detail-260217.html"),
        "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789013&GUID=AAAAAAAA-BBBB-CCCC-DDDD-222222222222":
          await loadFixture("detail-260296.html"),
        "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789014&GUID=AAAAAAAA-BBBB-CCCC-DDDD-333333333333":
          await loadFixture("detail-260541.html"),
      },
      {
        // Latest-version PDFs only — pickLatestLegVer chooses Leg Ver2 for 260217.
        "https://sfgov.legistar.com/View.ashx?M=F&ID=9001002&GUID=AAAAAAAA-BBBB-CCCC-DDDD-A22A22A22A22":
          pdfBytes,
        "https://sfgov.legistar.com/View.ashx?M=F&ID=9002001&GUID=AAAAAAAA-BBBB-CCCC-DDDD-B11B11B11B11":
          pdfBytes,
        "https://sfgov.legistar.com/View.ashx?M=F&ID=9003001&GUID=AAAAAAAA-BBBB-CCCC-DDDD-C11C11C11C11":
          pdfBytes,
      },
    );

    const index = await fetchPendingBills({
      searchUrl: SEARCH_URL,
      manifest,
      outputDir: tmpDir,
      maxMatters: null,
      deps: { http, now: () => new Date("2026-05-30T10:00:00-07:00") },
    });

    // Resolution row in the search fixture is filtered out — only the 3 Ordinance matters.
    expect(index.bills).toHaveLength(3);
    expect(index.source_url).toBe(SEARCH_URL);
    const fileNos = index.bills.map((b) => b.file_no);
    expect(fileNos).toEqual(["260217", "260296", "260541"]);

    // 260217 should pick the Leg Ver2 attachment.
    const m217 = index.bills.find((b) => b.file_no === "260217");
    expect(m217?.attachment_id).toBe("9001002");
    expect(m217?.title_class).toBe("A");
    expect(m217?.touched_modules).toContain("sf-administrative");
    expect(m217?.touched_modules).toContain("sf-planning");

    // 260541 is a Class B waiver — no touched modules even though body
    // mentions Public Works.
    const m541 = index.bills.find((b) => b.file_no === "260541");
    expect(m541?.title_class).toBe("B");
    expect(m541?.touched_modules).toEqual([]);

    // 260296 has the "-" sponsor sentinel → null sponsor.
    const m296 = index.bills.find((b) => b.file_no === "260296");
    expect(m296?.sponsor).toBeNull();
    expect(m296?.introduced_at).toBeNull();

    // Cached PDFs land under pdfs/ with the canonical id-guid-sha filename.
    const pdfs = await readdir(join(tmpDir, "pdfs"));
    expect(pdfs).toHaveLength(3);
    expect(pdfs.every((n) => /^\d+-[0-9a-f]{1,8}-[0-9a-f]{16}\.pdf$/.test(n))).toBe(true);
  });

  it("re-uses an existing cache entry on the second run (no re-download)", async () => {
    const manifest = await readJurisdictionManifest(MANIFEST_PATH);
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

    // Pre-seed the cache: write the file under the expected canonical name.
    const sha = sha256Hex(pdfBytes);
    const cachePath = buildPdfCachePath({
      outputDir: tmpDir,
      attachmentId: "9003001",
      matterGuid: "AAAAAAAA-BBBB-CCCC-DDDD-333333333333",
      contentSha256: sha,
    });
    await (await import("node:fs/promises")).mkdir(join(tmpDir, "pdfs"), { recursive: true });
    await writeFile(cachePath, pdfBytes);

    // Search returns only the 260541 row; detail provides the matching attachment.
    const http = new StubHttp(
      {
        [SEARCH_URL]: `
          <form action="./Legislation.aspx">
            <input type="hidden" name="__VIEWSTATE" value="V" />
            <input type="hidden" name="__VIEWSTATEGENERATOR" value="G" />
            <table class="rgMasterTable">
              <thead><tr><th>File #</th><th>Type</th><th>Status</th><th>Title</th></tr></thead>
              <tbody>
                <tr>
                  <td><a href="LegislationDetail.aspx?ID=6789014&GUID=AAAAAAAA-BBBB-CCCC-DDDD-333333333333">260541</a></td>
                  <td>Ordinance</td>
                  <td>Pending - Public Works Committee</td>
                  <td>Public works waiver authorization</td>
                </tr>
              </tbody>
            </table>
          </form>`,
        "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789014&GUID=AAAAAAAA-BBBB-CCCC-DDDD-333333333333":
          await loadFixture("detail-260541.html"),
      },
      {
        // Empty bytes map — any call to fetchBytes should throw, proving the cache hit.
      },
    );

    const index = await fetchPendingBills({
      searchUrl: SEARCH_URL,
      manifest,
      outputDir: tmpDir,
      maxMatters: null,
      deps: { http, now: () => new Date("2026-05-30T10:00:00-07:00") },
    });

    expect(http.byteCalls).toEqual([]);
    expect(index.bills).toHaveLength(1);
    expect(index.bills[0]?.pdf_cache_path).toBe(cachePath);
    expect(index.bills[0]?.attachment_content_hash).toBe(sha.slice(0, 16));
  });

  it("respects --max-matters by capping the number of detail fetches", async () => {
    const manifest = await readJurisdictionManifest(MANIFEST_PATH);
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const http = new StubHttp(
      {
        [SEARCH_URL]: await loadFixture("search.html"),
        "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789012&GUID=AAAAAAAA-BBBB-CCCC-DDDD-111111111111":
          await loadFixture("detail-260217.html"),
      },
      {
        "https://sfgov.legistar.com/View.ashx?M=F&ID=9001002&GUID=AAAAAAAA-BBBB-CCCC-DDDD-A22A22A22A22":
          pdfBytes,
      },
    );

    const index = await fetchPendingBills({
      searchUrl: SEARCH_URL,
      manifest,
      outputDir: tmpDir,
      maxMatters: 1,
      deps: { http, now: () => new Date("2026-05-30T10:00:00-07:00") },
    });

    expect(index.bills).toHaveLength(1);
    expect(index.bills[0]?.file_no).toBe("260217");
    // The search URL is hit twice (GET form + POST submission), then one
    // LegislationDetail GET for the only processed matter. Calls for 260296
    // and 260541 never happen because --max-matters caps the fan-out.
    expect(http.textCalls).toHaveLength(3);
    expect(http.textCalls.slice(0, 2).map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("submits the search form via POST to populate the rgMasterTable", async () => {
    const manifest = await readJurisdictionManifest(MANIFEST_PATH);
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const http = new StubHttp(
      {
        [SEARCH_URL]: await loadFixture("search.html"),
        "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789012&GUID=AAAAAAAA-BBBB-CCCC-DDDD-111111111111":
          await loadFixture("detail-260217.html"),
        "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789013&GUID=AAAAAAAA-BBBB-CCCC-DDDD-222222222222":
          await loadFixture("detail-260296.html"),
        "https://sfgov.legistar.com/LegislationDetail.aspx?ID=6789014&GUID=AAAAAAAA-BBBB-CCCC-DDDD-333333333333":
          await loadFixture("detail-260541.html"),
      },
      {
        "https://sfgov.legistar.com/View.ashx?M=F&ID=9001002&GUID=AAAAAAAA-BBBB-CCCC-DDDD-A22A22A22A22":
          pdfBytes,
        "https://sfgov.legistar.com/View.ashx?M=F&ID=9002001&GUID=AAAAAAAA-BBBB-CCCC-DDDD-B11B11B11B11":
          pdfBytes,
        "https://sfgov.legistar.com/View.ashx?M=F&ID=9003001&GUID=AAAAAAAA-BBBB-CCCC-DDDD-C11C11C11C11":
          pdfBytes,
      },
    );

    await fetchPendingBills({
      searchUrl: SEARCH_URL,
      manifest,
      outputDir: tmpDir,
      maxMatters: null,
      deps: { http, now: () => new Date("2026-05-30T10:00:00-07:00") },
    });

    // First two calls are the search handshake: GET the form, then POST the
    // submission with __EVENTTARGET=btnSearch + chkID=on. The remaining
    // calls are the LegislationDetail GETs for each matter.
    expect(http.textCalls[0]?.method).toBe("GET");
    expect(http.textCalls[0]?.url).toBe(SEARCH_URL);
    expect(http.textCalls[1]?.method).toBe("POST");
    expect(http.textCalls[1]?.url).toBe(SEARCH_URL);
    const postBody = http.textCalls[1]?.body ?? "";
    expect(postBody).toContain("__EVENTTARGET=ctl00%24ContentPlaceHolder1%24btnSearch");
    expect(postBody).toContain("__VIEWSTATE=FIXTURE-VIEWSTATE-token");
    expect(postBody).toContain("chkID=on");
    expect(postBody).toContain("lstTypeBasic_Input=Ordinance");
  });
});
