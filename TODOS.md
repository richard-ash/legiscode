# TODOS

Format: each item is a heading, with a one-line summary, **What/Why**, **Pros/Cons**, **Context**, **Depends on / Blocked by**, and an owner branch (or `unowned`).

Add items aggressively; remove them when shipped or when superseded by a real plan.

---

## Electron ESM-in-main-process compatibility

Phase 0 commits to ESM globally (`"type": "module"`, `moduleResolution: "bundler"`). Electron 28+ supports ESM in the main process; older versions need a CJS boundary or a workaround.

- **What:** Verify the pinned Electron version supports ESM in `electron/main.ts`. If not, document a per-file CJS exception or upgrade Electron.
- **Why:** D10 made ESM the global default. The most likely Phase 1 stumble.
- **Pros:** Avoids half-day debug session at the start of `feat/electron-shell`.
- **Cons:** None.
- **Context:** /plan-eng-review D10 (2026-04-29). Electron version itself is decided in `feat/electron-shell`.
- **Depends on / Blocked by:** Electron version pin (decided in `feat/electron-shell`).
- **Owner:** `feat/electron-shell` (Phase 1).

---

## Module index hosting (GitHub Releases vs CDN)

v1.1+ module manager fetches `sf-municipal` updates and other jurisdiction modules from somewhere. v1.0 ships only `sf-municipal` pre-installed, so the publish target doesn't gate v1.0 — but `feat/build-pipeline`'s scheduled refresh workflow has to write artifacts somewhere readable by the v1.1 module manager.

- **What:** Pick the hosting target for module artifacts (`sf-municipal-2026.04.json.zst`, etc.) and the index that lists available modules + versions per `schema_version` namespace.
- **Why:** The v1.1 module manager URL pattern (`/modules/schema-1/sf-municipal/2026.04`) needs a real host. Schema-version-namespacing is a backend publish-time concern, not a client concern (memory: `project_schema_version_gate_at_backend.md`).
- **Pros (GitHub Releases):** Zero infra; baked-in CDN; free for open-source; provenance via GitHub. **Cons:** Release-asset URLs are stable but releases-tab UI gets noisy with weekly auto-updates; no fine-grained access control later.
- **Pros (Cloudflare R2 or similar):** Full control over URL structure; no UI noise; cheap. **Cons:** Adds an infra dep + a secrets footprint; provenance is on us.
- **Context:** Surfaced by `feat/corpus-parser` round 1 codex review (2026-04-30). Hostility of AmLegal to programmatic access (memory `project_amlegal_hostile_to_programmatic_access.md`) makes this slightly more urgent — once the scheduled refresh exists, it has to publish artifacts somewhere.
- **Depends on / Blocked by:** `feat/corpus-parser` shipping the module package format (this is locked in commit 1).
- **Owner:** `feat/build-pipeline`.

---

## Cross-module version compatibility policy

Modules are versioned independently (`sf-municipal@2026.04`, `ca-vehicle@2025.12`, `us-federal@2026.03`). When SF MC v2026.04 cites Cal. Veh. Code § 22358 and the user has CVC v2025.01 installed, what does the citation resolver do?

- **What:** Define the cross-module citation resolution policy. Options: (a) resolve against any installed version of the cited module ("best effort"); (b) resolve only against the version the citing module was built against ("frozen"); (c) hybrid — resolve against installed if the cited section_id exists, else mark vague.
- **Why:** Citation `target.kind === "cross_module"` is locked in `feat/corpus-parser`'s schema; the resolution code is `feat/citation-resolution`'s problem. Version skew is the realistic case (modules update independently).
- **Pros (best-effort):** Maximizes resolution rate; closest to "links don't break." **Cons:** Silent semantic drift if the cited section was renumbered.
- **Pros (frozen):** Honest about what the citing module knew. **Cons:** Resolution rate drops as modules age.
- **Pros (hybrid):** Best UX. **Cons:** Most complex.
- **Context:** `feat/corpus-parser` round 1 codex review (2026-04-30) flagged that the schema accepts cross-module citations but no resolution semantics are specified yet.
- **Depends on / Blocked by:** Need at least two modules installable to make the question concrete (i.e., `feat/module-manager` v1.1 is the natural trigger).
- **Owner:** `feat/citation-resolution`.

---

## Scheduled corpus refresh workflow

`feat/corpus-parser` builds modules from AmLegal HTML. The artifact has to be regenerated on a schedule because AmLegal updates as ordinances land — without a refresh, every shipped LegisCode is frozen at the snapshot baked into the .dmg/.exe.

- **What:** Add a scheduled GitHub Actions workflow that runs `mise run corpus:build -- --module sf-municipal --source manifests/sf-municipal/manifest.json --output build/modules/sf-municipal/`, then publishes the resulting module to the hosting target (see "Module index hosting" TODO).
- **Why:** AmLegal lag is 30-45 days; weekly is the right cadence. v1.0 doesn't need the refresh (pre-installed module ships in the .dmg) but v1.1 module-manager auto-update will pull from this workflow's outputs.
- **Pros:** Decouples corpus updates from app releases; users get fresh law without re-installing.
- **Cons:** Real fetch against AmLegal is fragile — `codelibrary.amlegal.com` Cloudflare-blocks default headless Chromium (memory `project_amlegal_hostile_to_programmatic_access.md`); will need headed-Playwright stealth, accelerated sfbos+Legistar pivot, or maintainer-curated weekly refresh.
- **Context:** `feat/corpus-parser` round 1 codex review (2026-04-30). The build-time CLI in `feat/corpus-parser` is hermetic (no live network in CI); live fetch is exclusively this workflow's problem.
- **Depends on / Blocked by:** "Module index hosting" decision; AmLegal-access strategy (Playwright stealth vs sfbos+Legistar pivot vs human-in-the-loop).
- **Owner:** `feat/build-pipeline`.

---
