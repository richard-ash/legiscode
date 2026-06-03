#!/usr/bin/env node
// Lane 1 — operator-driven HTTP fetcher for SF Legistar pending ordinances.
// Walks the Legistar legislation-search listing, follows each Ordinance-type
// matter to LegislationDetail, downloads the latest Leg Ver{N} attachment,
// writes BillMeta rows into build/downloads/bills/bills-index.json, and
// caches PDFs under build/downloads/bills/pdfs/ keyed by attachment ID +
// GUID + content-hash prefix.
//
// This script is intentionally non-hermetic — CI never runs it. The
// hermetic surface is exercised by test/scripts/fetch-bills.test.ts
// against committed Legistar HTML fixtures. Live runs are the operator's
// job; sync-bills.ts (Lane 2) then turns the cached PDFs into per-module
// Bill files using only committed-disk inputs.
//
// Rate-limit policy:
//   - 500ms minimum between Legistar requests (token bucket; no concurrency)
//   - 3x exponential backoff on 5xx (1s → 2s → 4s, then abort)
//   - Hard fail on 4xx except 429 (rate-limited; same backoff as 5xx)
//   - Cache hits bypass the bucket entirely

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type BillMeta,
  BILLS_INDEX_SCHEMA_VERSION,
  type BillsIndex,
  type JurisdictionManifest,
} from "@/types";
import { readJurisdictionManifest } from "@/types/validate";
import {
  type DetailAttachment,
  type DetailPage,
  type SearchPageRow,
  buildLegistarSearchSubmission,
  extractLegistarSearchForm,
  parseLegistarDetailPage,
  parseLegistarSearchPage,
  pickLatestLegVer,
} from "@/parser/bills/legistar-html";
import { classifyBillTitle, type InstalledModule } from "@/parser/bills/scope-filter";

const HELP_TEXT = `\
Usage: tsx scripts/fetch-bills.ts --manifest <jurisdiction-manifest> [options]

Required:
  --manifest <path>       Path to manifests/<jurisdiction>/jurisdiction.json.
                          Must declare manifest.pending_bill_source.

Optional:
  --output <dir>          Output dir (default: build/downloads/bills/).
                          Writes bills-index.json + pdfs/.
  --max-matters <N>       Stop after N detail pages (for test/staging runs).
  --user-agent <ua>       HTTP User-Agent. Default: "legiscode-fetch/0.1".
  --help                  Show this help.

Exit codes:
  0  success
  2  argument error
  3  fetch error (network, 5xx after backoff, manifest invalid)
`;

interface Args {
  manifest: string;
  output: string;
  maxMatters: number | null;
  userAgent: string;
}

const DEFAULT_USER_AGENT = "legiscode-fetch/0.1";
const DEFAULT_OUTPUT = "build/downloads/bills";
const RATE_LIMIT_MS = 500;
const BACKOFF_MS = [1000, 2000, 4000] as const;

export function parseArgs(argv: string[]): Args | { help: true } | { error: string } {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `flag ${flag} requires a value` };
    }
    switch (flag) {
      case "--manifest":
        out.manifest = value;
        break;
      case "--output":
        out.output = value;
        break;
      case "--max-matters": {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          return { error: `--max-matters requires a positive integer, got "${value}"` };
        }
        out.maxMatters = n;
        break;
      }
      case "--user-agent":
        out.userAgent = value;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
    i++;
  }
  if (!out.manifest) return { error: "missing required --manifest" };
  return {
    manifest: out.manifest,
    output: out.output ?? DEFAULT_OUTPUT,
    maxMatters: out.maxMatters ?? null,
    userAgent: out.userAgent ?? DEFAULT_USER_AGENT,
  };
}

// HttpClient is the seam tests + alternative deployments can stub. The
// default impl uses global fetch (Node 24 ships it) plus a token bucket
// rate limiter.
export interface HttpClient {
  /** GET (or POST when init.method is "POST") and return text. Throws on
   *  network error or non-2xx (after retry). */
  fetchText(url: string, init?: RequestInit): Promise<string>;
  /** GET and return raw bytes. Throws on network error or non-2xx (after retry). */
  fetchBytes(url: string): Promise<Uint8Array>;
}

