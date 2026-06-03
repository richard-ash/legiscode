// Shared boot overlay. Two variants over one component:
// crash-recovery (renderer process gone) and corpus-load-failure
// (corpus IPC error). Same surface, different copy + actions. No
// marketing tone.

import type { CorpusError } from "@/corpus/wire";

export type BootOverlayVariant = "crash" | "corpus";

interface CrashProps {
  variant: "crash";
  onReload: () => void;
  onCopyDiagnostic: () => void;
}

interface CorpusProps {
  variant: "corpus";
  error: CorpusError;
  onCopyDiagnostic: () => void;
  onQuit: () => void;
}

export type BootOverlayProps = CrashProps | CorpusProps;

export function BootOverlay(props: BootOverlayProps) {
  if (props.variant === "crash") {
    return (
      <div
        className="lc-boot-overlay"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="lc-boot-title"
      >
        <div className="lc-boot-card">
          <h1 id="lc-boot-title" className="lc-boot-title">
            App crashed
          </h1>
          <p className="lc-boot-body">The renderer process unexpectedly exited.</p>
          <div className="lc-boot-actions">
            <button type="button" className="lc-boot-btn" onClick={props.onCopyDiagnostic}>
              Copy diagnostic info
            </button>
            <button type="button" className="lc-boot-btn is-primary" onClick={props.onReload}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="lc-boot-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="lc-boot-title"
    >
      <div className="lc-boot-card">
        <h1 id="lc-boot-title" className="lc-boot-title">
          Corpus failed to load
        </h1>
        <p className="lc-boot-body">
          {props.error.detail ||
            "Reinstall the app or run with --corpus-path=… to point at a known-good module."}
        </p>
        <div className="lc-boot-actions">
          <button type="button" className="lc-boot-btn" onClick={props.onCopyDiagnostic}>
            Copy Diagnostic
          </button>
          <button type="button" className="lc-boot-btn is-primary" onClick={props.onQuit}>
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}
