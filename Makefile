.DEFAULT_GOAL := help
.PHONY: help install dev build-app typecheck lint format format-check test test-e2e build ci clean corpus-rebuild bills-fetch bills-sync docker-build docker-quality docker-dist docker-clean

help: ## Show this help
	@awk 'BEGIN { FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n" } /^[a-zA-Z][a-zA-Z0-9_-]*:.*##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install dependencies (frozen lockfile)
	@mise exec -- pnpm install --frozen-lockfile

dev: ## Run the Electron app in dev mode with HMR (electron-vite)
	@mise run dev

build-app: ## Build main + preload + renderer bundles into out/
	@mise run build:app

typecheck: ## TypeScript typecheck (no emit)
	@mise run typecheck

lint: ## Lint with biome
	@mise run lint

format: ## Format with biome (writes changes)
	@mise run format

format-check: ## Check formatting without writing
	@mise run format:check

test: ## Run vitest test suite
	@mise run test

test-e2e: ## Run Playwright Electron end-to-end tests (builds out/ first)
	@mise run test:e2e

build: ## Compile src/ to dist/ (emits .js + .d.ts + sourcemaps)
	@mise run build

ci: install typecheck lint format-check test ## Full local pipeline (mise — fast feedback)

clean: ## Remove node_modules and build artifacts
	@rm -rf node_modules dist coverage

corpus-rebuild: ## Wipe build/modules and rebuild the SF corpus + pending bills (needs build/downloads/sf.html and a prior bills-fetch)
	@mise run validate:full
	@mise run bills:sync

bills-fetch: ## Scrape SF Legistar for pending bills into build/downloads/bills/ (non-hermetic, never runs in CI)
	@mise run bills:fetch

bills-sync: ## Parse fetched bills into per-module pending-bill bundles (reads build/downloads/bills/bills-index.json)
	@mise run bills:sync

docker-build: ## Build the CI container image (source target)
	@docker buildx build --target source -t legiscode-ci:latest -f .development/Dockerfile --load .

docker-quality: docker-build ## Run the quality checks inside the CI container (mirrors CI)
	@docker run --rm legiscode-ci:latest pnpm exec tsc --noEmit
	@docker run --rm legiscode-ci:latest pnpm exec biome lint .
	@docker run --rm legiscode-ci:latest pnpm exec biome format .
	@docker run --rm legiscode-ci:latest pnpm exec vitest run

docker-dist: ## Build dist/ via Docker, extract to ./dist (mirrors CI build)
	@rm -rf dist
	@docker buildx build --target dist --output type=local,dest=./dist -f .development/Dockerfile .

docker-clean: ## Remove the CI image
	@docker rmi legiscode-ci:latest 2>/dev/null || true
