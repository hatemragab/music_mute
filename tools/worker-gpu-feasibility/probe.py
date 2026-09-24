#!/usr/bin/env python3
"""Run a sanitized Kim Vocal 2 hardware-acceleration feasibility probe."""

from __future__ import annotations

import argparse
import ctypes
import gc
import hashlib
import importlib.metadata
import json
import logging
import math
import platform
import subprocess
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
import soundfile as sf

from generate_fixture import generate_fixture

try:
    import resource
except ImportError:  # Windows does not provide the POSIX resource module.
    resource = None  # type: ignore[assignment]

MODEL_FILENAME = "Kim_Vocal_2.onnx"
MODEL_SOURCE = (
    "https://github.com/TRvlvr/model_repo/releases/download/"
    "all_public_uvr_models/Kim_Vocal_2.onnx"
)
DIRECTML_PROVIDER = "DmlExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def installed_ort_distributions() -> dict[str, str]:
    names = ("onnxruntime", "onnxruntime-directml", "onnxruntime-gpu", "onnxruntime-silicon")
    return {name: version for name in names if (version := package_version(name)) is not None}


def validate_environment(provider: str) -> None:
    machine = platform.machine().lower()
    system = platform.system()
    installed = installed_ort_distributions()

    if len(installed) != 1:
        raise RuntimeError(f"exactly one ONNX Runtime distribution is required, found {sorted(installed)}")

    if provider != "directml" or system != "Windows" or machine not in {"amd64", "x86_64"}:
        raise RuntimeError("DirectML proof requires native 64-bit Windows")
    if set(installed) != {"onnxruntime-directml"}:
        raise RuntimeError("DirectML proof requires only the onnxruntime-directml distribution")
    required_provider = DIRECTML_PROVIDER

    available = ort.get_available_providers()
    if required_provider not in available:
        raise RuntimeError(f"required provider {required_provider} is unavailable; found {available}")


def sanitized_gpu_inventory() -> list[dict[str, object]]:
    if platform.system() == "Darwin":
        completed = subprocess.run(
            ["system_profiler", "SPDisplaysDataType", "-json"],
            check=True,
            capture_output=True,
            text=True,
        )
        displays = json.loads(completed.stdout).get("SPDisplaysDataType", [])
        return [
            {
                "name": item.get("sppci_model", item.get("_name", "unknown")),
                "cores": item.get("sppci_cores", "unknown"),
            }
            for item in displays
        ]

    script = (
        "Get-CimInstance Win32_VideoController | "
        "Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        check=True,
        capture_output=True,
        text=True,
    )
    parsed = json.loads(completed.stdout)
    return parsed if isinstance(parsed, list) else [parsed]


class _ProcessMemoryCountersEx(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("page_fault_count", ctypes.c_ulong),
        ("peak_working_set_size", ctypes.c_size_t),
        ("working_set_size", ctypes.c_size_t),
        ("quota_peak_paged_pool_usage", ctypes.c_size_t),
        ("quota_paged_pool_usage", ctypes.c_size_t),
        ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
        ("quota_non_paged_pool_usage", ctypes.c_size_t),
        ("pagefile_usage", ctypes.c_size_t),
        ("peak_pagefile_usage", ctypes.c_size_t),
        ("private_usage", ctypes.c_size_t),
    ]


def windows_peak_working_set_bytes() -> int:
    counters = _ProcessMemoryCountersEx()
    counters.cb = ctypes.sizeof(counters)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_ProcessMemoryCountersEx),
        ctypes.c_ulong,
    ]
    psapi.GetProcessMemoryInfo.restype = ctypes.c_int
    succeeded = psapi.GetProcessMemoryInfo(
        kernel32.GetCurrentProcess(),
        ctypes.byref(counters),
        counters.cb,
    )
    if not succeeded:
        raise ctypes.WinError(ctypes.get_last_error())
    return int(counters.peak_working_set_size)


def max_rss_bytes() -> int:
    if platform.system() == "Windows":
        return windows_peak_working_set_bytes()
    if resource is None:
        raise RuntimeError("max RSS through the resource module is unavailable on this platform")
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Darwin reports bytes; Linux reports KiB.
    return int(value if platform.system() == "Darwin" else value * 1024)


