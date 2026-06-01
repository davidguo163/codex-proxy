#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CODEX_PROXY_URL:=http://127.0.0.1:18080}"
export CODEX_PROXY_URL
exec npm run import-openai-device-account -- "$@"
