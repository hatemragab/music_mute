"""Extract Kim Vocal 2 vocals, trim silent gaps, and save a compact MP3."""

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from datetime import datetime, timezone

_PROTOCOL_LIMIT = 16 * 1024
_IPC_RETRY_SECONDS = 2.0


def trim_vocal_gaps(
    source, destination, threshold_db=-45, min_silence=0.8, padding=0.2
):
    """Preserve the legacy 10ms louder-channel RMS and 5ms fades, with bounded RAM."""
    import numpy as np
    import soundfile as sf

    with sf.SoundFile(source) as stream:
        rate, channels, samples = stream.samplerate, stream.channels, len(stream)
        frame = max(1, round(rate * 0.01))
        count = (samples + frame - 1) // frame
        silent = np.empty(count, dtype=np.bool_)
        threshold = 10 ** (threshold_db / 20)
        # Reshape complete 10ms groups without changing sample/channel reduction
        # order. The partial final group must use its actual sample count.
        cursor = 0
        while cursor < count:
            audio = stream.read(frame * 1024, dtype="float32", always_2d=True)
            complete = len(audio) // frame
            if complete:
                groups = audio[: complete * frame].reshape(complete, frame, channels)
                rms = np.sqrt(np.mean(groups**2, axis=1)).max(axis=1)
                # Legacy float(np.float32) compared against a Python float.
                silent[cursor : cursor + complete] = rms.astype("float64") < threshold
                cursor += complete
            tail = audio[complete * frame :]
            if len(tail):
                silent[cursor] = (
                    float(np.sqrt(np.mean(tail**2, axis=0)).max()) < threshold
                )
                cursor += 1
            if not len(audio):
                raise ValueError("Vocal input ended before its declared frame count")

        flags = np.zeros(count + 2, dtype=np.int8)
        flags[1:-1] = silent
        edges = np.diff(flags)
        cuts = []
        pad = round(padding * rate)
        for first, last in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
            start, end = int(first * frame), min(int(last * frame), samples)
            if end - start >= round(min_silence * rate):
                left = start + (pad if start > 0 else 0)
                right = end - (pad if end < samples else 0)
                if right > left:
                    cuts.append((left, right))
        keep, cursor = [], 0
        for left, right in cuts:
            if left > cursor:
                keep.append((cursor, left))
            cursor = right
        if cursor < samples:
            keep.append((cursor, samples))
        if not keep:
            print(
                "All vocals are below the threshold; preserving audio. Try a lower --silence_db."
            )
            keep = [(0, samples)]

        written = 0
        with sf.SoundFile(
            destination, "w", samplerate=rate, channels=channels, subtype="PCM_16"
        ) as target:
            for start, end in keep:
                stream.seek(start)
                fade = min(round(rate * 0.005), (end - start) // 2)
                ramp = (
                    np.linspace(0, 1, fade, dtype=np.float32)[:, None] if fade else None
                )
                position = start
                while position < end:
                    block = stream.read(
                        min(65536, end - position), dtype="float32", always_2d=True
                    )
                    if not len(block):
                        raise ValueError("Vocal input ended during retained write")
                    if fade and start > 0 and position < start + fade:
                        length = min(len(block), start + fade - position)
                        offset = position - start
                        block[:length] *= ramp[offset : offset + length]
                    if fade and end < samples and position + len(block) > end - fade:
                        offset = max(0, end - fade - position)
                        ramp_offset = position + offset - (end - fade)
                        block[offset:] *= ramp[::-1][
                            ramp_offset : ramp_offset + len(block) - offset
                        ]
                    # Preserve the former FLAC writer's nearest-integer PCM16
                    # quantization; writing floats to WAV truncates instead.
                    pcm16 = np.rint(block * 32768).clip(-32768, 32767).astype(np.int16)
                    target.write(pcm16)
                    written += len(block)
                    position += len(block)
    print(
        f"Trimmed vocals: {samples / rate:.2f}s -> {written / rate:.2f}s; removed {(samples - written) / rate:.2f}s",
        flush=True,
    )


def prepare_audio(
    source: Path, temporary: Path, ffmpeg: str, *, prepared=False
) -> Path:
    if prepared:
        import soundfile as sf

        try:
            with sf.SoundFile(source) as audio:
                if (
                    audio.format != "WAV"
                    or audio.subtype != "PCM_16"
                    or audio.channels != 2
                    or audio.samplerate != 44100
                    or len(audio) <= 0
                ):
                    raise ValueError(
                        "Prepared input must be nonempty PCM16 stereo 44100 Hz WAV"
                    )
        except (RuntimeError, OSError) as exc:
            raise ValueError(
                "Prepared input must be PCM16 stereo 44100 Hz WAV"
            ) from exc
        return source
    wav = temporary / (source.stem + ".wav")
    print(f"Extracting audio from {source.name}...", flush=True)
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "pcm_s16le",
            "-ar",
            "44100",
            "-ac",
            "2",
            str(wav),
        ],
        check=True,
    )
    return wav


