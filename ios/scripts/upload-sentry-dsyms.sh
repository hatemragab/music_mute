#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1/dSYMs" ]]; then
  echo "Usage: upload-sentry-dsyms.sh <MusicMute.xcarchive>" >&2
  exit 2
fi
if [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
  echo "SENTRY_AUTH_TOKEN is required for dSYM upload" >&2
  exit 2
fi
cli="${SENTRY_CLI:-sentry-cli}"
if ! command -v "$cli" >/dev/null 2>&1; then
  echo "Sentry CLI is required for dSYM upload" >&2
  exit 2
fi

"$cli" debug-files upload \
  --org vchat-9f \
  --project musicmute-ios \
  --type dsym \
  --no-sources \
  --wait-for 60 \
  "$1/dSYMs"
