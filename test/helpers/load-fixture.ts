import { readFileSync } from "node:fs";

// v0: returns `unknown` deliberately. No runtime validation here.
// `feat/corpus-parser` ships zod-validated readers (`readSection`, etc.) in
// `src/types/validate/`; consumers migrate from this helper to those once
// the type shapes exist. See /plan-eng-review D2 (2026-04-29) in the design doc.
export function loadFixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
