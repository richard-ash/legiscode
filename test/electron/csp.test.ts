import { describe, expect, it } from "vitest";
import { buildDevCsp, buildProdCsp } from "../../electron/csp";

describe("dev CSP", () => {
  const policy = buildDevCsp().join("; ");

  it("permits Vite HMR over localhost http and ws", () => {
    expect(policy).toContain("http://localhost:5173");
    expect(policy).toContain("ws://localhost:5173");
  });

  it("permits inline + unsafe-eval scripts to support fast-refresh runtime", () => {
    expect(policy).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy).toMatch(/script-src[^;]*'unsafe-eval'/);
  });

  it("permits Google Fonts so the title-bar typography loads in dev", () => {
    expect(policy).toContain("https://fonts.googleapis.com");
    expect(policy).toContain("https://fonts.gstatic.com");
  });
});

describe("prod CSP", () => {
  const policy = buildProdCsp().join("; ");

  it("scripts default to 'self' only — no inline, no eval", () => {
    expect(policy).toMatch(/script-src 'self'/);
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(policy).not.toMatch(/script-src[^;]*unsafe-eval/);
  });

  it("connect-src is 'self' — Anthropic API extension is feat/ai-agent's job", () => {
    expect(policy).toMatch(/connect-src 'self'/);
    expect(policy).not.toContain("https://api.anthropic.com");
  });

  it("locks down embedding + form actions + base-uri", () => {
    expect(policy).toMatch(/object-src 'none'/);
    expect(policy).toMatch(/frame-ancestors 'none'/);
    expect(policy).toMatch(/form-action 'none'/);
    expect(policy).toMatch(/base-uri 'self'/);
  });

  it("permits the bundled fonts but no other origins", () => {
    expect(policy).toContain("https://fonts.googleapis.com");
    expect(policy).toContain("https://fonts.gstatic.com");
    expect(policy).not.toContain("ws://");
    expect(policy).not.toContain("http://");
  });
});
