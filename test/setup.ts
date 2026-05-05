// Vitest setup — extends `expect` with @testing-library/jest-dom matchers
// and registers an auto-cleanup so mounted React trees don't leak between
// tests. Pure-node tests pick up no extra setup; the cleanup is a no-op
// when there's nothing rendered.

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// jsdom doesn't ship ResizeObserver, but react-resizable-panels (used by
// ThreePanel) constructs one at mount. Stub once so App-level tests can
// render the full shell without monkey-patching globals per file.
if (typeof globalThis.ResizeObserver === "undefined") {
  // biome-ignore lint/suspicious/noExplicitAny: minimal jsdom shim
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => {
  cleanup();
});
