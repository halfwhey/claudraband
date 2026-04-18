#!/usr/bin/env bash
set -euo pipefail

account_dir="${CLAUDE_ACCOUNT_DIR:-/claude-account}"
default_host="${CBAND_DEFAULT_HOST:-0.0.0.0}"
default_port="${CBAND_DEFAULT_PORT:-7842}"
runtime_home="${HOME:-/root}"
runtime_claude_dir="${runtime_home}/.claude"
runtime_claude_json="${runtime_home}/.claude.json"
runtime_credentials_json="${runtime_claude_dir}/.credentials.json"

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
  [ -f "$runtime_claude_json" ] && [ -d "$runtime_claude_dir" ]
}

not_onboarded_error() {
  local detail="$1"

  cat >&2 <<EOF
error: Claude account state is mounted but onboarding is incomplete.

${detail}

Expected:
  - ${runtime_claude_json} with "hasCompletedOnboarding": true
  - ${runtime_credentials_json} as a non-empty file

Run the image once in "claude" mode with the same /claude-account mount to
finish onboarding, then retry "serve".
EOF
  exit 1
}

require_onboarded_account_state() {
  local status=0

  set +e
  bun - "$runtime_claude_json" "$runtime_credentials_json" <<'EOF'
const fs = require("node:fs");

const configPath = process.argv[2];
const credentialsPath = process.argv[3];

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  process.exit(10);
}

if (!parsed || parsed.hasCompletedOnboarding !== true) {
  process.exit(11);
}

let stat;
try {
  stat = fs.statSync(credentialsPath);
} catch {
  process.exit(12);
}

if (!stat.isFile() || stat.size < 2) {
  process.exit(13);
}
EOF
  status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    return
  fi
  case "$status" in
    10)
      not_onboarded_error "${runtime_claude_json} is missing or contains invalid JSON."
      ;;
    11)
      not_onboarded_error "${runtime_claude_json} does not indicate completed onboarding."
      ;;
    12)
      not_onboarded_error "Missing credential file at ${runtime_credentials_json}."
      ;;
    13)
      not_onboarded_error "${runtime_credentials_json} is empty."
      ;;
    *)
      not_onboarded_error "Claude account state could not be validated."
      ;;
  esac
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
    rm -rf "$runtime_claude_dir" "$runtime_claude_json"
    ln -s "$account_dir/.claude" "$runtime_claude_dir"
    ln -s "$account_dir/.claude.json" "$runtime_claude_json"
    return
  fi

  if bundle_account_dir_available; then
    initialize_bundle_account_state
    rm -rf "$runtime_claude_dir" "$runtime_claude_json"
    ln -s "$account_dir/.claude" "$runtime_claude_dir"
    ln -s "$account_dir/.claude.json" "$runtime_claude_json"
    return
  fi

  if legacy_account_ready; then
    return
  fi

  cat >&2 <<EOF
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
  - host-account/.claude.json -> ${runtime_claude_json}
  - host-account/.claude      -> ${runtime_claude_dir}
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

  if ! has_flag --permission-mode "${serve_args[@]}"; then
    serve_args=(--permission-mode auto "${serve_args[@]}")
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
    require_onboarded_account_state
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
