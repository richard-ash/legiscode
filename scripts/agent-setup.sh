#!/usr/bin/env bash
# One-time setup for the autonomous agent loop (see docs/AGENTS.md).
# Creates the GitHub labels the /decompose and /agent-tick skills rely on.
# Idempotent: re-running is a no-op for labels that already exist.
set -euo pipefail

create() { gh label create "$1" --color "$2" --description "$3" 2>/dev/null \
  && echo "created  $1" || echo "exists   $1"; }

create epic                     6f42c1 "High-level task; gets a feature branch"
create agent-ready              0e8a16 "Decomposed sub-task ready for the agent loop"
create agent-working            fbca04 "Claimed by an /agent-tick run, in progress"
create agent-blocked            b60205 "Needs a human; the loop will skip it"
create agent-needs-human-review 1d76db "PR open and self-reviewed; awaiting your merge"

echo "Labels ready."
