// Per-page text extraction over a pdfjs document. Returns a stream of
// text runs (one per pdfjs textContent item) annotated with page number
// and font name — enough for the structural pass (regex over the text)
// and the future typography pass (font-name discriminates Roman vs
// italics in the SF redline convention).
//
// Read-only: we never mutate the underlying document; the caller owns
// its lifecycle (loadPdfBuffer → use → .destroy()).

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { getPdfjs } from "./load";

export type TextRun = {
  /** 1-indexed page number for human-readable diagnostics. */
  page: number;
  /** Raw text content of the run; may contain trailing whitespace. */
  text: string;
  /**
   * pdfjs's per-document font alias (e.g. `g_d0_f3`). Stable across
   * pages within one document. Resolve to PostScript name + italic /
   * bold flags via `extractFontMetadata`.
   */
  font_name: string;
  /**
   * Whether pdfjs flagged this run as ending a line. The structural
   * regex relies on line boundaries to anchor "Section N. <Code> Code"
   * patterns.
   */
  has_eol: boolean;
  /** Baseline x in PDF user space (left edge of the first glyph). */
  x: number;
  /** Baseline y in PDF user space (PDF origin is bottom-left; y grows up). */
  y: number;
  /** Total advance width of the run in user-space units. */
  width: number;
  /** Reported glyph height in user-space units. */
  height: number;
};

/** Walk all pages and yield every text run in document order. */
export async function extractTextRuns(doc: PDFDocumentProxy): Promise<TextRun[]> {
  const out: TextRun[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    try {
      const content = await page.getTextContent({ includeMarkedContent: false });
      for (const item of content.items) {
        // pdfjs items are TextItem | TextMarkedContent; we only care about
        // TextItem (has .str). TextMarkedContent is structure metadata.
        if (!("str" in item)) continue;
        // pdfjs text-item .transform is [a, b, c, d, e, f]; (e, f) is the
        // baseline position in user-space coords. width/height come pre-
        // computed off the same item.
        const transform = item.transform;
        const tx = Array.isArray(transform) && typeof transform[4] === "number" ? transform[4] : 0;
        const ty = Array.isArray(transform) && typeof transform[5] === "number" ? transform[5] : 0;
        out.push({
          page: pageNum,
          text: item.str,
          font_name: item.fontName ?? "",
          has_eol: item.hasEOL === true,
          x: tx,
          y: ty,
          width: typeof item.width === "number" ? item.width : 0,
          height: typeof item.height === "number" ? item.height : 0,
        });
      }
    } finally {
      page.cleanup();
    }
  }
  return out;
}

/**
 * Concatenate text runs into a single string with `\n` between runs that
 * end an EOL marker, otherwise just spaces. Lossy but enough for the
 * structural-pass regex matcher (which cares about line anchors and
 * Code/Charter words, not exact spacing).
 */
export function runsToText(runs: readonly TextRun[]): string {
  const out: string[] = [];
  for (const run of runs) {
    out.push(run.text);
    if (run.has_eol) {
      out.push("\n");
    } else if (!run.text.endsWith(" ")) {
      out.push(" ");
    }
  }
  return out.join("").replace(/[ \t]+\n/g, "\n");
}

/** Lazy wrapper that also calls .cleanup() on each page after read. */
export async function* iterPages(doc: PDFDocumentProxy): AsyncGenerator<PDFPageProxy> {
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    try {
      yield page;
    } finally {
      page.cleanup();
    }
  }
}

// FontMetadata reduces the pdfjs font dictionary to the three fields the
// typography decoder needs. `name` is the PostScript name (e.g.
// "TimesNewRomanPS-ItalicMT"); the booleans are pdfjs's own analysis
// of the font's italic / bold variant. Fonts whose metadata is
// unavailable yield `name = ""` (caller should treat as "unknown").
export type FontMetadata = {
  /** Raw PostScript name when known, empty string when pdfjs didn't resolve it. */
  name: string;
  italic: boolean;
  bold: boolean;
};

/**
 * Walk every page once, force the worker to load each declared font,
 * and yield a map from pdfjs's local font alias (e.g. `g_d0_f3`) to
 * the underlying PostScript metadata. The map is the source of truth
 * for `italic.ts:isItalicFont` — pdfjs's `content.styles[fontName]`
 * only carries the CSS fallback family, not the italic flag.
 */
