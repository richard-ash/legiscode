// MockProvider — hermetic ModelProvider implementation for tests. Plays
// a scripted response per `provider.call()` invocation. Asserts the
// script wasn't consumed past its end and exposes the captured request
// for assertions.
//
// Hard property: this provider NEVER hits the network. Vendor isolation
// (C9) means the rest of the codebase talks to ModelProvider, so this
// mock is a drop-in for any test that exercises the conversation loop.

import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
} from "../../../electron/ai/providers/types";

export interface ScriptedRound {
  content: ProviderResponse["content"];
  stopReason: ProviderResponse["stopReason"];
  usage?: ProviderResponse["usage"];
}

export class MockProvider implements ModelProvider {
  readonly providerId = "mock" as const;
  readonly availableModels = ["mock-model-1"];
  readonly captured: ProviderRequest[] = [];
  private cursor = 0;

  constructor(private readonly script: readonly ScriptedRound[]) {}

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    this.captured.push(req);
    if (req.signal.aborted) {
      const err = new Error("aborted");
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    }
    const round = this.script[this.cursor];
    if (!round) {
      throw new Error(`MockProvider: script exhausted at round ${this.cursor + 1}`);
    }
    this.cursor += 1;
    // Mirror the streaming path of real adapters: emit each text block
    // through onTextDelta before returning. The conversation loop will
    // suppress the buffered text emit when it sees deltas.
    if (req.onTextDelta) {
      for (const block of round.content) {
        if (block.kind === "text") req.onTextDelta(block.text);
      }
    }
    return {
      content: round.content,
      stopReason: round.stopReason,
      usage: round.usage ?? {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    };
  }

  assertExhausted(): void {
    if (this.cursor !== this.script.length) {
      throw new Error(
        `MockProvider: ${this.script.length - this.cursor} round(s) of script were never consumed`,
      );
    }
  }
}
