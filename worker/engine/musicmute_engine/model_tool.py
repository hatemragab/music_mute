"""Install one pre-authorized Kim artifact into the private service cache."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .artifacts import ModelArtifactError, install_model_from_file
from .recipes import MODEL_BYTES, MODEL_SHA256


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        installed = install_model_from_file(arguments.source, arguments.model_cache)
    except (ModelArtifactError, OSError):
        print("MusicMute model installation: FAILED", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "status": "ok",
                "modelSha256": MODEL_SHA256,
                "modelBytes": MODEL_BYTES,
                "modelPath": str(installed),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
