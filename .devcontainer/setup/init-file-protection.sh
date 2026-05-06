#!/bin/bash
# Protect sensitive files from the in-container agent.
#
# 1. Bind-mount empty placeholders over paths listed in protected-paths.txt
#    so the container sees empty files / empty directories. The host is
#    unaffected.
# 2. Generate a Claude project-level settings.json with deny rules as a
#    secondary safeguard against accidental Read calls.
#
# Must run as root (mount --bind requires it).

set -euo pipefail

# Fix ownership of Docker volume mounts (created as root by default). The
# named volume mounts in devcontainer.json land here.
[ -d /workspace/node_modules ] && chown dev:dev /workspace/node_modules
[ -d /home/dev/.local/share/pnpm/store ] && chown -R dev:dev /home/dev/.local/share/pnpm/store
[ -d /home/dev/.local/share/mise ] && chown -R dev:dev /home/dev/.local/share/mise

# --- Protect sensitive files ---
shadow_path() {
    [ -e "$1" ] || return 0
    # Skip if already shadowed (idempotent across container restarts).
    if mountpoint -q "$1"; then
        echo "  Already protected: $1"
        return 0
    fi
    local target="/tmp/protected-$(echo "$1" | tr '/' '-')"
    if [ -f "$1" ]; then
        touch "$target"
    elif [ -d "$1" ]; then
        mkdir -p "$target"
    fi
    mount --bind "$target" "$1"
    echo "  Protected: $1"
}

# Prefer the workspace copy (always up to date) over the baked-in image copy.
if [ -f "/workspace/.devcontainer/protected-paths.txt" ]; then
    PROTECTED_PATHS="/workspace/.devcontainer/protected-paths.txt"
else
    PROTECTED_PATHS="/etc/devcontainer/protected-paths.txt"
fi

if [ -f "$PROTECTED_PATHS" ]; then
    while IFS= read -r pattern; do
        [[ "$pattern" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${pattern// }" ]] && continue

        if [[ "$pattern" == *"**"* ]]; then
            find /workspace -name "${pattern##*\*\*/}" 2>/dev/null | while IFS= read -r match; do
                shadow_path "$match"
            done
        else
            for match in /workspace/$pattern; do
                shadow_path "$match"
            done
        fi
    done < "$PROTECTED_PATHS"
else
    echo "No protected-paths.txt found, skipping"
fi

# --- Set up Claude project settings ---
DEV_HOME="/home/dev"
PROJECT_DIR="${DEV_HOME}/.claude/projects/-workspace"
SETTINGS_FILE="${PROJECT_DIR}/settings.json"

mkdir -p "$PROJECT_DIR"
chown -R dev:dev "$PROJECT_DIR"

DENY_RULES="[]"
if [ -f "$PROTECTED_PATHS" ]; then
    while IFS= read -r pattern || [ -n "$pattern" ]; do
        [[ "$pattern" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${pattern// }" ]] && continue
        if [[ "$pattern" != *'**'* ]]; then
            pattern="**/$pattern"
        fi
        DENY_RULES=$(echo "$DENY_RULES" | jq --arg rule "Read(path:${pattern})" '. + [$rule]')
    done < "$PROTECTED_PATHS"
fi

# Merge deny rules into existing settings (preserves user-added config).
if [ -f "$SETTINGS_FILE" ]; then
    UPDATED=$(jq --argjson rules "$DENY_RULES" '.permissions.deny = $rules' "$SETTINGS_FILE")
    echo "$UPDATED" > "$SETTINGS_FILE"
    echo "Updated Claude settings: $SETTINGS_FILE"
else
    jq -n --argjson rules "$DENY_RULES" '{"permissions": {"deny": $rules}}' > "$SETTINGS_FILE"
    echo "Created Claude settings: $SETTINGS_FILE"
fi
chown dev:dev "$SETTINGS_FILE"
