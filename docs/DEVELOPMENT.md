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

## Docker development

The [Makefile](../Makefile) wraps Docker Buildx for the same image CI builds. Use this to reproduce CI behaviour locally.

To build the CI container and run all checks inside it:

```shell
make docker-build       # build the CI image (source target)
make docker-quality     # run typecheck, lint, format-check, test inside it
```

To build the dist artifact via Docker (extracts to local `./dist`):

```shell
make docker-dist
```

To remove the CI image:

```shell
make docker-clean
```

### Debugging inside the container

Drop into a shell on the CI image to inspect tool versions, run individual commands, or reproduce a failure exactly as CI sees it:

```shell
docker run --rm -it legiscode-ci:latest sh
```

From there: `pnpm exec tsc --noEmit`, `pnpm exec biome lint .`, `pnpm exec vitest run`, etc.

## Documentation

- [`DESIGN.md`](../DESIGN.md) — visual design system
- [`README.md`](../README.md) — quick start
- `~/.gstack/projects/legiscode/` — feature plans, ADRs, branch decomposition (out of tree)
