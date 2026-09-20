"""Explicit local D2 runner used for accepted-platform pipeline verification."""

from __future__ import annotations

import argparse
import json
import shutil
import uuid
from pathlib import Path

from .artifacts import install_model_from_file, verified_cached_model
from .media import sha256_base64
from .pipeline import ProcessRequest, RuntimePipeline
from .recipes import RECIPE_DEFINITIONS, recipe_snapshot


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=("coreml", "directml"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--model-source", type=Path)
    parser.add_argument("--recipe", choices=tuple(RECIPE_DEFINITIONS), required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    parser.add_argument("--directml-device-id", type=int, default=0)
    parser.add_argument("--result-file", type=Path)
    arguments = parser.parse_args()

    source = arguments.input.resolve(strict=True)
    work_root = arguments.work_root.resolve(strict=True)
    model_cache = arguments.model_cache.resolve(strict=False)
    if arguments.model_source:
        install_model_from_file(arguments.model_source, model_cache)
    verified_cached_model(model_cache)

    attempt_id = str(uuid.uuid4())
    attempt = work_root / attempt_id
    attempt.mkdir()
    local_input = attempt / f"input{source.suffix.lower()}"
    shutil.copyfile(source, local_input)
    request = ProcessRequest.from_payload(
        {
            "attemptId": attempt_id,
            "attemptDirectory": str(attempt),
            "input": {
                "path": str(local_input),
                "bytes": local_input.stat().st_size,
                "sha256": sha256_base64(local_input),
            },
            "modelCacheRoot": str(model_cache),
            "provider": arguments.provider,
            "directmlDeviceId": arguments.directml_device_id,
            "ffmpegPath": str(arguments.ffmpeg.resolve(strict=True)),
            "ffprobePath": str(arguments.ffprobe.resolve(strict=True)),
            "recipe": recipe_snapshot(arguments.recipe),
        }
    )
    result = RuntimePipeline().process(request)
    serialized = json.dumps(result, sort_keys=True, separators=(",", ":"))
    if arguments.result_file:
        if not arguments.result_file.is_absolute():
            raise ValueError("Result file must be an absolute path")
        result_file = arguments.result_file.resolve(strict=False)
        if result_file.exists():
            raise ValueError("Result file must be a new absolute path")
        result_file.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
