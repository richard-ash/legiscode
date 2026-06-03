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

## What does not ship in this branch

- Code signing + notarization — owned by `feat/build-pipeline`.
- Auto-updater — owned by `feat/release-prep`.
- Anthropic API connect-src extension — owned by `feat/ai-agent`.
- Cross-platform titlebar matrix CI — owned by `feat/build-pipeline`.

Each is tracked in `TODOS.md` with the owning branch.
