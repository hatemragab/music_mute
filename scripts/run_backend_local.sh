#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="$project_dir/vocal_remover_backend"
venv_python="$backend_dir/.venv/bin/python"

if [[ -x "$venv_python" ]]; then
  python_bin="$venv_python"
elif command -v python3 >/dev/null 2>&1; then
  python_bin="$(command -v python3)"
else
  echo "Python 3 was not found. Install Python or create vocal_remover_backend/.venv." >&2
  exit 1
fi

if ! "$python_bin" -c "import uvicorn" >/dev/null 2>&1; then
  echo "Uvicorn is not installed for $python_bin." >&2
  echo "Install backend dependencies with:" >&2
  echo "  $python_bin -m pip install -r $backend_dir/requirements.txt" >&2
  exit 1
fi

cd "$backend_dir"
export APP_ENV="${APP_ENV:-development}"
export PYTHONUNBUFFERED=1

exec "$python_bin" -m uvicorn app.main:app \
  --reload \
  --host 0.0.0.0 \
  --port "${PORT:-8000}"
