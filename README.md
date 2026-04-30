# LegisCode

Legislative IDE for reading, analyzing, and understanding municipal code as an interconnected system.

- **Design system:** [`DESIGN.md`](./DESIGN.md)
- **Development guide (start here):** [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)
- **Plans + ADRs:** `~/.gstack/projects/legiscode/`

## Quick start

```bash
make install     # pnpm install --frozen-lockfile
make ci          # full pipeline: install + typecheck + lint + format-check + test
make help        # list all targets
```

Full setup (mise + Node + pnpm install): see [`docs/development/setup.md`](./docs/development/setup.md).

`mise.toml` owns tasks; `Makefile` is a thin wrapper. `package.json` has no `scripts`.

## Phase 0 status

This branch (`feat/repo-baseline`) ships dev infrastructure only — no business logic. Type stubs in `src/types/` are intentionally empty; `feat/corpus-parser` (Phase 1) fills them from real AmLegal HTML and ships runtime validators alongside.
