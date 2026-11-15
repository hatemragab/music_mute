"""Fixed Store entry around the unchanged repeated GPU file benchmark."""
from __future__ import annotations

from .store_benchmark_context import run_store_benchmark, store_benchmark_cli


def main() -> int:
    return run_store_benchmark("benchmark_file", __file__)


if __name__ == "__main__":
    raise SystemExit(store_benchmark_cli("benchmark_file", __file__))