class InstrumentedSession:
    """Transparent session proxy that records model-only inference duration."""

    def __init__(self, inner: ort.InferenceSession) -> None:
        self.inner = inner
        self.run_seconds: list[float] = []

    def run(self, *args: object, **kwargs: object) -> list[np.ndarray]:
        started = time.perf_counter()
        result = self.inner.run(*args, **kwargs)
        self.run_seconds.append(time.perf_counter() - started)
        return result

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


def configure_instrumentation(
    provider: str,
    output_dir: Path,
    directml_device_id: int,
) -> tuple[list[InstrumentedSession], Any]:
    original = ort.InferenceSession
    sessions: list[InstrumentedSession] = []

    def instrumented_session(
        path_or_bytes: object,
        sess_options: ort.SessionOptions | None = None,
        providers: object = None,
        provider_options: object = None,
        **kwargs: object,
    ) -> InstrumentedSession:
        del providers, provider_options
        options = sess_options or ort.SessionOptions()
        options.enable_profiling = True
        options.profile_file_prefix = str(output_dir / f"ort-{provider}")

        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_mem_pattern = False
        selected = [(DIRECTML_PROVIDER, {"device_id": str(directml_device_id)}), CPU_PROVIDER]

        inner = original(path_or_bytes, sess_options=options, providers=selected, **kwargs)
        wrapped = InstrumentedSession(inner)
        sessions.append(wrapped)
        return wrapped

    ort.InferenceSession = instrumented_session  # type: ignore[assignment]
    return sessions, original


def inspect_output(path: Path) -> dict[str, object]:
    info = sf.info(path)
    samples, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    finite = bool(np.isfinite(samples).all())
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    rms = float(math.sqrt(float(np.mean(np.square(samples))))) if samples.size else 0.0
    valid = bool(
        samples.size
        and finite
        and sample_rate == 44_100
        and info.channels == 2
        and info.duration > 0
        and peak > 0
    )
    return {
        "filename": path.name,
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "format": info.format,
        "subtype": info.subtype,
        "sample_rate_hz": sample_rate,
        "channels": info.channels,
        "frames": info.frames,
        "duration_seconds": info.duration,
        "finite_samples": finite,
        "peak": peak,
        "rms": rms,
        "valid": valid,
    }


def summarize_profile(path: Path) -> dict[str, object]:
    events = json.loads(path.read_text(encoding="utf-8"))
    counts: Counter[str] = Counter()
    durations: defaultdict[str, int] = defaultdict(int)
    operator_counts: Counter[str] = Counter()

    for event in events:
        args = event.get("args") or {}
        provider = args.get("provider")
        if not provider:
            continue
        counts[provider] += 1
        durations[provider] += int(event.get("dur") or 0)
        operator = args.get("op_name")
        if operator:
            operator_counts[f"{provider}:{operator}"] += 1

    return {
        "sha256": sha256(path),
        "provider_node_events": dict(sorted(counts.items())),
        "provider_duration_microseconds": dict(sorted(durations.items())),
        "provider_operator_events": dict(sorted(operator_counts.items())),
    }


def resolve_output_paths(output_dir: Path, names: list[str]) -> list[Path]:
    resolved = []
    for name in names:
        path = Path(name)
        resolved.append(path if path.is_absolute() else output_dir / path)
    return resolved


def outputs_are_valid(
    separations: list[dict[str, object]],
    fixture_duration_seconds: float,
    expected_runs: int,
) -> bool:
    if len(separations) != expected_runs:
        return False
    outputs = [output for separation in separations for output in separation["outputs"]]
    return bool(outputs) and all(
        output["valid"]
        and abs(float(output["duration_seconds"]) - fixture_duration_seconds) <= 0.1
        for output in outputs
    )


