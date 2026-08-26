#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR=${CODEX_MOBILE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-mobile-web}
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [ -z "${CODEX_MOBILE_APP_SERVER_URL:-}" ]; then
  if [ -z "${CODEX_MOBILE_CODEX_PATH:-}" ]; then
    CODEX_MOBILE_CODEX_PATH=$(command -v codex || true)
    export CODEX_MOBILE_CODEX_PATH
  fi
  if [ -z "${CODEX_MOBILE_CODEX_PATH:-}" ]; then
    echo "Codex was not found. Install and sign in to Codex, or set CODEX_MOBILE_CODEX_PATH." >&2
    exit 1
  fi
fi

SECRET_FILE="$STATE_DIR/secret.txt"
if [ ! -f "$SECRET_FILE" ]; then
  umask 077
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' > "$SECRET_FILE"
  echo "Created a bridge password at $SECRET_FILE"
fi

export CODEX_MOBILE_SECRET_FILE="$SECRET_FILE"
export CODEX_MOBILE_SEEN_FILE="$STATE_DIR/seen-threads.json"
export CODEX_MOBILE_THREAD_LIST_CACHE_FILE="$STATE_DIR/thread-list-cache.json"
export CODEX_MOBILE_UPLOAD_ROOT="$STATE_DIR/uploads"
export CODEX_MOBILE_HOST=${CODEX_MOBILE_HOST:-127.0.0.1}
export CODEX_MOBILE_PORT=${CODEX_MOBILE_PORT:-4780}

cd "$ROOT"
exec node server.mjs
