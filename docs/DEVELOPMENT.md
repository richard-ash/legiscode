# Development

## Local development

Install [`mise`](https://mise.jdx.dev/getting-started.html):

```shell
brew install mise
```

If you're using [`oh-my-zsh`](https://ohmyz.sh) you can add `mise` as a plugin in `~/.zshrc`:

```shell
plugins=(mise)
```

Otherwise, add mise to your shell by adding the following to your shell configuration file (e.g. `~/.zshrc`):

```shell
eval "$(mise activate zsh)"
```

Trust the project's mise config and install Node and pnpm:

```shell
mise trust
mise install
```

Install dependencies:

```shell
make install
```

### Running tests

Run `make test`. To watch:

```shell
mise exec -- pnpm exec vitest
```

### Linting and formatting

```shell
make lint            # biome lint
make format-check    # biome format (read-only)
make format          # biome format (writes)
```

### Type-checking

```shell
make typecheck       # tsc --noEmit
```

### Building

```shell
make build           # tsc emit to dist/
```

## Reproducing CI locally

The [Makefile](../Makefile) wraps Docker Buildx around `.development/Dockerfile` — the same image GitHub Actions builds. Use this to reproduce CI behaviour locally.

To build the CI container and run all checks inside it:

```shell
make ci-build           # build the CI image (source target)
make ci-quality         # run typecheck, lint, format-check, test inside it
```

To build the dist artifact via Docker (extracts to local `./dist`):

```shell
make ci-dist
```

To remove the CI image:

```shell
make ci-clean
```

### Debugging inside the container

Drop into a shell on the CI image to inspect tool versions, run individual commands, or reproduce a failure exactly as CI sees it:

```shell
docker run --rm -it legiscode-ci:latest sh
```

From there: `pnpm exec tsc --noEmit`, `pnpm exec biome lint .`, `pnpm exec vitest run`, etc.

## Sandboxed development with the devcontainer

The repo ships a [devcontainer](https://containers.dev/) (`.devcontainer/`) for running Claude Code in YOLO mode (`--dangerously-skip-permissions`) inside an isolated Docker environment. Outbound network is restricted to a domain allowlist via Squid; sensitive files (`.env*`, `.context/`, `.claude/settings.local.json`) are shadowed with empty placeholders so the agent cannot read them. `.gstack/` is intentionally read-write — agents persist their own working state there.

This is **complementary** to the host workflow above — not a replacement:

| Workflow                  | Where         | Use when                                              |
| ------------------------- | ------------- | ----------------------------------------------------- |
| `mise` + `make` (above)   | Host          | Day-to-day development. Fastest, full GUI access.     |
| `make ci-*` (above)       | Host → Docker | Reproducing the CI image's behaviour locally.         |
| `make dev-*` (this section) | Host → Docker | Letting an autonomous agent run with broad permissions without trusting it with the host. |

### Scope: headless only

`mise run dev` (electron-vite HMR) and `pnpm exec playwright test` (Electron E2E) **continue to run on the host** — they need GUI / display access that this devcontainer intentionally does not provide. Inside the sandbox you get typecheck / lint / unit test / build / `corpus:build` and the rest of the non-GUI surface.

If you ever need E2E inside, we'd add Xvfb + xauth and widen the firewall — open an issue first.

### Prerequisites

- Docker Desktop (or any Docker daemon) running on the host.
- `@devcontainers/cli` for the CLI flow:
  ```shell
  npm install -g @devcontainers/cli
  ```
  VS Code / Cursor users with the Dev Containers extension can use **Reopen in Container** instead and skip the CLI.

### Bring it up

From the repo root:

```shell
make dev-up        # build + start
make dev-shell     # interactive shell inside the container
make dev-claude    # launch Claude Code in YOLO mode inside the container
make dev-status    # is it running?
make dev-down      # stop + remove + prune named volumes
```

The first `dev-up` takes a few minutes (image build + `pnpm install` against the named-volume `node_modules`). Subsequent starts are seconds.

### What runs inside

The image bakes Node 24 (matches `mise.toml`), pnpm via corepack (replaced by mise's pinned 10.33.2 on first start), `mise`, `git`, and Claude Code. Once you're in the shell via `make dev-shell`, the regular host commands work unchanged — same `Makefile`, same targets:

```shell
make typecheck
make lint
make test
mise run build:app
mise run corpus:build -- --module ...
```

### How the firewall works

`init-firewall.sh` runs at container start (post-start, root-only via scoped sudo). It:

1. Starts Squid on intercept ports 3129 (HTTP) / 3130 (HTTPS, peek-and-splice — no decryption, just SNI inspection).
2. Generates an SNI regex allowlist from `.devcontainer/allowed-domains.txt`.
3. Sets iptables `OUTPUT` policy to `DROP`, then redirects 80/443 through Squid.
4. Verifies the result: a known-blocked host (`example.com`) must fail, and `api.github.com` / `claude.ai` / `registry.npmjs.org` must succeed. If verification fails the container start aborts.

To **add a domain** to the allowlist, edit `.devcontainer/allowed-domains.txt` and rebuild with `make dev-rebuild`. Conventions:

- `.example.com` — matches `example.com` *and* all subdomains.
- `example.com` — exact match only (no subdomains).

To check what's actually being requested, tail the proxy log from the host:

```shell
make dev-logs
```

### How protected paths work

`init-file-protection.sh` reads `.devcontainer/protected-paths.txt` and `mount --bind`s an empty placeholder over each match inside `/workspace`. The host file is untouched; the agent in the container sees an empty file or empty directory. As a secondary defence, equivalent `Read(path:**/...)` deny rules are written into the in-container `~/.claude/projects/-workspace/settings.json`.

To protect more paths, edit `.devcontainer/protected-paths.txt` and either restart the container or re-run `sudo bash /workspace/.devcontainer/setup/init-file-protection.sh` from inside.

> **Caveat.** Protected-paths is a best-effort *layered* defence, not a guarantee. The agent can still see the file *exists* and the host's secrets remain on the host. The strongest protection here is the absence of host-side mounts: `~/.ssh`, `~/.config/gh`, and shell rc files are deliberately not bind-mounted into the container, so production secrets must never live in the project tree.

### Updating the devcontainer

Code under `.devcontainer/` is checked in — changes affect every contributor. Rebuild after editing the Dockerfile or scripts:

```shell
make dev-rebuild
```

Editing `allowed-domains.txt` / `protected-paths.txt` also needs `dev-rebuild` because both files are baked into the image; mounted-workspace fallbacks make the protected-paths file hot-reloadable for testing without a rebuild.

## Documentation

- [`DESIGN.md`](../DESIGN.md) — visual design system
- [`README.md`](../README.md) — quick start
- `~/.gstack/projects/legiscode/` — feature plans, ADRs, branch decomposition (out of tree)