def load_separator(work_output: Path):
    from audio_separator.separator import Separator

    # Keep the original model stem writer/precision. Only the already-PCM16
    # trimmed intermediate changes from compressed FLAC to uncompressed WAV.
    separator = Separator(
        use_directml=True,
        output_dir=str(work_output),
        output_format="FLAC",
        output_single_stem="Vocals",
    )
    if "DmlExecutionProvider" not in separator.onnx_execution_provider:
        raise RuntimeError(
            "DirectML was not enabled; check your DirectML installation."
        )
    separator.load_model(model_filename="Kim_Vocal_2.onnx")
    return separator


def process_audio(
    separator,
    source,
    output,
    work_output,
    temporary,
    ffmpeg,
    *,
    bitrate="192k",
    silence_db=-45,
    min_silence=0.8,
    padding=0.2,
):
    timings = {}
    # Current audio-separator resets file state itself. Also reset at request
    # boundaries for older installed versions, without releasing the ONNX model.
    model = getattr(separator, "model_instance", None)
    reset = getattr(model, "clear_file_specific_paths", None)
    if reset is not None:
        reset()
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    phase = {
        "runId": output.name,
        "phase": "separating",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "startedMonotonic": started,
    }
    _write_message(output, ".execution.json", phase)
    completed = False
    try:
        filenames = separator.separate(str(source))
        completed = True
    finally:
        timings["separation"] = time.monotonic() - started
        _write_message(
            output,
            ".execution.json",
            {
                **phase,
                "phase": "separated",
                "seconds": timings["separation"],
                "completed": completed,
            },
        )
    if not filenames:
        raise ValueError("Separator produced no vocal output")
    timings["trim"] = timings["encode"] = 0.0
    for filename in filenames:
        vocal = (work_output / filename).resolve()
        if not vocal.is_relative_to(work_output.resolve()) or not vocal.is_file():
            raise ValueError("Separator output is outside its work directory")
        trimmed = vocal.with_name(vocal.stem + "_trimmed.wav")
        started = time.monotonic()
        trim_vocal_gaps(vocal, trimmed, silence_db, min_silence, padding)
        timings["trim"] += time.monotonic() - started
        encoded = temporary / "trimmed.mp3"
        started = time.monotonic()
        subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-i",
                str(trimmed),
                "-map",
                "0:a:0",
                "-c:a",
                "libmp3lame",
                "-b:a",
                bitrate,
                str(encoded),
            ],
            check=True,
        )
        timings["encode"] += time.monotonic() - started
        output.mkdir(parents=True, exist_ok=True)
        destination = output / (trimmed.stem + ".mp3")
        suffix = 1
        while True:
            try:
                with destination.open("xb") as target, encoded.open("rb") as data:
                    shutil.copyfileobj(data, target)
                break
            except FileExistsError:
                destination = output / f"{trimmed.stem}_{suffix}.mp3"
                suffix += 1
        print(
            f"Saved trimmed vocals: {destination} ({destination.stat().st_size / 1_000_000:.2f} MB)"
        )
    return timings


def _write_message(directory: Path, name: str, message: dict) -> None:
    raw = json.dumps({"version": 1, **message}, allow_nan=False).encode("utf-8")
    if len(raw) > _PROTOCOL_LIMIT:
        raise ValueError("Protocol limit exceeded")
    temporary = directory / (name + ".tmp")
    temporary.write_bytes(raw)
    temporary.replace(directory / name)


def _read_request(path: Path) -> bytes:
    # MoveFileEx can publish a name before other opens stop seeing a transient
    # sharing denial. Retry only that Windows condition, with a short deadline.
    deadline = time.monotonic() + _IPC_RETRY_SECONDS
    while True:
        try:
            with path.open("rb") as stream:
                return stream.read(_PROTOCOL_LIMIT + 1)
        except PermissionError:
            if os.name != "nt" or time.monotonic() >= deadline:
                raise
            time.sleep(0.02)


