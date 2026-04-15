#!/usr/bin/env bash
set -euo pipefail

exec bun /app/packages/claudraband-cli/dist/bin.js "$@"
