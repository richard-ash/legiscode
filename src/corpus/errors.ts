// Single source of truth for `BuildError.kind` → `ExitCode`. The exhaustive
// switch statement means a new BuildError variant produces a TypeScript
// compile error here until its exit code is decided — the contract can't
// drift silently.
//
// Ordering policy: errors[] is whatever the failing pipeline step
// contributed; the orchestrator short-circuits on critical failures so
// errors[] usually contains a single category. The first error decides
// the exit code; later errors are reported but don't change the code.

import { type ExitCode, ExitCodes } from "@/storage";
import type { BuildError } from "./types";

export function errorsToExitCode(errors: readonly BuildError[]): ExitCode {
  const first = errors[0];
  if (first === undefined) return ExitCodes.OK;
  return mapKindToExitCode(first);
}

function mapKindToExitCode(error: BuildError): ExitCode {
  switch (error.kind) {
    case "manifest_invalid":
    case "source_unreadable":
    case "parse_aborted":
    case "skip_gate_exceeded":
    case "toc_coverage_failed":
    case "citation_resolution_failed":
    case "duplicate_section_ids":
    case "unresolvable_def_id":
      return ExitCodes.PARSE;
    case "atomic_write_failed":
    case "corpus_meta_write_failed":
      return ExitCodes.WRITE;
    case "atomic_write_lock_held":
      return ExitCodes.LOCK_HELD;
    case "atomic_write_recovery_refused":
      return ExitCodes.RECOVERY_REFUSED;
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}
