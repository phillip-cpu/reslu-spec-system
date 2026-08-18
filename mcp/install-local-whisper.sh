#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
venv_dir="$script_dir/.venv-whisper"
cache_dir="$script_dir/.whisper-cache"
python_bin="${RESLU_LOCAL_WHISPER_BOOTSTRAP_PYTHON:-/opt/homebrew/bin/python3}"
model="${RESLU_LOCAL_WHISPER_MODEL:-mlx-community/whisper-small-mlx}"

if [[ ! -x "$python_bin" ]]; then
  echo "Python 3 is required at $python_bin." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required. Install it with: brew install ffmpeg" >&2
  exit 1
fi

"$python_bin" -m venv "$venv_dir"
"$venv_dir/bin/python3" -m pip install --disable-pip-version-check --require-virtualenv -r "$script_dir/requirements-whisper.lock"
"$venv_dir/bin/python3" -c 'import mlx_whisper; print("PASS — mlx-whisper is installed locally")'

if [[ "${RESLU_LOCAL_WHISPER_PRELOAD:-1}" == "1" ]]; then
  HF_HOME="$cache_dir" RESLU_PRELOAD_MODEL="$model" "$venv_dir/bin/python3" -c \
    'import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id=os.environ["RESLU_PRELOAD_MODEL"]); print("PASS — local Whisper model is cached")'
else
  echo "Model preload skipped; weights will download on the first transcription."
fi
