#!/usr/bin/env python3
"""Generate synthetic media in a fresh output directory; never download user media."""

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path


def catalog():
    audio = [
        {
            "id": name,
            "file": name + extension,
            "kind": "media",
            "expected": expectation,
            "durationSeconds": duration,
            "codec": codec,
        }
        for name, duration, extension, codec, expectation in [
            ("audio-smoke", 2, ".m4a", "aac", "accept"),
            ("audio-300s", 300, ".m4a", "aac", "accept"),
            ("audio-900s", 900, ".m4a", "aac", "accept"),
            ("audio-1800s", 1800, ".m4a", "aac", "accept"),
            ("duration-below", 1799.999, ".wav", "pcm_s16le", "accept"),
            ("duration-exact", 1800, ".wav", "pcm_s16le", "accept"),
            ("duration-above", 1800.001, ".wav", "pcm_s16le", "reject"),
            ("audio-mp3", 2, ".mp3", "libmp3lame", "accept"),
            ("audio-aac", 2, ".aac", "aac", "inspect"),
            ("audio-alac", 2, ".m4a", "alac", "inspect"),
            ("audio-flac", 2, ".flac", "flac", "inspect"),
            ("audio-aiff", 2, ".aiff", "pcm_s16be", "inspect"),
            ("audio-vorbis", 2, ".ogg", "libvorbis", "inspect"),
            ("audio-opus", 2, ".opus", "libopus", "inspect"),
            ("audio-webm", 2, ".webm", "libopus", "inspect"),
        ]
    ]
    return (
        audio
        + [
            {
                "id": name,
                "file": name + ".bin",
                "kind": "transport",
                "expected": expected,
                "bytes": size,
            }
            for name, size, expected in [
                ("bytes-below", 99_999_999, "within_byte_limit"),
                ("bytes-exact", 100_000_000, "within_byte_limit"),
                ("bytes-above", 100_000_001, "exceeds_byte_limit"),
            ]
        ]
        + [
            {
                "id": "video-default-second",
                "file": "video-default-second.mp4",
                "kind": "media",
                "expected": "extract_default",
                "durationSeconds": 2,
                "defaultAudioTrack": 1,
            },
            {
                "id": "video-no-audio",
                "file": "video-no-audio.mp4",
                "kind": "media",
                "expected": "reject",
                "durationSeconds": 2,
            },
            {
                "id": "corrupt-audio",
                "file": "corrupt-audio.mp3",
                "kind": "invalid",
                "expected": "reject",
            },
            {
                "id": "empty-audio",
                "file": "empty-audio.m4a",
                "kind": "invalid",
                "expected": "reject",
            },
            {
                "id": "spoofed-audio",
                "file": "spoofed-audio.mp3",
                "kind": "invalid",
                "expected": "reject",
            },
        ]
    )


def media_command(item, destination):
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n"]
    if item["id"].startswith("video-"):
        command += ["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10"]
        if item["id"] == "video-default-second":
            command += [
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=48000",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-map",
                "2:a",
                "-c:a",
                "aac",
                "-disposition:a:0",
                "0",
                "-disposition:a:1",
                "default",
                "-metadata:s:a:0",
                "language=eng",
                "-metadata:s:a:1",
                "language=ara",
            ]
        command += ["-c:v", "mpeg4"]
    else:
        sample_rate = 16000 if item["id"].startswith("duration-") else 48000
        command += [
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate={sample_rate}",
            "-c:a",
            item["codec"],
        ]
        if item["codec"] in {"aac", "libmp3lame"}:
            command += ["-b:a", "256k"]
    command += ["-t", str(item["durationSeconds"]), str(destination)]
    return command


def generate(output, identifiers):
    available = {item["id"]: item for item in catalog()}
    if (
        not identifiers
        or len(set(identifiers)) != len(identifiers)
        or any(i not in available for i in identifiers)
    ):
        raise ValueError("Choose distinct known fixture identifiers")
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise FileExistsError("Fixture output must be a new directory")
    selected = [available[i] for i in identifiers]
    if any(item["kind"] == "media" for item in selected) and not all(
        shutil.which(p) for p in ("ffmpeg", "ffprobe")
    ):
        raise RuntimeError("FFmpeg and ffprobe are required for media fixtures")
    output.mkdir(parents=True, exist_ok=False)
    report = {"schemaVersion": 1, "synthetic": True, "fixtures": []}
    for item in selected:
        destination = output / item["file"]
        if item["kind"] == "transport":
            with destination.open("xb") as handle:
                handle.truncate(item["bytes"])
        elif item["kind"] == "invalid":
            data = (
                b""
                if item["id"] == "empty-audio"
                else b"Not decodable audio. Synthetic fixture.\n"
            )
            destination.write_bytes(data)
        else:
            subprocess.run(
                media_command(item, destination),
                check=True,
                capture_output=True,
                timeout=600,
            )
        digest = hashlib.sha256()
        with destination.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        entry = {
            **item,
            "actualBytes": destination.stat().st_size,
            "sha256": digest.hexdigest(),
            "measuredDurationSeconds": None,
            "streamTypes": [],
        }
        if item["kind"] == "media":
            raw = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_streams",
                    "-show_format",
                    "-of",
                    "json",
                    str(destination),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            probe = json.loads(raw.stdout)
            entry["measuredDurationSeconds"] = float(probe["format"]["duration"])
            entry["streamTypes"] = [stream["codec_type"] for stream in probe["streams"]]
            entry["durationEvidence"] = (
                "container_probe; consumers must verify decoded presentation duration"
            )
        report["fixtures"].append(entry)
    (output / "manifest.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--fixtures",
        nargs="+",
        default=[
            "audio-smoke",
            "video-default-second",
            "video-no-audio",
            "corrupt-audio",
        ],
    )
    args = parser.parse_args()
    if args.list:
        print(json.dumps(catalog(), indent=2))
        return 0
    if args.output is None:
        parser.error("--output must name a new directory")
    try:
        result = generate(args.output, args.fixtures)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        print(
            "Fixture generation failed; check tool availability, output ownership, and selected fixtures."
        )
        return 1
    print(
        json.dumps(
            {
                "fixtures": len(result["fixtures"]),
                "manifest": str(args.output / "manifest.json"),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