export async function extractFontMetadata(
  doc: PDFDocumentProxy,
): Promise<Map<string, FontMetadata>> {
  const out = new Map<string, FontMetadata>();
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    try {
      // getOperatorList triggers worker-side font resolution; without
      // it commonObjs.get throws "Requesting object that isn't resolved
      // yet". Once it resolves, every font the page uses is cached.
      await page.getOperatorList();
      const tc = await page.getTextContent({ includeMarkedContent: false });
      const used = new Set<string>();
      for (const it of tc.items) {
        if ("fontName" in it && typeof it.fontName === "string" && it.fontName !== "") {
          used.add(it.fontName);
        }
      }
      for (const fn of used) {
        if (out.has(fn)) continue;
        try {
          const font = page.commonObjs.get(fn) as {
            name?: unknown;
            italic?: unknown;
            bold?: unknown;
          };
          out.set(fn, {
            name: typeof font.name === "string" ? font.name : "",
            italic: font.italic === true,
            bold: font.bold === true,
          });
        } catch {
          // Font not yet resolved on this page; a later page that uses
          // the same font will register it. If no page ever resolves it,
          // it stays out of the map and callers see undefined.
        }
      }
    } finally {
      page.cleanup();
    }
  }
  return out;
}

// GraphicsOp is the renderer-agnostic record the typography decoder needs
// to classify text runs. Layer 3 (classify-spans.ts) correlates each text
// run's baseline against a stroke/fill op's bounding box to decide
// "insert" (underline overlay), "delete" (strikethrough overlay), or
// "context" (no overlay).
//
// bbox is in PDF user-space coordinates (post-CTM). PDF's origin is
// bottom-left and y grows upward; classify-spans handles that
// convention by comparing against text-run baselines, which pdfjs also
// reports in user space.
export type GraphicsOp = {
  /** 1-indexed page number, matching TextRun.page. */
  page: number;
  /**
   * "stroke" — a stroke-paint terminator (stroke, closeStroke, fillStroke,
   *            and friends). Strikethrough and underline lines come
   *            through here.
   * "fill"   — a fill-paint terminator (fill, eoFill). Useful for
   *            recognising filled rectangles the city occasionally uses
   *            as highlight markers; classify-spans treats these as
   *            "context" candidates unless a sibling stroke landed.
   */
  kind: "stroke" | "fill";
  /** Bounding box in PDF user-space coordinates. */
  bbox: { x: number; y: number; w: number; h: number };
};

/**
 * Walk every page's operator list and yield each path-paint op as a
 * GraphicsOp record. Strokes and fills carry their post-CTM bounding box
 * so the classifier can correlate against text-run baselines without
 * re-implementing PDF graphics state.
 *
 * ## How pdfjs 6.x encodes paths
 *
 * pdfjs 6.x consolidates the path + its paint terminator into a single
 * record: `OPS.constructPath(paintOp, [drawOps, points], minMax)`.
 *
 *   args[0] — the paint terminator OP that pdfjs would dispatch when
 *             rendering this path. The values match the standalone
 *             OPS enum (e.g. `OPS.eoFill`, `OPS.stroke`, `OPS.endPath`).
 *             We classify on this value: stroke variants → "stroke",
 *             fill variants → "fill". `endPath` and clip variants are
 *             ignored — they describe geometry the renderer uses for
 *             clipping or as a no-op, not visible decoration.
 *
 *   args[1] — packed [drawOps, points] data; we don't need the path
 *             internals because args[2] already carries the bbox.
 *
 *   args[2] — `Float32Array([xMin, yMin, xMax, yMax])` already in PDF
 *             user-space coordinates (pdfjs's path-builder applies the
 *             CTM in effect at the time the path is constructed). We
 *             do NOT re-apply CTM here — that would double-transform.
 *
 * Standalone stroke/fill/closeFillStroke ops still exist in the spec
 * for back-compat (when the underlying PDF uses the un-consolidated
 * form). We honor them via a `pendingBbox` for the preceding
 * `constructPath` that emitted `OPS.endPath` as its paint mode.
 *
 * SF Legistar redline bills use the consolidated form exclusively —
 * underline / strikethrough decorations come through as
 * `constructPath(eoFill, [...], [xMin, yMin, xMax, yMax])` with
 * heights around 0.6 pt.
 *
 * ## What we ignore
 *
 * Clip ops, text-state ops, image ops, marked content — none of these
 * decorate text the way classify-spans needs. We skip them silently.
 */
