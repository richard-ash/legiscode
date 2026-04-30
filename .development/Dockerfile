# syntax=docker/dockerfile:1.7
#
# Multi-stage build for LegisCode.
#
# Base image: electronuserland/builder:wine
#   - Ubuntu + electron-builder + wine for cross-compiling Windows installers
#     (used in Phase 1+ when feat/electron-shell + feat/build-pipeline
#     introduce real Electron packaging).
#   - The base image's bundled Node version is overridden via mise so that
#     `mise.toml` is the single source of truth for Node + pnpm versions
#     across local dev AND CI. No drift.
#   - https://github.com/electron-userland/electron-builder/tree/master/docker
#
# Stages:
#   base    — system + mise + Node + pnpm at versions pinned in mise.toml.
#   deps    — `pnpm install --frozen-lockfile` (cached against pnpm-lock.yaml).
#   source  — deps + copied source/test/config files; used by quality-check
#             to run typecheck, lint, format, and test inside a container
#             that exactly matches what gets packaged.
#   build   — source + `tsc --project tsconfig.build.json` output. Phase 1+
#             will append `electron-builder` invocations here.
#   dist    — scratch stage holding only the build artifacts, so buildx
#             `outputs: type=local,dest=./dist` exports just dist/.

FROM electronuserland/builder:wine AS base
WORKDIR /app

# Install mise.
RUN curl -fsSL https://mise.run | sh

# Put mise's shims on PATH so plain `node`, `pnpm`, etc. resolve to the
# versions mise has installed.
ENV PATH="/root/.local/bin:/root/.local/share/mise/shims:${PATH}"
ENV MISE_DATA_DIR="/root/.local/share/mise"

# Install Node + pnpm at versions pinned in mise.toml.
COPY mise.toml ./
RUN mise trust && mise install

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS source
COPY tsconfig.json tsconfig.build.json biome.json vitest.config.ts ./
COPY src/ ./src/
COPY test/ ./test/

FROM source AS build
RUN pnpm exec tsc --project tsconfig.build.json
# Phase 1+ — when feat/electron-shell adds Electron, append something like:
#   COPY electron/ ./electron/
#   COPY electron-builder.yml ./
#   RUN pnpm exec electron-builder --linux --win

# Final extract stage: only the artifacts we want to ship.
FROM scratch AS dist
COPY --from=build /app/dist /