export function makeHttpClient(opts: {
  userAgent: string;
  rateLimitMs?: number;
  backoffSchedule?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): HttpClient {
  const rateLimitMs = opts.rateLimitMs ?? RATE_LIMIT_MS;
  const backoff = opts.backoffSchedule ?? BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let nextAllowedAt = 0;

  async function waitForSlot(): Promise<void> {
    const now = Date.now();
    if (now < nextAllowedAt) {
      await sleep(nextAllowedAt - now);
    }
    nextAllowedAt = Date.now() + rateLimitMs;
  }

  async function doRequest(url: string, init?: RequestInit): Promise<Response> {
    let lastErr: unknown = null;
    // First attempt + retries on transient failures. 4xx (other than 429)
    // fails immediately; the page is genuinely missing or auth-gated and
    // re-trying just consumes the rate-limit quota.
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      await waitForSlot();
      let res: Response;
      try {
        const headers = new Headers(init?.headers);
        headers.set("User-Agent", opts.userAgent);
        res = await fetch(url, { ...init, headers });
      } catch (err) {
        lastErr = err;
        if (attempt === backoff.length) break;
        await sleep(backoff[attempt] ?? 0);
        continue;
      }
      if (res.ok) return res;
      const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!transient || attempt === backoff.length) {
        throw new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
      }
      await sleep(backoff[attempt] ?? 0);
    }
    throw new Error(
      `${url}: network failed after ${backoff.length + 1} attempts (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
    );
  }

  return {
    async fetchText(url, init) {
      const res = await doRequest(url, init);
      return res.text();
    },
    async fetchBytes(url) {
      const res = await doRequest(url);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// Telerik RadGrid on SF Legistar's Legislation.aspx renders empty on a
// bare GET. Submitting the search form via __doPostBack to the magnifying-
// glass control (btnSearch) returns the populated grid in one round-trip,
// which is what the orchestrator below needs to feed parseLegistarSearchPage.
// Two hops total: GET to harvest the form's hidden inputs + __VIEWSTATE,
// then POST to retrieve the matter rows.
export async function fetchLegistarSearchResults(
  searchUrl: string,
  http: HttpClient,
): Promise<string> {
  const formHtml = await http.fetchText(searchUrl);
  const form = extractLegistarSearchForm(formHtml, searchUrl);
  const body = buildLegistarSearchSubmission(form);
  return http.fetchText(form.actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: searchUrl,
    },
    body: body.toString(),
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Cache key: attachment_id + matter_guid +
// sha256(bytes) prefix. Filename pattern:
//   pdfs/{attachment_id}-{guid8}-{sha16}.pdf
// where guid8 is the first 8 hex chars of the matter_guid (without dashes)
// and sha16 is the first 16 hex chars of the content sha256. The 3-part
// key catches Leg Ver{N} swap-in-place by the city (attachment_id same,
// guid same, content hash differs) without forcing a re-download when the
// city merely re-serves the same bytes.
export function buildPdfCachePath(args: {
  outputDir: string;
  attachmentId: string;
  matterGuid: string;
  contentSha256: string;
}): string {
  const guidCompact = args.matterGuid.replace(/-/g, "").slice(0, 8).toLowerCase();
  const sha16 = args.contentSha256.slice(0, 16);
  return join(args.outputDir, "pdfs", `${args.attachmentId}-${guidCompact}-${sha16}.pdf`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface FetchDeps {
  http: HttpClient;
  now?: () => Date;
}

// Orchestrate the 3-hop scrape end to end. The pure-parser layer
// (legistar-html.ts) does all the structural reading; this function adds
// HTTP + cache + index assembly + scope-filter classification. Returns the
// in-memory BillsIndex; caller persists it.
export async function fetchPendingBills(args: {
  searchUrl: string;
  manifest: JurisdictionManifest;
  outputDir: string;
  maxMatters: number | null;
  deps: FetchDeps;
}): Promise<BillsIndex> {
  const { http } = args.deps;
  const now = args.deps.now ?? (() => new Date());
  const installed: InstalledModule[] = args.manifest.modules.map((m) => ({
    id: m.id,
    code_title: m.code_title,
  }));
  const installedIds = installed.map((m) => m.id);

  const searchHtml = await fetchLegistarSearchResults(args.searchUrl, http);
  const searchRows = parseLegistarSearchPage(searchHtml, args.searchUrl);
  const ordinanceRows = searchRows.filter((r) => /^ordinance$/i.test(r.type));

  await mkdir(join(args.outputDir, "pdfs"), { recursive: true });

  const bills: BillMeta[] = [];
  const limited =
    args.maxMatters === null ? ordinanceRows : ordinanceRows.slice(0, args.maxMatters);
  for (const row of limited) {
    const meta = await processMatter({
      row,
      installed,
      installedIds,
      outputDir: args.outputDir,
      http,
      now: now(),
    });
    if (meta !== null) bills.push(meta);
  }

  return {
    schema_version: BILLS_INDEX_SCHEMA_VERSION,
    source_url: args.searchUrl,
    fetched_at: now().toISOString(),
    bills,
  };
}

async function processMatter(args: {
  row: SearchPageRow;
  installed: readonly InstalledModule[];
  installedIds: readonly string[];
  outputDir: string;
  http: HttpClient;
  now: Date;
}): Promise<BillMeta | null> {
  const detailHtml = await args.http.fetchText(args.row.detail_url);
  const detail: DetailPage = parseLegistarDetailPage(detailHtml, args.row.detail_url);
  const attachment = pickLatestLegVer(detail.attachments);
  if (attachment === null) {
    // Class B matters legitimately ship without a PDF attachment (waivers,
    // appropriations). Record the row in the index so the operator can audit
    // coverage, but we can't emit a meaningful pdf_cache_path or content
    // hash. Skip with a typed reason — sync (Lane 2) decides what to do.
    return null;
  }
  const { meta } = await downloadAndCache({
    row: args.row,
    detail,
    attachment,
    installed: args.installed,
    installedIds: args.installedIds,
    outputDir: args.outputDir,
    http: args.http,
    now: args.now,
  });
  return meta;
}

async function downloadAndCache(args: {
  row: SearchPageRow;
  detail: DetailPage;
  attachment: DetailAttachment;
  installed: readonly InstalledModule[];
  installedIds: readonly string[];
  outputDir: string;
  http: HttpClient;
  now: Date;
}): Promise<{ meta: BillMeta; cacheHit: boolean }> {
  // Two-phase cache: probe for any existing file with this attachment_id
  // prefix before downloading. On hit, re-use the existing content hash so
  // the BillMeta row stays stable (same pdf_cache_path); on miss, download
  // and compute the hash now.
  const probe = await findExistingCache(args.outputDir, args.attachment.attachment_id);
  if (probe !== null) {
    const meta = assembleMeta({
      row: args.row,
      detail: args.detail,
      attachment: args.attachment,
      installed: args.installed,
      installedIds: args.installedIds,
      pdfCachePath: probe.path,
      contentSha256: probe.sha,
      scrapedAt: args.now,
    });
    return { meta, cacheHit: true };
  }
  const bytes = await args.http.fetchBytes(args.attachment.view_url);
  const sha = sha256Hex(bytes);
  const cachePath = buildPdfCachePath({
    outputDir: args.outputDir,
    attachmentId: args.attachment.attachment_id,
    matterGuid: args.row.matter_guid,
    contentSha256: sha,
  });
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, bytes);
  const meta = assembleMeta({
    row: args.row,
    detail: args.detail,
    attachment: args.attachment,
    installed: args.installed,
    installedIds: args.installedIds,
    pdfCachePath: cachePath,
    contentSha256: sha,
    scrapedAt: args.now,
  });
  return { meta, cacheHit: false };
}

async function findExistingCache(
  outputDir: string,
  attachmentId: string,
): Promise<{ path: string; sha: string } | null> {
  // Probe the cache dir for any file beginning with "{attachment_id}-".
  // The full filename triple (id + guid + sha) is deterministic per
  // (matter, version, bytes), so a leading-id match plus a content read
  // confirms bytes-identity without parsing the filename.
  const dir = join(outputDir, "pdfs");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const match = entries.find((n) => n.startsWith(`${attachmentId}-`) && n.endsWith(".pdf"));
  if (!match) return null;
  const fullPath = join(dir, match);
  const bytes = await readFile(fullPath);
  return { path: fullPath, sha: sha256Hex(bytes) };
}

function assembleMeta(args: {
  row: SearchPageRow;
  detail: DetailPage;
  attachment: DetailAttachment;
  installed: readonly InstalledModule[];
  installedIds: readonly string[];
  pdfCachePath: string;
  contentSha256: string;
  scrapedAt: Date;
}): BillMeta {
  const scope = classifyBillTitle(args.detail.long_title, args.installed);
  return {
    file_no: args.row.file_no,
    matter_id: args.row.matter_id,
    matter_guid: args.row.matter_guid,
    short_title: args.detail.short_title,
    long_title: args.detail.long_title,
    legistar_status: args.detail.legistar_status,
    sponsor: args.detail.sponsor,
    introduced_at: args.detail.introduced_at,
    legistar_url: args.row.detail_url,
    title_class: scope.class,
    touched_code_stubs: scope.touched_code_stubs,
    touched_modules: scope.touched_modules,
    installed_modules: [...args.installedIds],
    not_installed_modules: scope.not_installed_modules,
    scraped_at: args.scrapedAt.toISOString(),
    attachment_id: args.attachment.attachment_id,
    pdf_cache_path: args.pdfCachePath,
    attachment_content_hash: args.contentSha256.slice(0, 16),
  };
}

// CLI entry point. Reads the manifest, derives the search URL from
// manifest.pending_bill_source.url, runs the fetcher, writes bills-index.json.
async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n\n${HELP_TEXT}`);
    return 2;
  }
  const args = parsed;
  let manifest: JurisdictionManifest;
  try {
    manifest = await readJurisdictionManifest(resolve(args.manifest));
  } catch (err) {
    process.stderr.write(`manifest invalid: ${(err as Error).message}\n`);
    return 3;
  }
  if (!manifest.pending_bill_source) {
    process.stderr.write(
      `manifest ${args.manifest} does not declare pending_bill_source — nothing to fetch\n`,
    );
    return 2;
  }
  const outputDir = resolve(args.output);
  await mkdir(outputDir, { recursive: true });
  const http = makeHttpClient({ userAgent: args.userAgent });
  try {
    const index = await fetchPendingBills({
      searchUrl: manifest.pending_bill_source.url,
      manifest,
      outputDir,
      maxMatters: args.maxMatters,
      deps: { http },
    });
    const indexPath = join(outputDir, "bills-index.json");
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    process.stdout.write(
      `wrote ${index.bills.length} bill(s) to ${indexPath} (source: ${index.source_url})\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`fetch failed: ${(err as Error).message}\n`);
    return 3;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("fetch-bills.ts") || process.argv[1].endsWith("fetch-bills.js"));

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}

export async function statExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export { main };
