"""Prepare comparable local inputs for the Kim Vocal 2 audio-separator benchmark."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
from pathlib import Path


DEFAULT_INPUT = Path("/Users/hatemragap/Downloads/test_native_youtube.webm")
DEFAULT_OUTPUT_DIR = Path("/Users/hatemragap/Downloads/out_diffrent_formats")
FORMATS = (
    ("pcm16_wav", ".wav", "encode", ("-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2")),
    ("pcm16_flac", ".flac", "encode", ("-c:a", "flac", "-sample_fmt", "s16", "-ar", "44100", "-ac", "2")),
    ("mp3_160k", ".mp3", "encode", ("-c:a", "libmp3lame", "-b:a", "160k", "-ar", "44100", "-ac", "2")),
    ("opus_ogg_copy", ".ogg", "remux", ("-c:a", "copy")),
)


def probe(path: Path, ffprobe: str) -> dict[str, object]:
    completed = subprocess.run(
        [
            ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
            "format=duration,size:stream=codec_name,sample_rate,channels", "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(completed.stdout)
    stream = data["streams"][0]
    return {
        "durationSeconds": float(data["format"]["duration"]),
        "bytes": int(data["format"]["size"]),
        "codec": stream["codec_name"],
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
    }


def check_uvr_loader(path: Path) -> dict[str, object]:
    """Exercise the two readers used by audio-separator before model inference."""
    import librosa
    import soundfile as sf

    try:
        info = sf.info(path)
        audio, sample_rate = librosa.load(path, mono=False, sr=44_100, duration=1.0)
        if audio.size == 0 or sample_rate != 44_100:
            raise ValueError("UVR loader returned empty or unexpected audio")
        return {
            "accepted": True,
            "soundfileSubtype": info.subtype,
            "loadedSampleRate": sample_rate,
        }
    except (OSError, RuntimeError, ValueError) as error:
        return {"accepted": False, "errorType": type(error).__name__}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()
    source = args.input.expanduser().resolve(strict=True)
    if not source.is_file():
        parser.error("input must be a regular file")
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    destinations = [output_dir / f"{source.stem}_{name}{suffix}" for name, suffix, _, _ in FORMATS]
    report_path = output_dir / "ffmpeg_format_timings.json"
    if any(path.exists() for path in [*destinations, report_path]):
        parser.error("an output already exists; choose a new --output-dir to preserve earlier results")

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if ffmpeg is None or ffprobe is None:
        parser.error("ffmpeg and ffprobe must be installed")
    os.umask(0o077)
    source_info = probe(source, ffprobe)
    results: list[dict[str, object]] = []
    for (name, _, operation, codec_args), destination in zip(FORMATS, destinations, strict=True):
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
            "-protocol_whitelist", "file", "-i", str(source),
            "-map", "0:a:0", "-vn", *codec_args, str(destination),
        ]
        started = time.perf_counter()
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        ffmpeg_seconds = time.perf_counter() - started
        if completed.returncode != 0:
            raise RuntimeError(f"FFmpeg failed for {name}: {completed.stderr[-1000:]}")
        output_info = probe(destination, ffprobe)
        if abs(output_info["durationSeconds"] - source_info["durationSeconds"]) > 0.25:
            raise RuntimeError(f"Decoded duration changed unexpectedly for {name}")
        loader = check_uvr_loader(destination)
        result = {
            "format": name,
            "operation": operation,
            "file": destination.name,
            "ffmpegSeconds": round(ffmpeg_seconds, 3),
            **output_info,
            "uvrLoader": loader,
        }
        results.append(result)
        print(
            f"{name}: {ffmpeg_seconds:.3f}s FFmpeg, {output_info['bytes']} bytes, "
            f"UVR loader {'accepted' if loader['accepted'] else 'rejected'}",
            flush=True,
        )

    report = {
        "input": str(source),
        "inputInfo": source_info,
        "note": "One FFmpeg run per format; Ogg Opus is remuxed without re-encoding. UVR check loads one second, not the full model.",
        "results": results,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"report: {report_path}")


if __name__ == "__main__":
    main()
