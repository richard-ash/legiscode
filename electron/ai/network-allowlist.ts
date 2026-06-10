// Node-transport network allowlist for the Anthropic SDK (and any future
// provider SDK that uses undici). Per N7: Electron's session.webRequest
// covers only the renderer; the SDK runs in the main process and goes
// through Node's HTTP stack. Setting a global undici dispatcher with a
// host check is how you actually pin which hosts the main process can
// reach.
//
// CSP-style allowlist applied at the lowest network layer so SDK
// upgrades, redirects, and HTTPS_PROXY don't punch through silently.
// The list is intentionally small — one entry per provider host.

import { Agent, type Dispatcher, ProxyAgent, setGlobalDispatcher } from "undici";

const ALLOWED_HOSTS = new Set<string>([
  "api.anthropic.com",
  // Add new provider hosts here when adding a new adapter.
]);

let installed = false;

/**
 * Install the global dispatcher. Idempotent — calling twice no-ops.
 * Call once at main-process boot, before any SDK request.
 */
export function installAiNetworkAllowlist(): void {
  if (installed) return;
  installed = true;
  const inner = pickInnerDispatcher();
  const dispatcher = buildHostAllowlistDispatcher(inner, ALLOWED_HOSTS);
  setGlobalDispatcher(dispatcher);
}

/** Test seam — reset for vitest. */
export function __resetAiNetworkAllowlistForTests(): void {
  installed = false;
}

/** Read-only view of the current allowlist (for tests and settings UI). */
export function getAllowedHosts(): readonly string[] {
  return [...ALLOWED_HOSTS];
}

function pickInnerDispatcher(): Dispatcher {
  // Honor HTTPS_PROXY/HTTP_PROXY if set, but only as the *underlying*
  // transport — the host check still runs first. This means a misconfigured
  // proxy can still only reach the allowlisted hosts.
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxy) {
    try {
      return new ProxyAgent(proxy);
    } catch {
      // Fall through to direct agent.
    }
  }
  return new Agent();
}

// Wrapping dispatcher. We can't subclass undici.Dispatcher's full surface
// (it's complex and the type isn't stable across releases), so we proxy
// the inner dispatcher through and rewrite the `dispatch()` method —
// every undici request goes through it.
function buildHostAllowlistDispatcher(inner: Dispatcher, allowed: ReadonlySet<string>): Dispatcher {
  const handler: ProxyHandler<Dispatcher> = {
    get(target, prop, receiver) {
      if (prop === "dispatch") {
        return (
          opts: Dispatcher.DispatchOptions,
          dispatchHandler: Dispatcher.DispatchHandler,
        ): boolean => {
          const host = resolveHost(opts);
          if (host && !allowed.has(host)) {
            const err = new Error(
              `Network request to ${host} blocked by AI allowlist. Allowed hosts: ${[...allowed].join(", ")}`,
            );
            queueMicrotask(() => {
              try {
                // onError is part of the dispatch handler contract but may
                // be undefined on partial handlers — wrap defensively.
                const onError = (
                  dispatchHandler as Dispatcher.DispatchHandler & {
                    onError?: (e: Error) => void;
                  }
                ).onError;
                if (typeof onError === "function") onError.call(dispatchHandler, err);
              } catch {
                // Telemetry has no further channel; the dispatcher has
                // already aborted the request.
              }
            });
            return true;
          }
          return target.dispatch(opts, dispatchHandler);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  };
  return new Proxy(inner, handler);
}

function resolveHost(opts: Dispatcher.DispatchOptions): string | null {
  const origin = opts.origin;
  if (origin instanceof URL) return origin.host.split(":")[0] ?? null;
  if (typeof origin === "string") {
    try {
      return new URL(origin).host.split(":")[0] ?? null;
    } catch {
      return null;
    }
  }
  const headers = opts.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const hostHeader =
      (headers as Record<string, string | string[] | undefined>).host ??
      (headers as Record<string, string | string[] | undefined>).Host;
    if (typeof hostHeader === "string") return hostHeader.split(":")[0] ?? null;
  }
  return null;
}
