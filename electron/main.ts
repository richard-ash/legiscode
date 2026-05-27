// Electron main-process entry point. Owns:
//  • the strict security posture (contextIsolation + sandbox + nodeIntegration:false + CSP)
//  • the custom titlebar style per platform (hiddenInset on macOS, titleBarOverlay on Win11+)
//  • the BrowserWindow lifecycle and saved-state recovery
//  • the render-process-gone reload UI hook
//  • IPC handler registration via electron/ipc/main-handlers.ts
//
// Anything renderer-facing crosses through electron/preload.ts; this file
// never imports from src/ except types.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, screen, session, shell } from "electron";
import { listCorpus, loadCorpus, readSection, resolveCorpusPath } from "./corpus-loader";
import { buildDevCsp, buildProdCsp } from "./csp";
import { assertAllChannelsRegistered, type Handlers, registerHandlers } from "./ipc/main-handlers";
import { handleShellOpenExternal } from "./shell-handler";

const isDev = !app.isPackaged;
// electron-vite sets ELECTRON_RENDERER_URL when its dev server is the active
// renderer source; absent for built artifacts (prod and E2E runs against
// out/renderer). Hardcoding a port would diverge if Vite picks a fallback.
const devRendererUrl = process.env.ELECTRON_RENDERER_URL;

// Window state — resilient to disconnected displays. localStorage placeholder
// per A9 / C1; feat/sqlite-state migrates persistence later.
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 960; // A19 — three-panel IDE breaks below this floor
const MIN_HEIGHT = 600;

let mainWindow: BrowserWindow | null = null;
let corpusReady: Promise<unknown> | null = null;

const fileDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = isDev ? join(fileDir, "..", "..") : app.getAppPath();

app.whenReady().then(async () => {
  // Kick the corpus load before the window so disk I/O overlaps with
  // BrowserWindow construction. The window stays show:false until both
  // webContents.did-finish-load and this promise resolve (P4 / A18).
  corpusReady = loadCorpus(
    resolveCorpusPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot,
    }),
  );

  installCspGuard();
  registerIpcHandlers();
  assertAllChannelsRegistered();

  await createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
});

async function createMainWindow(): Promise<void> {
  const bounds = restoreBounds();

  const titleBarOptions = computeTitleBarOptions();

  mainWindow = new BrowserWindow({
    show: false, // P4 / A18 — defer until corpus + did-finish-load both resolve
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: "#11111b", // Catppuccin Mocha crust — no FOUC against dark default
    ...titleBarOptions,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: resolvePreloadPath(),
    },
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    // The renderer is gone; reload it so the renderer-side BootOverlay
    // (crash variant, A17) can paint. The crash overlay logic itself lives
    // in src/ui/chrome/boot-overlay.tsx — wired via a query-string flag the
    // renderer reads at boot. Phase 1 keeps the recovery path simple.
    console.error("renderer process gone:", details);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const url = devRendererUrl
        ? `${devRendererUrl}?recovered=1`
        : `file://${rendererIndexFile()}?recovered=1`;
      void mainWindow.loadURL(url);
    }
  });

  mainWindow.on("close", () => {
    if (mainWindow) persistBounds(mainWindow);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const onceLoaded = new Promise<void>((res) => {
    mainWindow?.webContents.once("did-finish-load", () => res());
  });

  if (devRendererUrl) {
    await mainWindow.loadURL(devRendererUrl);
  } else {
    await mainWindow.loadFile(rendererIndexFile());
  }

  await Promise.all([onceLoaded, corpusReady ?? Promise.resolve()]);
  mainWindow?.show();
}

function computeTitleBarOptions() {
  const platform = process.platform;
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 14 },
    };
  }
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden" as const,
      titleBarOverlay: {
        color: "#11111b",
        symbolColor: "#a6adc8",
        height: 34,
      },
    };
  }
  // Linux + Windows 10 fall through to a native frame. T3 polish lands in
  // feat/release-prep v1.1 with a custom-frame Win10 implementation.
  return {} as const;
}

function rendererIndexFile(): string {
  // Compute relative to main.js's own directory rather than app.getAppPath():
  //   • Dev/E2E: out/main/main.js → ../renderer/index.html resolves to
  //     <projectRoot>/out/renderer/index.html.
  //   • Packaged (electron-builder + asar): app.asar/main/main.js →
  //     ../renderer/index.html resolves to app.asar/renderer/index.html.
  // app.getAppPath() returned the script's containing directory (out/main)
  // in dev, producing out/main/out/renderer/index.html — a non-existent path.
  return join(fileDir, "..", "renderer", "index.html");
}

function resolvePreloadPath(): string {
  // electron-vite emits CJS preload as preload.cjs (vs preload.mjs for ESM).
  // Sandboxed preloads must be CJS — see electron.vite.config.ts.
  return join(fileDir, "..", "preload", "preload.cjs");
}