def run_probe(args: argparse.Namespace) -> dict[str, object]:
    validate_environment(args.provider)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.model_dir.mkdir(parents=True, exist_ok=True)

    fixture_path = args.fixture or (args.output_dir / "fixture.wav")
    fixture_identity = generate_fixture(fixture_path)
    model_path = args.model_dir / MODEL_FILENAME
    if not model_path.is_file():
        raise FileNotFoundError(
            f"missing {model_path}; download it explicitly with the documented command before probing"
        )

    sessions, original_session = configure_instrumentation(
        args.provider,
        args.output_dir,
        args.directml_device_id,
    )
    before_rss = max_rss_bytes()

    try:
        from audio_separator.separator import Separator

        separator = Separator(
            log_level=logging.INFO,
            model_file_dir=str(args.model_dir),
            output_dir=str(args.output_dir),
            output_format="WAV",
            output_single_stem="Vocals",
            use_soundfile=True,
            use_directml=args.provider == "directml",
        )

        load_started = time.perf_counter()
        separator.load_model(MODEL_FILENAME)
        load_seconds = time.perf_counter() - load_started
        after_load_rss = max_rss_bytes()

        separations = []
        output_paths: list[Path] = []
        for run_index in range(args.runs):
            started = time.perf_counter()
            names = separator.separate(
                str(fixture_path),
                custom_output_names={"Vocals": f"fixture-vocals-run-{run_index + 1}"},
            )
            elapsed = time.perf_counter() - started
            output_paths = resolve_output_paths(args.output_dir, names)
            separations.append(
                {
                    "run": run_index + 1,
                    "classification": "cold" if run_index == 0 else "warm",
                    "end_to_end_seconds": elapsed,
                    "outputs": [inspect_output(path) for path in output_paths],
                }
            )

        after_inference_rss = max_rss_bytes()

        profiles = []
        model_run_seconds = []
        active_providers = []
        for session in sessions:
            active_providers.append(session.get_providers())
            model_run_seconds.extend(session.run_seconds)
            profile_path = Path(session.end_profiling())
            profiles.append(summarize_profile(profile_path))
            profile_path.unlink()

        expected_provider = DIRECTML_PROVIDER
        accelerated_events = sum(
            profile["provider_node_events"].get(expected_provider, 0) for profile in profiles
        )
        output_valid = outputs_are_valid(
            separations,
            float(fixture_identity["duration_seconds"]),
            args.runs,
        )

        return {
            "schema_version": 1,
            "observed_at_utc": datetime.now(UTC).isoformat(),
            "result": "PASS" if accelerated_events > 0 and output_valid else "FAIL",
            "provider_target": args.provider,
            "provider_dispatch_proven": accelerated_events > 0,
            "expected_provider": expected_provider,
            "host": {
                "os": platform.system(),
                "os_release": platform.release(),
                "os_version": platform.version(),
                "architecture": platform.machine(),
                "python": platform.python_version(),
                "gpu_inventory": sanitized_gpu_inventory(),
            },
            "packages": {
                "audio-separator": package_version("audio-separator"),
                "audioread": package_version("audioread"),
                "numpy": package_version("numpy"),
                "onnxruntime_distributions": installed_ort_distributions(),
                "soundfile": package_version("soundfile"),
                "torch": package_version("torch"),
                "torch-directml": package_version("torch-directml"),
            },
            "available_providers": ort.get_available_providers(),
            "active_session_providers": active_providers,
            "directml_device_id": args.directml_device_id,
            "model": {
                "filename": MODEL_FILENAME,
                "source": MODEL_SOURCE,
                "sha256": sha256(model_path),
                "bytes": model_path.stat().st_size,
                "redistribution_status": "not assessed; model is not committed by this probe",
            },
            "fixture": fixture_identity,
            "timing": {
                "cold_model_load_seconds": load_seconds,
                "model_run_seconds": model_run_seconds,
                "separations": separations,
            },
            "memory": {
                "max_rss_bytes_before_load": before_rss,
                "max_rss_bytes_after_load": after_load_rss,
                "max_rss_bytes_after_inference": after_inference_rss,
            },
            "profiles": profiles,
            "limitations": [
                "The synthetic fixture proves execution and output structure, not separation quality.",
                (
                    "Profile node events prove ONNX Runtime provider dispatch; "
                    "they do not measure GPU utilization percentage."
                ),
                "Pre/post-processing may use CPU or platform tensor acceleration outside the ONNX provider.",
            ],
        }
    finally:
        ort.InferenceSession = original_session  # type: ignore[assignment]
        gc.collect()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("directml",), required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--directml-device-id", type=int, default=0)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.runs < 2:
        parser.error("--runs must be at least 2 to include cold and warm evidence")
    if args.directml_device_id < 0:
        parser.error("--directml-device-id must be non-negative")
    return args


def main() -> None:
    args = parse_args()
    report = run_probe(args)
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(payload, encoding="utf-8")
    print(payload, end="")
    if report["result"] != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