def serve(directory: Path, session: str, ffmpeg: str) -> int:
    directory = directory.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="audio-", dir=directory) as temporary:
        work = Path(temporary)
        stems = work / "stems"
        started = time.monotonic()
        try:
            separator = load_separator(stems)
        except (
            Exception
        ):  # noqa: BLE001 - sanitize third-party model failures at IPC boundary
            _write_message(
                directory,
                "ready.json",
                {"session": session, "status": "error", "error": "MODEL_LOAD_FAILED"},
            )
            return 1
        _write_message(
            directory,
            "ready.json",
            {
                "session": session,
                "status": "ready",
                "timings": {"model_load": time.monotonic() - started},
            },
        )
        while True:
            request = directory / "request.json"
            if not request.exists():
                time.sleep(0.05)
                continue
            identifier = None
            try:
                raw = _read_request(request)
                if len(raw) > _PROTOCOL_LIMIT:
                    raise ValueError("Request exceeds limit")
                data = json.loads(raw)
                if (
                    not isinstance(data, dict)
                    or set(data) != {"version", "id", "input", "output_dir"}
                    or data["version"] != 1
                ):
                    raise ValueError("Invalid request")
                identifier = data["id"]
                if (
                    not isinstance(identifier, str)
                    or re.fullmatch("[0-9a-f]{32}", identifier) is None
                ):
                    identifier = None
                    raise ValueError("Invalid identifier")
                if not all(
                    isinstance(data[key], str) and Path(data[key]).is_absolute()
                    for key in ("input", "output_dir")
                ):
                    raise ValueError("Absolute local paths required")
                source = prepare_audio(Path(data["input"]), work, ffmpeg, prepared=True)
                output = Path(data["output_dir"])
                request.unlink()
            except (ValueError, TypeError, OSError, RuntimeError, RecursionError):
                _write_message(
                    directory,
                    "response.json",
                    {"id": identifier, "status": "error", "error": "INVALID_REQUEST"},
                )
                return 1
            try:
                # Each successful request starts with an empty model output
                # directory; keep its path stable in the loaded model object.
                if stems.exists():
                    shutil.rmtree(stems)
                stems.mkdir()
                timings = process_audio(separator, source, output, stems, work, ffmpeg)
                shutil.rmtree(stems)
                _write_message(
                    directory,
                    "response.json",
                    {"id": identifier, "status": "ok", "timings": timings},
                )
            except (
                Exception
            ):  # noqa: BLE001 - sanitize third-party processing failures at IPC boundary
                _write_message(
                    directory,
                    "response.json",
                    {"id": identifier, "status": "error", "error": "SEPARATION_FAILED"},
                )
                return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, nargs="?", help="Audio or video file")
    parser.add_argument(
        "--output_dir", type=Path, default=Path(__file__).resolve().parent / "output"
    )
    parser.add_argument(
        "--prepared",
        action="store_true",
        help="Input is validated PCM16 stereo 44100 Hz WAV; skip input FFmpeg decode",
    )
    parser.add_argument("--serve", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--session-id", help=argparse.SUPPRESS)
    parser.add_argument(
        "--trim_silence",
        action="store_true",
        default=True,
        help="Trim silent gaps after separation (always enabled; accepted for older commands)",
    )
    parser.add_argument(
        "--bitrate",
        choices=["64k", "96k", "128k", "192k", "256k", "320k"],
        default="192k",
        help="MP3 bitrate (default: 192k; lower means smaller files and more quality loss)",
    )
    parser.add_argument(
        "--silence_db",
        type=float,
        default=-45,
        help="RMS silence threshold in dBFS (default: -45)",
    )
    parser.add_argument(
        "--min_silence",
        type=float,
        default=0.8,
        help="Minimum gap duration in seconds (default: 0.8)",
    )
    parser.add_argument(
        "--padding",
        type=float,
        default=0.2,
        help="Seconds retained next to each phrase (default: 0.2)",
    )
    args = parser.parse_args()
    if not all(
        math.isfinite(v) for v in (args.silence_db, args.min_silence, args.padding)
    ):
        parser.error("Silence settings must be finite numbers")
    if (
        args.silence_db >= 0
        or args.min_silence <= 0
        or args.padding < 0
        or 2 * args.padding >= args.min_silence
    ):
        parser.error(
            "Require silence_db < 0, min_silence > 0, and 0 <= padding < min_silence / 2"
        )
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        parser.error("FFmpeg is not available on PATH")
    if args.serve is not None:
        if (
            args.input is not None
            or not args.session_id
            or re.fullmatch("[0-9a-f]{32}", args.session_id) is None
        ):
            parser.error("Serve requires a session identifier and no input argument")
        raise SystemExit(serve(args.serve, args.session_id, ffmpeg))
    if args.input is None:
        parser.error("An input file is required")
    source = args.input.resolve()
    if not source.is_file():
        parser.error(f"Input file does not exist: {source}")
    with tempfile.TemporaryDirectory(prefix="music-remover-") as temporary:
        work = Path(temporary)
        wav = prepare_audio(source, work, ffmpeg, prepared=args.prepared)
        stems = work / "stems"
        separator = load_separator(stems)
        process_audio(
            separator,
            wav,
            args.output_dir.resolve(),
            stems,
            work,
            ffmpeg,
            bitrate=args.bitrate,
            silence_db=args.silence_db,
            min_silence=args.min_silence,
            padding=args.padding,
        )


if __name__ == "__main__":
    main()