export async function extractGraphicsOps(doc: PDFDocumentProxy): Promise<GraphicsOp[]> {
  const pdfjs = await getPdfjs();
  // The OPS namespace at runtime is a flat dictionary mapping op-name to
  // numeric opcode. The .d.ts treats it as a namespace, hence the cast.
  const OPS = pdfjs.OPS as unknown as Record<string, number | undefined>;

  function opCode(name: string): number {
    const v = OPS[name];
    if (typeof v !== "number") {
      throw new Error(`pdfjs OPS missing expected opcode: ${name}`);
    }
    return v;
  }

  const OP_CONSTRUCT_PATH = opCode("constructPath");
  const OP_RECTANGLE = opCode("rectangle");
  const OP_END_PATH = opCode("endPath");

  const STROKE_OPS: ReadonlySet<number> = new Set([opCode("stroke"), opCode("closeStroke")]);
  const FILL_OPS: ReadonlySet<number> = new Set([
    opCode("fill"),
    opCode("eoFill"),
    opCode("rawFillPath"),
    opCode("fillStroke"),
    opCode("eoFillStroke"),
    opCode("closeFillStroke"),
    opCode("closeEOFillStroke"),
  ]);

  function classifyPaintOp(op: number | undefined): "stroke" | "fill" | null {
    if (op === undefined) return null;
    if (STROKE_OPS.has(op)) return "stroke";
    if (FILL_OPS.has(op)) return "fill";
    return null;
  }

  function readMinMax(args: unknown): [number, number, number, number] | null {
    if (!Array.isArray(args) && !(args instanceof Float32Array)) {
      const indexed = args as { [k: number]: unknown; length?: number } | undefined;
      if (indexed === undefined || indexed.length === undefined || indexed.length < 4) {
        return null;
      }
      const a = indexed[0];
      const b = indexed[1];
      const c = indexed[2];
      const d = indexed[3];
      if (
        typeof a !== "number" ||
        typeof b !== "number" ||
        typeof c !== "number" ||
        typeof d !== "number"
      ) {
        return null;
      }
      return [a, b, c, d];
    }
    const arr = args as ArrayLike<number>;
    if (arr.length < 4) return null;
    return [arr[0] as number, arr[1] as number, arr[2] as number, arr[3] as number];
  }

  const out: GraphicsOp[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    try {
      const opList = await page.getOperatorList();
      const fnArray = opList.fnArray;
      const argsArray = opList.argsArray;

      // Used only for the legacy un-consolidated path form (rectangle +
      // standalone stroke/fill ops, no constructPath wrapper). The
      // consolidated form bakes paintOp into the constructPath args, so
      // this path doesn't fire in modern pdfjs output.
      let pendingBbox: [number, number, number, number] | null = null;

      for (let i = 0; i < fnArray.length; i++) {
        const op = fnArray[i];
        const args = argsArray[i] as unknown[];

        if (op === OP_CONSTRUCT_PATH) {
          // args: [paintOp, [drawOps, points], minMax]
          const paintOp = args[0] as number | undefined;
          const kind = classifyPaintOp(paintOp);
          if (kind === null) {
            // endPath, clip, or any non-paint terminator — geometry-only
            // path. Skip; pendingBbox remains untouched (the legacy
            // un-consolidated stream uses a different code path).
            continue;
          }
          const minMax = readMinMax(args[2]);
          if (minMax === null) continue;
          out.push({
            page: pageNum,
            kind,
            bbox: {
              x: minMax[0],
              y: minMax[1],
              w: minMax[2] - minMax[0],
              h: minMax[3] - minMax[1],
            },
          });
          continue;
        }

        if (op === OP_RECTANGLE) {
          // Legacy: args = [x, y, w, h]
          const [rx, ry, rw, rh] = args as [number, number, number, number];
          if (
            typeof rx === "number" &&
            typeof ry === "number" &&
            typeof rw === "number" &&
            typeof rh === "number"
          ) {
            pendingBbox = [rx, ry, rx + rw, ry + rh];
          }
          continue;
        }

        const kind = classifyPaintOp(op);
        if (kind !== null) {
          // Legacy: a standalone stroke/fill claims the most recent
          // un-consolidated path.
          if (pendingBbox !== null) {
            out.push({
              page: pageNum,
              kind,
              bbox: {
                x: pendingBbox[0],
                y: pendingBbox[1],
                w: pendingBbox[2] - pendingBbox[0],
                h: pendingBbox[3] - pendingBbox[1],
              },
            });
          }
          pendingBbox = null;
          continue;
        }

        if (op === OP_END_PATH) {
          pendingBbox = null;
        }
      }
    } finally {
      page.cleanup();
    }
  }
  return out;
}
