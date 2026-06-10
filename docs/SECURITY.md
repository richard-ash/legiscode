# Security posture — Electron desktop app

This document records the security posture of the LegisCode Electron app
and the maintenance contracts attached to it. Anything that ships in the
distributable inherits these constraints.

## Electron version pin

`package.json` pins **`electron` to an exact version, no `^`**. Phase 1
ships Electron `41.5.0` (≥28 is the floor — `feat/electron-shell`'s plan
required ESM-in-main-process, which Electron added in v28).

**Why exact, not range:** Electron CVEs ship in patch releases and the
breakage profile is wide enough that an unattended `^28.0.0` upgrade can
trip on Node-API shifts, V8 deprecations, or sandbox-mode tweaks. We want
upgrades to be deliberate, batched, and testable, not silently picked up
when a contributor runs `pnpm install` after a long absence.

**Upgrade cadence:** quarterly. The sequence:

1. Read the [Electron release notes](https://www.electronjs.org/blog) for
   every minor version between current and target.
2. Bump the pin in `package.json`. Update `pnpm-lock.yaml` via
   `pnpm install --frozen-lockfile=false`.
3. Run the full `make typecheck && make lint && make test` loop. Then
   `make dev` and exercise the boot path manually.
4. Run the Playwright `_electron` smoke + posture suites
   (`test/e2e/electron/`).
5. Land as a single PR titled "Bump Electron to vX.Y.Z" with the relevant
   release-notes excerpts in the body.

Out-of-cycle upgrades happen only for active CVEs in the Electron line we
ship; the maintainer who picks one up posts a brief in TODOS.md so the
next quarterly bump knows what changed.

## Renderer-side runtime sandbox

The main process configures every `BrowserWindow` with:

- `contextIsolation: true` — renderer JS cannot reach the preload's globals
- `sandbox: true` — renderer runs in a Chromium sandbox process
- `nodeIntegration: false` — no `require`, no Node globals in renderer

The renderer talks to the main process **only** through the typed
`window.api` namespaces exposed by `electron/preload.ts` via
`contextBridge.exposeInMainWorld`. There is no second path.

Tests assert this posture (`test/e2e/electron/posture.test.ts`,
`test/electron/ipc/preload.test.ts`).

## Content Security Policy

CSP is set via `session.defaultSession.webRequest.onHeadersReceived` (every
response from any origin gets the policy applied). Two profiles:

**Dev** — permissive enough to support Vite's HMR socket and inline-script
fast-refresh runtime:

```
default-src 'self' http://localhost:5173 ws://localhost:5173;
script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173;
style-src  'self' 'unsafe-inline' http://localhost:5173 https://fonts.googleapis.com;
font-src   'self' data: https://fonts.gstatic.com;
img-src    'self' data: blob:;
connect-src 'self' http://localhost:5173 ws://localhost:5173;
```

**Prod** — strict:

```
default-src 'self';
script-src  'self';
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src    'self' https://fonts.gstatic.com;
img-src     'self' data:;
connect-src 'self';
object-src  'none';
base-uri    'self';
form-action 'none';
frame-ancestors 'none';
```

The Anthropic API connect-src extension belongs to `feat/ai-agent`. See
`TODOS.md` "CSP `connect-src` extension for Anthropic API."

Tests assert both profiles directly (`test/electron/csp.test.ts`).

## Renderer-side import boundary

Biome's `noRestrictedImports` rule blocks the following modules in
`src/app/**` and `src/ui/**`:

- `fs`, `node:fs`, `fs/promises`, `node:fs/promises`
- `path`, `node:path`
- `child_process`, `node:child_process`
- `electron`
- `os`, `node:os`
- `crypto`, `node:crypto`
- `http`, `node:http`
- `https`, `node:https`
- `net`, `node:net`

This is **defense-in-depth, not the security gate.** The runtime sandbox
above is what actually prevents renderer code from reaching the host
filesystem. The lint rule catches accidents in code review and CI before
they ship.

## IPC channel allowlist

`electron/ipc/contract.ts` is the single source of truth for which IPC
channels exist. The `ChannelMap` interface declares request/response
payloads; the `CHANNELS` runtime list is cross-checked against `ChannelMap`
keys at compile time so the two cannot drift. `main-handlers.ts` registers
each channel from `CHANNELS` and wraps handler exceptions as
`IpcBridgeError("handler_threw")`. `preload-bridge.ts` builds the
`window.api` object at runtime from `CHANNELS`, so a channel that doesn't
appear in the allowlist is unreachable from the renderer. main.ts calls
`assertAllChannelsRegistered()` after `registerHandlers(...)` runs so a
missed registration shows up at boot, not as a renderer-side timeout.

Adding a new channel is a two-place change in `contract.ts` plus one
handler entry:

1. Add the entry to `ChannelMap` and the channel name to `CHANNELS` in
   `contract.ts`. The compile-time cross-check enforces both.
2. Add a method to the `Api` interface in `contract.ts` so renderer call
   sites can reach it.
3. Add the handler implementation to the `Handlers` literal in
   `electron/main.ts`. The `Handlers` type is exhaustive over `Channel`,
   so a missing entry is a TypeScript error.

`preload-bridge.ts` and the renderer-side `api()` accessor never need to
change — both derive from `CHANNELS` and the `Api` interface respectively.

## AI chat panel (feat/ai-agent)

The AI chat panel adds a long-lived HTTP transport from the main process
to the Anthropic API. The main process — not the renderer — owns every
piece of that transport: the SDK, the tool router, the system prompt,
the API key. The renderer holds a thin chat UI that talks to main over
the `ai:query` / `ai:cancel` IPC channels and listens on a one-way
`ai:event` channel for progressive tool-call events.

### Node-transport allowlist

Electron's `session.webRequest` covers only the renderer's network
calls. The Anthropic SDK runs in the main process via Node's
`http`/`https` stack (undici), which `session.webRequest` does not
intercept. Without an additional gate, a misconfigured `HTTPS_PROXY`
or an SDK that follows a redirect to a third-party host could exfiltrate
prompt text.

`electron/ai/network-allowlist.ts` installs a global `undici` dispatcher
that proxies every outbound HTTP request through a host check before
the underlying dispatcher sees it. The allowlist is small and named —
adding a provider host requires editing this file. `HTTPS_PROXY` /
`HTTP_PROXY` are honored as the *underlying* transport, but the host
check still runs first; a misconfigured proxy can only reach allowlisted
hosts.

### Per-provider API key storage

Provider API keys live in encrypted files at
`${userData}/secrets/${provider_id}.bin`, mode 0600 on POSIX. Encryption
goes through Electron's `safeStorage`, which delegates to the platform
keychain (Keychain on macOS, libsecret on Linux, DPAPI on Windows). The
renderer never sees the key — it submits a key via `ai:setApiKey`, main
encrypts and persists, then reads back on demand inside the conversation
loop. `ai:clearApiKey` deletes the file.

Keys never appear in IPC events, telemetry, or chat history. The
prompt-hash regression test (T8) covers prompt content but not key
storage; the `ai:hasApiKey` channel returns only a boolean.

### Tool output ↔ prompt injection defense

Tool results — including statutory text the model fetched via
`get_section` — are wrapped in `<corpus_evidence>...</corpus_evidence>`
tags before being fed back into the model. The system prompt instructs
the model to treat everything inside those tags as data, never as
instructions. An adversarial corpus that smuggled "ignore previous
instructions" inside a section's text would be quoted, not obeyed.

Adversarial fixtures under `test/ai/golden-qa/` cover this case
explicitly (see `10-adversarial-injection.json`).

### Citation verification (no-hallucination invariant)

Every section citation in the model's prose must appear in the
turn's tool-call log. The verifier in
`src/parser/citation-verify/verify.ts` runs at the end of each turn;
violations emit a synthetic `<verification_failure>` block that re-enters
the agentic loop so the model self-corrects. Verification failures
never reach the renderer as a UI state — there is only one
user-visible outcome (the answer prose).

The golden Q&A harness (`test/ai/hallucination.test.ts`) is the
launch gate. T1's 100-fixture floor is a `/ship` precondition; the
starter set exercises every tool and acknowledgment pattern. Authoring
the remainder is tracked in TODOS.md.

### IPC trust boundary

`ai:query` validates its payload via zod, caps the prompt at 4000
characters, and enforces one in-flight turn per window. `ai:event` is
a one-way push from main to renderer; the renderer never sends events
back. Subscription is held by the preload bridge so the renderer never
touches `ipcRenderer` directly.

### Screenshot-leakage note

The chat panel renders user prompts and assistant prose as plain text.
Workflows that share screenshots — slide decks, bug reports, demo
recordings — can leak the contents of a conversation. The chat panel
intentionally does not redact tool-line detail expansions, because
hiding what the model fetched would defeat the verifiability property.
Operators should treat chat screenshots like any other source-of-truth
artifact.

### Local-only telemetry

When telemetry is enabled in AI settings, events are appended as JSON
lines to `${userData}/ai-telemetry/events.jsonl`. No network upload in
v1. Every event carries `corpus_hash` and `prompt_hash` so a regression
can be pinned to a specific snapshot. Prompt text and response text
are NEVER included; events carry only structural counts and outcomes.

## What does not ship in this branch

- Code signing + notarization — owned by `feat/build-pipeline`.
- Auto-updater — owned by `feat/release-prep`.
- Cross-platform titlebar matrix CI — owned by `feat/build-pipeline`.

Each is tracked in `TODOS.md` with the owning branch.
