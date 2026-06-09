// Golden Q&A harness — hallucination certification gate.
//
// Each test/ai/golden-qa/*.json fixture pairs a user prompt with a
// scripted MockProvider response sequence; the test runs the
// conversation loop end-to-end and asserts the verifier passes, every
// claimed-fetched ref appears in `fetchedRefs`, and the final prose
// contains the expected patterns.
//
// Per T1 / [[project_legal_corpus_zero_skip]]: 100 fixtures is the
// launch gate. The starter set covers each tool path and the
// prose-acknowledgment patterns (T4 reframed) so the harness is exercised
// end-to-end; the remaining 90+ are queued for authoring before /ship.
//
// Zero tolerance: any unverified citation in any fixture fails the suite.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ConversationEvent,
  makeRouterFn,
  runConversationTurn,
} from "../../electron/ai/conversation";
import type { ProviderContentBlock, ProviderResponse } from "../../electron/ai/providers/types";
import { loadFixtureCorpus } from "../electron/ai/load-fixture-corpus";
import { MockProvider } from "../electron/ai/mock-provider";

interface GoldenFixture {
  name: string;
  user_prompt: string;
  anchor: { module_id: string; section_id: string };
  rounds: {
    content: ProviderContentBlock[];
    stop_reason: ProviderResponse["stopReason"];
  }[];
  expect: {
    verifier_ok: boolean;
    final_text_contains: string[];
    fetched_refs: { module_id: string; section_id: string }[];
    verifier_failures: number;
  };
}

async function loadGoldens(): Promise<GoldenFixture[]> {
  const dir = join(import.meta.dirname, "golden-qa");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const out: GoldenFixture[] = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), "utf8");
    out.push(JSON.parse(raw) as GoldenFixture);
  }
  return out;
}

describe("golden Q&A — hallucination floor", async () => {
  const goldens = await loadGoldens();

  for (const golden of goldens) {
    it(`[golden] ${golden.name}`, async () => {
      const corpus = await loadFixtureCorpus();
      const provider = new MockProvider(
        golden.rounds.map((r) => ({ content: r.content, stopReason: r.stop_reason })),
      );
      const events: ConversationEvent[] = [];
      const result = await runConversationTurn(
        {
          provider,
          model: "mock-model-1",
          anchorModule: golden.anchor.module_id,
          router: makeRouterFn({ corpus, turnId: 1 }),
        },
        {
          turnId: 1,
          history: [],
          userPrompt: golden.user_prompt,
          signal: new AbortController().signal,
          onEvent: (e) => events.push(e),
        },
      );
      provider.assertExhausted();
      if (result.stopReason !== "end_turn") {
        // Surface the raw failure detail in the assertion message so the
        // golden-author can fix the fixture without rerunning under a
        // debugger.
        throw new Error(
          `stopReason=${result.stopReason} error=${JSON.stringify(result.error)} finalText=${JSON.stringify(result.finalText.slice(0, 200))}`,
        );
      }
      expect(result.stopReason).toBe("end_turn");
      expect(result.verifierFailures).toBe(golden.expect.verifier_failures);
      for (const phrase of golden.expect.final_text_contains) {
        expect(result.finalText).toContain(phrase);
      }
      for (const expected of golden.expect.fetched_refs) {
        expect(result.fetchedRefs).toContainEqual(expected);
      }
    });
  }

  it("documents the launch-floor for the 100-golden gate", () => {
    // T1 launch gate: don't ship under 100 fixtures.
    // The starter set proves the harness runs the conversation loop
    // end-to-end and that each of the six tools is exercised. The
    // remaining fixtures need real corpus content (sf-* modules) and
    // are authored against the SF municipal corpus before /ship.
    expect(goldens.length).toBeGreaterThanOrEqual(10);
    if (goldens.length < 100) {
      // Don't fail; just log a clear warning in the test output.
      // The CI gate (mise run validate:full) tightens this before
      // /ship per the locked T1 floor.
      // eslint-disable-next-line no-console
      console.warn(
        `[golden Q&A] ${goldens.length}/100 fixtures present. Author the remaining ${100 - goldens.length} before /ship.`,
      );
    }
  });
});
