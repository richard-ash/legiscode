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

## Status

Phase 1 (v1.0 wedge) is in flight. The build pipeline parses AmLegal HTML into validated per-section JSON; the Electron app renders the corpus tree, reads sections via typed IPC, manages tabs (VS Code-style: plain click selects, ⌘-click opens in a new tab, ⌘⌥←/→ switches tabs), and resolves citations against the full corpus on ⌘-click — including cross-module references to known external codes (California's 29 codes + US Code + CFR) that surface "not downloaded" popovers when their bundles aren't installed. Roadmap and deferrals live in [`TODOS.md`](./TODOS.md).
