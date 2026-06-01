// Thin pdfjs-dist wrapper that explicitly configures the runtime for Node.
// pdfjs is browser-first; the Node setup pitfalls (worker, CMaps, standard
// fonts) live here so callers can stay buffer-in / typed-out.
//
// The legacy build (`pdfjs-dist/legacy`) ships ES5-compatible code with no
// reliance on browser-only APIs (canvas, OffscreenCanvas) — it's the
// version pdfjs-dist documents for Node usage. Worker source is disabled
// inline; we don't need rendering, only text extraction, so the
// fake-worker path is acceptable and avoids the extra "where does the
// .worker.mjs live on disk" complexity.

import type { PDFDocumentProxy } from "pdfjs-dist";

let cachedLib: typeof import("pdfjs-dist") | null = null;

/**
 * Lazy-load the legacy pdfjs build the first time it's needed. Avoids
 * paying the ~3MB import cost in code paths that never touch a PDF
 * (e.g. test/unit/* runs that mock the parser surface).
 */
async function getPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (cachedLib !== null) return cachedLib;
  const lib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as typeof import("pdfjs-dist");
  // Point workerSrc at the legacy worker bundle on disk. pdfjs-dist 6.x
  // rejects empty-string workerSrc even when the fake-worker path is in
  // play; the resolved package path lets Node load the worker bundle as
  // a regular ESM import without networked fetching.
  const workerUrl = await import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  cachedLib = lib;
  return cachedLib;
}

export type LoadedPdf = {
  doc: PDFDocumentProxy;
  /** Tears down the loading task + worker. Idempotent. */
  destroy(): Promise<void>;
};

/**
 * Open a PDF from raw bytes and return the pdfjs document proxy plus a
 * destroyer that aborts the loading task + tears down the (fake) worker.
 * Caller MUST call .destroy() when finished — failing to do so leaks
 * pdfjs's internal references and slows the test suite by holding
 * documents in memory.
 *
 * useSystemFonts: false — we don't render glyphs, only extract text;
 * keeps the parser hermetic across CI hosts that have different
 * installed font sets.
 */
export async function loadPdfBuffer(bytes: Uint8Array): Promise<LoadedPdf> {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  return {
    doc,
    destroy: () => task.destroy(),
  };
}