function installCspGuard(): void {
  const headers = isDev ? buildDevCsp() : buildProdCsp();
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": headers,
      },
    });
  });
}

// E2E mock seam (codex C13). When LEGISCODE_E2E_MOCK_CORPUS_READ is set,
// corpus:read intercepts and returns a synthetic response. "fail" returns
// CorpusError("not_found") on the FIRST call only so the spec can verify
// banner-then-recover. "long" returns a synthetic 100KB section that
// matches sf-publicworks 184.12's worst-case body size; the spec asserts
// real-Chromium render time. The seam lives here (not in the renderer)
// because the renderer's IPC bridge has no test override; injecting at
// the handler keeps the production code path identical.
const E2E_MOCK_CORPUS_READ = process.env.LEGISCODE_E2E_MOCK_CORPUS_READ;
let e2eFailRemaining = E2E_MOCK_CORPUS_READ === "fail" ? 1 : 0;

function registerIpcHandlers(): void {
  const handlers: Handlers = {
    "corpus:list": async () => {
      await (corpusReady ?? Promise.resolve());
      return listCorpus();
    },
    "corpus:read": async (req) => {
      await (corpusReady ?? Promise.resolve());
      const mocked = maybeMockCorpusRead(req);
      if (mocked) return mocked;
      return readSection(req);
    },
    "app:ping": () => ({ pong: Date.now() }),
    "shell:openExternal": (req) =>
      handleShellOpenExternal(req, { openExternal: (url) => shell.openExternal(url) }),
  };
  registerHandlers(handlers);
}

function maybeMockCorpusRead(
  req: Parameters<typeof readSection>[0],
): ReturnType<typeof readSection> | null {
  if (E2E_MOCK_CORPUS_READ === "fail" && e2eFailRemaining > 0) {
    e2eFailRemaining -= 1;
    return {
      ok: false,
      error: { kind: "not_found", detail: "e2e-mock-failure" },
    };
  }
  if (E2E_MOCK_CORPUS_READ === "long") {
    return buildSyntheticLongSection(req);
  }
  return null;
}

function buildSyntheticLongSection(
  req: Parameters<typeof readSection>[0],
): ReturnType<typeof readSection> {
  // 200 paragraphs × ~510 chars ≈ 102KB body — matches sf-publicworks
  // 184.12 worst case. Body[] is text + paragraph_break only; the spec
  // is measuring layout cost, not annotation density.
  const para = "x".repeat(500);
  const body: Array<{ type: string; text?: string }> = [];
  const textLines: string[] = [];
  for (let i = 0; i < 200; i++) {
    body.push({ type: "text", text: para });
    textLines.push(para);
    if (i < 199) {
      body.push({ type: "paragraph_break" });
      textLines.push("\n");
    }
  }
  const text = textLines.join("");
  return {
    ok: true,
    value: {
      moduleId: req.moduleId,
      section: {
        kind: "section",
        id: req.sectionId,
        display_label: req.sectionId,
        title: "E2E Long Section",
        text,
        citations: [],
        defined_terms: [],
        hierarchy: ["E2E"],
        editorial_status: "active",
        // biome-ignore lint/suspicious/noExplicitAny: synthetic body shape matches BodySegment but bypasses zod
        body: body as any,
      },
      parents: [{ code: "E2E", name: "", sectionId: null }],
      prev: null,
      next: null,
      definitions: {},
    },
  };
}

// ─── Window bounds persistence (localStorage placeholder) ───────────────────

interface SavedBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

function restoreBounds(): SavedBounds {
  // Phase 1 stores bounds via the renderer's localStorage; the main process
  // can't reach localStorage directly, so on first load we fall back to the
  // default. After the renderer mounts it persists bounds itself via an IPC
  // round-trip in feat/sqlite-state. For Phase 1 the default-on-cold-start
  // behaviour is adequate.
  const fallback: SavedBounds = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  return clampToConnectedDisplay(fallback);
}

function persistBounds(_window: BrowserWindow): void {
  // Intentional no-op for Phase 1 — see restoreBounds(). feat/sqlite-state
  // wires up a real persistence path. Hook is here so the close-handler
  // contract stays stable across that change.
}

function clampToConnectedDisplay(b: SavedBounds): SavedBounds {
  const displays = screen.getAllDisplays();
  if (typeof b.x !== "number" || typeof b.y !== "number") return b;
  const onDisplay = displays.find((d) => {
    const wa = d.workArea;
    return (
      (b.x ?? 0) >= wa.x &&
      (b.y ?? 0) >= wa.y &&
      (b.x ?? 0) < wa.x + wa.width &&
      (b.y ?? 0) < wa.y + wa.height
    );
  });
  if (onDisplay) return b;
  return { width: b.width, height: b.height };
}
