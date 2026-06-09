// Test helper: load the hermetic corpus-min fixture as an AiCorpusHandle.
// Resets every cached lazy index so each test starts clean.

import { resolve } from "node:path";
import { __resetBillsIndexForTests } from "../../../electron/ai/bills-index";
import { __resetOrdinanceIndexForTests } from "../../../electron/ai/ordinance-index";
import { __resetReverseGraphForTests } from "../../../electron/ai/reverse-index";
import {
  __resetCorpusForTests,
  type AiCorpusHandle,
  getAiCorpusHandle,
  loadCorpus,
  rememberCorpusRoot,
} from "../../../electron/corpus-loader";

export async function loadFixtureCorpus(): Promise<AiCorpusHandle> {
  __resetCorpusForTests();
  __resetReverseGraphForTests();
  __resetBillsIndexForTests();
  __resetOrdinanceIndexForTests();
  const root = resolve(import.meta.dirname, "..", "..", "fixtures", "corpus-min");
  rememberCorpusRoot(root);
  const state = await loadCorpus(root);
  if (state.kind !== "ok") {
    throw new Error(`Fixture corpus failed to load: ${state.error.detail}`);
  }
  const handle = getAiCorpusHandle();
  if (!handle) throw new Error("getAiCorpusHandle returned null after successful loadCorpus");
  return handle;
}
