// Renderer entry point. Asserts `window.api` is wired, then mounts the App.
// Synchronous theme application happens in src/index.html before this file
// runs, so React only sees the final dark/light class on <html>.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/ui/App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("renderer bootstrap: #root element missing from index.html");
}

if (!window.api) {
  // Surface a one-line console diagnostic before BootOverlay can paint —
  // the BootOverlay corpus variant doesn't render this case, only the
  // crash variant does. App() will refuse to call IPC until window.api
  // exists, so this is the only signal a developer gets that preload
  // failed to wire the bridge.
  console.error("window.api missing — preload script did not run.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
