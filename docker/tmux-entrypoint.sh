#!/usr/bin/env bash
set -euo pipefail

account_dir="${CLAUDE_ACCOUNT_DIR:-/claude-account}"
default_host="${CBAND_DEFAULT_HOST:-0.0.0.0}"
default_port="${CBAND_DEFAULT_PORT:-7842}"

usage() {
  cat <<'EOF'
Usage:
  image serve [cband-serve-args...]
  image claude [claude-args...]

Modes:
  serve     Start claudraband directly as the container process. This is the default mode.
  claude    Launch plain Claude Code directly in the terminal.

Required mounts:
  - host-account -> /claude-account

Expected inside that mounted account directory:
  - .claude.json
  - .claude
EOF
}

bundle_account_ready() {
  [ -f "$account_dir/.claude.json" ] && [ -d "$account_dir/.claude" ]
}

bundle_account_dir_available() {
  [ -d "$account_dir" ]
}

legacy_account_ready() {
  [ -f /root/.claude.json ] && [ -d /root/.claude ]
}

initialize_bundle_account_state() {
  if [ -e "$account_dir/.claude" ] && [ ! -d "$account_dir/.claude" ]; then
    printf 'error: %s/.claude must be a directory.\n' "$account_dir" >&2
    exit 1
  fi

  if [ -e "$account_dir/.claude.json" ] && [ ! -f "$account_dir/.claude.json" ]; then
    printf 'error: %s/.claude.json must be a file.\n' "$account_dir" >&2
    exit 1
  fi

  mkdir -p "$account_dir/.claude"

  if [ ! -e "$account_dir/.claude.json" ] || [ ! -s "$account_dir/.claude.json" ]; then
    printf '{}\n' > "$account_dir/.claude.json"
  fi
}

prepare_account_state() {
  if bundle_account_ready; then
    rm -rf /root/.claude /root/.claude.json
    ln -s "$account_dir/.claude" /root/.claude
    ln -s "$account_dir/.claude.json" /root/.claude.json
    return
  fi

  if bundle_account_dir_available; then
    initialize_bundle_account_state
    rm -rf /root/.claude /root/.claude.json
    ln -s "$account_dir/.claude" /root/.claude
    ln -s "$account_dir/.claude.json" /root/.claude.json
    return
  fi

  if legacy_account_ready; then
    return
  fi

  cat >&2 <<'EOF'
error: Claude account state is not mounted correctly.

Preferred mount:
  - host-account -> /claude-account

Recommended host layout:
  claude-account-1/
    .claude.json
    .claude/

The mounted directory may be empty on first run. The entrypoint will
create `.claude/` and `.claude.json` for you before launching Claude.

Expected inside the mounted account directory:
  - /claude-account/.claude.json as a file
  - /claude-account/.claude as a directory

Legacy direct mounts are also accepted:
  - host-account/.claude.json -> /root/.claude.json
  - host-account/.claude      -> /root/.claude
EOF
  exit 1
}

has_flag() {
  local flag="$1"
  shift
  local arg
  for arg in "$@"; do
    case "$arg" in
      "$flag"|"$flag"=*)
        return 0
        ;;
    esac
  done
  return 1
}

start_serve() {
  local serve_args=("$@")

  if ! has_flag --host "${serve_args[@]}"; then
    serve_args=(--host "$default_host" "${serve_args[@]}")
  fi

  if ! has_flag --port "${serve_args[@]}"; then
    serve_args=(--port "$default_port" "${serve_args[@]}")
  fi

  exec cband serve "${serve_args[@]}"
}

mode="${1:-serve}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  serve)
    prepare_account_state
    start_serve "$@"
    ;;
  claude)
    prepare_account_state
    exec claude "$@"
    ;;
  onboard)
    prepare_account_state
    printf 'warn: "onboard" is deprecated; use "claude" instead.\n' >&2
    exec claude "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    printf 'error: unknown mode: %s\n\n' "$mode" >&2
    usage >&2
    exit 1
    ;;
esac
