#!/usr/bin/env bash
set -euo pipefail

claude_bin="$(find /app/node_modules/.bun -path '*/node_modules/@anthropic-ai/claude-code/cli.js' | head -n 1)"

if [ -z "$claude_bin" ]; then
  echo "error: bundled Claude Code cli.js not found under /app/node_modules/.bun" >&2
  exit 1
fi

exec bun "$claude_bin" "$@"
