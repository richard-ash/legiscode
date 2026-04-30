# Upgrade

Upgrading dependencies and tools is done purposefully. Update one thing at a
time, run the full pipeline (`make ci`), read the changelog, then commit.

## Source-of-truth map

| Concern | File | Notes |
|---|---|---|
| Node version | [`mise.toml`](../mise.toml) `[tools] node` | Read by mise locally and inside `.development/Dockerfile`. |
| pnpm version | [`mise.toml`](../mise.toml) `[tools] pnpm` | Read by mise locally and inside Docker. |
| TypeScript, vitest, biome, etc. | [`package.json`](../package.json) `devDependencies` | Pinned exactly (TypeScript) or via `^` (others). |
| Lockfile | [`pnpm-lock.yaml`](../pnpm-lock.yaml) | Auto-generated. Always commit alongside `package.json` changes. |

`mise.toml` is the only place runtime tool versions live. There is no
`engines.node`, `packageManager`, or `.nvmrc` — those would create drift.

## Updating dependencies

Find what's outdated:

```sh
make install                                    # ensure deps are up-to-date
mise exec -- pnpm outdated                      # show outdated packages
mise exec -- pnpm outdated -r --format list     # alternative format
```

Update one package at a time:

```sh
mise exec -- pnpm up <package>@<version>        # bump one package
make ci                                         # verify nothing broke
make docker-quality                             # also verify in CI container
```

Read the changelog for each major-version bump before running `make ci`.
Some upgrades require config or code changes (see project-specific notes
below).

If you remove a dependency, `pnpm install` prunes it from `pnpm-lock.yaml`
automatically. Commit the lockfile delta.

## Updating Node

Edit `mise.toml`:

```toml
[tools]
node = "26"      # or a specific minor like "26.1.0"
```

Then:

```sh
mise install                                    # mise picks up the new pin
make clean && make install                      # rebuild node_modules under new Node
make ci                                         # verify
make docker-quality                             # verify the Docker path picks it up too
```

The Dockerfile reads `mise.toml` and installs the same Node version inside
the container, so you only edit one file.

When picking a Node version: prefer the current LTS unless there's a real
reason to take an odd-numbered current release. Odd-numbered Node releases
are EOL ~6 months after the next LTS ships.

## Updating pnpm

Edit `mise.toml`:

```toml
[tools]
pnpm = "10.40.0"
```

Then:

```sh
mise install
make clean && make install
make ci
```

Lockfile may change (pnpm sometimes adjusts metadata in major bumps). Commit
the delta.

## Updating TypeScript

Read the [TypeScript release notes](https://devblogs.microsoft.com/typescript/)
for the new version, especially the *Breaking Changes* section. Recent
deprecations to watch:

- TS 6.0 — `baseUrl` in tsconfig is deprecated; we already drop it. New
  deprecations may surface when bumping to 6.x or 7.0.

Then:

```sh
mise exec -- pnpm up typescript@<version>       # update package.json + lockfile
mise run typecheck                              # see deprecation warnings
```

If new deprecations fire, decide: fix the underlying config, or add
`"ignoreDeprecations": "<version>"` to silence (and capture as a TODO).

## Updating biome

biome bumps majors aggressively (1.x → 2.x renamed config keys). Use the
built-in migration tool:

```sh
mise exec -- pnpm up @biomejs/biome@<version>
mise exec -- pnpm exec biome migrate --write    # auto-rewrites biome.json
make lint && make format-check
```

The migrate command updates the schema URL and any renamed keys. Eyeball the
diff to confirm it didn't disable any rules you wanted enabled.

## Updating vitest

Vitest is fast-moving but its config API is mostly stable. Read the changelog
for major bumps. The most common breakage is `defineConfig` import location
or test API changes.

```sh
mise exec -- pnpm up vitest@<version>
make test
```

## Updating the build base image (`electronuserland/builder`)

The base image lives at the top of [`.development/Dockerfile`](../.development/Dockerfile).
We pin to a tag (e.g., `:wine`); for stronger reproducibility, pin to a
digest:

```dockerfile
FROM electronuserland/builder:wine@sha256:<digest> AS base
```

To bump:

```sh
docker pull electronuserland/builder:wine
docker inspect --format='{{index .RepoDigests 0}}' electronuserland/builder:wine
# copy the digest into the Dockerfile
make docker-quality                             # verify
make docker-dist                                # verify
```

Update the FROM line in [`.development/Dockerfile`](../.development/Dockerfile)
and (when it exists in Phase 1+) `.release/Dockerfile`. Both files should be
updated together — they share the same base for production parity.

## Cleanup

After major changes, prune stale artifacts:

```sh
make clean                                      # node_modules + dist + coverage
mise exec -- pnpm store prune                   # global pnpm store
docker system prune                             # docker layers (be careful)
```

## What CI verifies after an upgrade

Push the upgrade as its own PR. CI runs:

- `quality-check.yml` — typecheck, lint, format-check, test (parallel jobs,
  inside the rebuilt Docker container — so the new tool versions are
  exercised end-to-end)
- `_package.yml` — full `tsc --project tsconfig.build.json` build, dist
  artifact uploaded

If CI is green, the upgrade is safe to merge. If anything is red, fix it in
the same PR — never merge a half-broken upgrade and "we'll fix it next time."
