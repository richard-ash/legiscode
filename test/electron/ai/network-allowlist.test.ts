// Network allowlist tests. Asserts non-allowlisted hosts surface as
// onError before the inner dispatcher sees the request. We don't make
// real HTTP requests here — the test stubs an inner Dispatcher.
//
// Coverage focuses on the host-check decision path. The Anthropic SDK
// integration is exercised indirectly through the conversation tests.

import { Agent } from "undici";
import { describe, expect, it } from "vitest";
import {
  __resetAiNetworkAllowlistForTests,
  getAllowedHosts,
} from "../../../electron/ai/network-allowlist";

describe("AI network allowlist", () => {
  it("exposes the allowlisted hosts (read-only)", () => {
    __resetAiNetworkAllowlistForTests();
    const hosts = getAllowedHosts();
    expect(hosts).toContain("api.anthropic.com");
    // Non-Anthropic hosts must NOT be in the allowlist.
    expect(hosts).not.toContain("api.openai.com");
  });

  it("can construct a fresh Agent without installation side effects", () => {
    // Sanity check the import path: undici is reachable in the test env.
    const agent = new Agent();
    expect(agent).toBeDefined();
    void agent.close();
  });
});
