.DEFAULT_GOAL := help
.PHONY: help install typecheck lint format format-check test build ci clean \
        ci-build ci-quality ci-dist ci-clean \
        dev-up dev-status dev-stop dev-rebuild dev-down dev-shell dev-claude dev-logs

help: ## Show this help
	@awk 'BEGIN { FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n" } /^[a-zA-Z][a-zA-Z0-9_-]*:.*##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# --- Host workflow (mise) ---

install: ## Install dependencies (frozen lockfile)
	@mise exec -- pnpm install --frozen-lockfile

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

build: ## Compile src/ to dist/ (emits .js + .d.ts + sourcemaps)
	@mise run build

ci: install typecheck lint format-check test ## Full local pipeline (mise — fast feedback)

clean: ## Remove node_modules and build artifacts
	@rm -rf node_modules dist coverage

# --- CI image (.development/Dockerfile) — reproduces what GitHub Actions builds ---

ci-build: ## Build the CI container image (source target)
	@docker buildx build --target source -t legiscode-ci:latest -f .development/Dockerfile --load .

ci-quality: ci-build ## Run quality checks inside the CI container (mirrors CI)
	@docker run --rm legiscode-ci:latest pnpm exec tsc --noEmit
	@docker run --rm legiscode-ci:latest pnpm exec biome lint .
	@docker run --rm legiscode-ci:latest pnpm exec biome format .
	@docker run --rm legiscode-ci:latest pnpm exec vitest run

ci-dist: ## Build dist/ via Docker, extract to ./dist (mirrors CI build)
	@rm -rf dist
	@docker buildx build --target dist --output type=local,dest=./dist -f .development/Dockerfile .

ci-clean: ## Remove the CI image
	@docker rmi legiscode-ci:latest 2>/dev/null || true

# --- Devcontainer (.devcontainer/Dockerfile) — sandboxed env for autonomous agents ---

dev-up: ## Start the devcontainer
	@devcontainer up --workspace-folder .

dev-status: ## Show whether the devcontainer is running
	@id=$$(docker ps -qf "label=devcontainer.local_folder=$(CURDIR)"); \
	if [ -n "$$id" ]; then echo "Devcontainer is running ($$id)"; \
	else echo "Devcontainer is not running"; fi

dev-stop: ## Stop the devcontainer (keeps the container)
	@id=$$(docker ps -aqf "label=devcontainer.local_folder=$(CURDIR)"); \
	if [ -n "$$id" ]; then docker stop $$id; else echo "No devcontainer running"; fi

dev-rebuild: ## Tear down and start fresh
	@$(MAKE) dev-down
	@devcontainer up --workspace-folder . --remove-existing-container

dev-down: ## Stop and remove the devcontainer + named volumes
	@id=$$(docker ps -aqf "label=devcontainer.local_folder=$(CURDIR)"); \
	if [ -n "$$id" ]; then docker rm -f $$id >/dev/null && echo "Devcontainer removed: $$id"; \
	else echo "No devcontainer to remove"; fi
	@for vol in $$(basename $(CURDIR))-node-modules $$(basename $(CURDIR))-pnpm-store $$(basename $(CURDIR))-mise; do \
		if docker volume inspect $$vol >/dev/null 2>&1; then \
			docker volume rm $$vol >/dev/null && echo "Volume removed: $$vol"; \
		fi; \
	done

dev-shell: ## Open an interactive shell inside the devcontainer
	@exec devcontainer exec --workspace-folder . bash

dev-claude: ## Run Claude Code in YOLO mode inside the devcontainer
	@exec devcontainer exec --workspace-folder . claude --dangerously-skip-permissions

dev-logs: ## Tail the Squid access log inside the devcontainer
	@exec devcontainer exec --workspace-folder . tail -f /var/log/squid/access.log
