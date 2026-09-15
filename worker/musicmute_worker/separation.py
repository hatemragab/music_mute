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


def peak_ram_bytes():
    """Process host memory only; unified/dedicated GPU memory remains unknown."""
    import sys

    if os.name != "nt":
        import resource

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (
            1 if sys.platform == "darwin" else 1024
        )
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t)
            for name in (
                "PeakWorkingSetSize",
                "WorkingSetSize",
                "QuotaPeakPagedPoolUsage",
                "QuotaPagedPoolUsage",
                "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage",
                "PagefileUsage",
                "PeakPagefileUsage",
            )
        ]

    value = Counters()
    value.cb = ctypes.sizeof(value)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(Counters),
        wintypes.DWORD,
    ]
    if not psapi.GetProcessMemoryInfo(
        kernel.GetCurrentProcess(), ctypes.byref(value), value.cb
    ):
        return None
    return value.PeakWorkingSetSize


def monitor_resources(max_ram_bytes: int, directory: Path):
    """Terminate this isolated runtime if host RSS or diagnostic storage exceeds limits.

    A 100ms sampler is a measured guard, not a native OS allocation reservation;
    platform service containment still owns abrupt-exit descendant verification.
    """
    import threading

    if type(max_ram_bytes) is not int or not 0 < max_ram_bytes <= 1024**4:
        raise ValueError("Invalid memory limit")

    def watch():
        while True:
            peak = peak_ram_bytes()
            if peak is None or peak > max_ram_bytes:
                os._exit(78)
            try:
                if (
                    sum(path.stat().st_size for path in directory.glob("*.log"))
                    > 32 * 1024**2
                ):
                    os._exit(78)
            except OSError:
                os._exit(78)
            time.sleep(0.1)

    threading.Thread(target=watch, daemon=True, name="runtime-resource-guard").start()


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


class KimSpectrogram:
    """Kim Vocal 2 MDX transform, batch one, CPU signal processing only.

    Numerical semantics follow audio-separator v0.47.0 MDX/STFT (MIT;
    see worker/qualification/THIRD_PARTY_NOTICES.md). Neural inference has no
    CPU path. Keeping DSP in NumPy removes unrelated model-family dependencies.
    """

    n_fft = 7680
    hop = 1024
    bins = 3072
    chunk = 261120
    trim = 3840

    def __init__(self):
        import numpy as np

        self.window = (
            0.5 - 0.5 * np.cos(2 * np.pi * np.arange(self.n_fft) / self.n_fft)
        ).astype(np.float32)

    def forward(self, audio):
        import numpy as np

        if audio.shape != (1, 2, self.chunk) or not np.isfinite(audio).all():
            raise ValueError("Invalid model audio tensor")
        padded = np.pad(audio[0], ((0, 0), (self.trim, self.trim)), mode="reflect")
        frames = np.lib.stride_tricks.sliding_window_view(padded, self.n_fft, axis=-1)[
            :, :: self.hop
        ]
        spectrum = np.fft.rfft(frames * self.window, axis=-1).transpose(0, 2, 1)
        return (
            np.stack((spectrum.real, spectrum.imag), axis=1)
            .reshape(1, 4, self.n_fft // 2 + 1, 256)[:, :, : self.bins]
            .astype(np.float32)
        )

    def inverse(self, spectrum):
        import numpy as np

        if spectrum.shape != (1, 4, self.bins, 256) or not np.isfinite(spectrum).all():
            raise ValueError("Invalid model output tensor")
        padded = np.pad(
            spectrum.reshape(2, 2, self.bins, 256),
            ((0, 0), (0, 0), (0, self.n_fft // 2 + 1 - self.bins), (0, 0)),
        )
        complex_values = padded[:, 0] + 1j * padded[:, 1]
        frames = (
            np.fft.irfft(
                complex_values.transpose(0, 2, 1), n=self.n_fft, axis=-1
            ).astype(np.float32)
            * self.window
        )
        output = np.zeros((2, self.chunk + self.n_fft), dtype=np.float32)
        divisor = np.zeros(self.chunk + self.n_fft, dtype=np.float32)
        for index in range(256):
            start = index * self.hop
            output[:, start : start + self.n_fft] += frames[:, index]
            divisor[start : start + self.n_fft] += self.window**2
        output = output[:, self.trim : -self.trim]
        divisor = divisor[self.trim : -self.trim]
        if np.any(divisor <= 0):
            raise ValueError("Invalid inverse transform window")
        return (output / divisor)[None]


def gpu_session(model: Path, provider: str, options: dict, profile_prefix: Path):
    import numpy as np
    import onnxruntime as ort

    # Direct script invocation and package imports share this sole implementation.
    from musicmute_worker.profiles import (
        KIM_BYTES,
        KIM_SHA256,
        digest_file,
        provider_options,
    )

    provider_options(provider, options)
    if (
        model.is_symlink()
        or model.stat().st_size != KIM_BYTES
        or digest_file(model) != KIM_SHA256
    ):
        raise RuntimeError("MODEL_INTEGRITY_FAILED")
    if provider not in ort.get_available_providers():
        raise RuntimeError("GPU_PROVIDER_UNAVAILABLE")
    settings = ort.SessionOptions()
    settings.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
    settings.add_free_dimension_override_by_name("batch_size", 1)
    settings.enable_profiling = True
    settings.profile_file_prefix = str(profile_prefix)
    settings.log_severity_level = 0 if provider == "CoreMLExecutionProvider" else 3
    settings.log_verbosity_level = 1
    settings.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    settings.enable_mem_pattern = False
    from musicmute_worker.qualification import execution_evidence

    # Native CoreML compute plans use stderr, not Python logging. Capture in the
    # isolated single-session child before it can report ready.
    native_path = profile_prefix.with_suffix(".native.log")
    saved_stderr = os.dup(2)
    try:
        with native_path.open("wb") as native:
            os.dup2(native.fileno(), 2)
            session = ort.InferenceSession(
                str(model), sess_options=settings, providers=[(provider, options)]
            )
            session.disable_fallback()
            warm_output = session.run(
                None, {"input": np.zeros((1, 4, 3072, 256), dtype=np.float32)}
            )
            if len(warm_output) != 1 or not np.isfinite(warm_output[0]).all():
                raise RuntimeError("GPU_QUALIFICATION_FAILED")
    finally:
        os.dup2(saved_stderr, 2)
        os.close(saved_stderr)
    profile_path = Path(session.end_profiling())
    if (
        native_path.stat().st_size > 32 * 1024**2
        or profile_path.stat().st_size > 32 * 1024**2
    ):
        raise RuntimeError("GPU_QUALIFICATION_FAILED")
    execution_evidence(
        json.loads(profile_path.read_text()),
        provider,
        native_path.read_text(errors="replace"),
    )
    session.musicmute_profile_path = profile_path
    session.musicmute_native_path = native_path
    if provider not in session.get_providers():
        raise RuntimeError("GPU_PROVIDER_UNAVAILABLE")
    inputs = session.get_inputs()
    if (
        len(inputs) != 1
        or inputs[0].name != "input"
        or inputs[0].shape != [1, 4, 3072, 256]
    ):
        raise RuntimeError("MODEL_INTEGRITY_FAILED")
    return session


class KimSeparator:
    """One pinned model, fixed upstream default overlap/denoise, vocals only."""

    def __init__(self, session, output_dir: Path, max_duration_seconds: int):
        self.session = session
        self.output_dir = output_dir
        self.max_duration_seconds = max_duration_seconds
        self.dsp = KimSpectrogram()

    def demix(self, mix):
        import numpy as np

        dsp = self.dsp
        length = mix.shape[-1]
        gen_size = dsp.chunk - 2 * dsp.trim
        pad = gen_size + dsp.trim - length % gen_size
        mixture = np.pad(mix, ((0, 0), (dsp.trim, pad)))
        result = np.zeros_like(mixture, dtype=np.float32)
        divider = np.zeros(mixture.shape[-1], dtype=np.float32)
        # Upstream defaults: overlap .25, segment 256, batch 1, denoise false.
        for start in range(0, mixture.shape[-1], int(0.75 * dsp.chunk)):
            end = min(start + dsp.chunk, mixture.shape[-1])
            size = end - start
            chunk = np.pad(mixture[:, start:end], ((0, 0), (0, dsp.chunk - size)))
            spectrum = dsp.forward(chunk[None])
            spectrum[:, :, :3, :] = 0
            predicted = self.session.run(None, {"input": spectrum})[0]
            waveform = dsp.inverse(predicted)[0, :, :size]
            window = np.hanning(size)
            # Match upstream's float32 in-place multiply and accumulations.
            waveform *= window
            result[:, start:end] += waveform
            divider[start:end] += window
        selected = slice(dsp.trim, dsp.trim + length)
        if np.any(divider[selected] <= 0):
            raise ValueError("Invalid overlap window")
        output = result[:, selected] / divider[selected]
        if not np.isfinite(output).all():
            raise ValueError("Nonfinite vocal output")
        return output

    def separate(self, source):
        import numpy as np
        import soundfile as sf

        with sf.SoundFile(source) as audio:
            if (
                audio.channels != 2
                or audio.samplerate != 44100
                or not 0 < len(audio) <= 44100 * self.max_duration_seconds
            ):
                raise ValueError("Unsupported prepared audio")
            mix = audio.read(dtype="float32", always_2d=True).T
        if not np.isfinite(mix).all():
            raise ValueError("Nonfinite prepared audio")
        peak = float(np.abs(mix).max())
        if peak > 0.9:
            mix *= 0.9 / peak
        source = self.demix(mix) * peak
        peak_output = float(np.abs(source).max())
        if peak_output > 0.9:
            source *= 0.9 / peak_output
        self.output_dir.mkdir(parents=True, exist_ok=True)
        filename = "Kim_Vocal_2_Vocals.flac"
        # Match the pinned default pydub writer: scale by 32767 then truncate.
        # The later trimmed WAV intentionally retains its separate W01 rounding.
        pcm = (source.T * 32767).astype(np.int16)
        sf.write(self.output_dir / filename, pcm, 44100, subtype="PCM_16")
        return [filename]


def load_separator(
    work_output: Path, model_dir: Path, runtime_path: Path | None = None
):
    if runtime_path is None:
        raise RuntimeError("DEPENDENCY_RECIPE_UNAVAILABLE")
    if runtime_path.is_symlink() or runtime_path.stat().st_size > 65536:
        raise RuntimeError("DEPENDENCY_RECIPE_UNAVAILABLE")
    runtime = json.loads(runtime_path.read_text())
    if runtime.get("status") != "qualified":
        raise RuntimeError("GPU_QUALIFICATION_FAILED")
    monitor_resources(runtime["maxRamBytes"], work_output.parent)
    model = Path(runtime["model"])
    if not model.is_absolute() or not model.is_relative_to(model_dir):
        raise RuntimeError("MODEL_INTEGRITY_FAILED")
    session = gpu_session(
        model, runtime["provider"], runtime["options"], work_output.parent / "ort"
    )
    return KimSeparator(session, work_output, runtime["maxDurationSeconds"])


def qualify_audio(request_path: Path):
    """Isolated diagnostic entry point; never imports worker transport/identity."""
    import numpy as np
    import soundfile as sf
    from musicmute_worker.profiles import digest_file

    if request_path.stat().st_size > 65536:
        raise ValueError("Invalid qualification request")
    request = json.loads(request_path.read_text())
    work = request_path.parent
    monitor_resources(request["maxRamBytes"], work)
    # RLIMIT_AS cannot safely bound Apple's shared GPU mappings; memory is sampled
    # by the parent and platform-specific hard limits are native-adapter duties.
    model = Path(request["model"])
    if digest_file(model) != request["modelSha256"]:
        raise ValueError("MODEL_INTEGRITY_FAILED")
    session = gpu_session(model, request["provider"], request["options"], work / "ort")
    stems = work / "stems"
    separator = KimSeparator(session, stems, request["maxDurationSeconds"])
    encoded = work / "encoded"
    process_audio(separator, request["input"], encoded, stems, work, request["ffmpeg"])
    output, rate = sf.read(
        stems / "Kim_Vocal_2_Vocals.flac", dtype="float32", always_2d=True
    )
    final_files = list(encoded.glob("*.mp3"))
    if len(final_files) != 1:
        raise ValueError("Invalid encoded vocal output")
    decoded_path = work / "decoded.wav"
    subprocess.run(
        [
            request["ffmpeg"],
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            str(final_files[0]),
            "-c:a",
            "pcm_s16le",
            str(decoded_path),
        ],
        check=True,
        timeout=30,
    )
    decoded, decoded_rate = sf.read(decoded_path, dtype="float32", always_2d=True)
    valid = (
        rate == 44100
        and output.shape[1] == 2
        and len(output) > 0
        and bool(np.isfinite(output).all())
        and decoded_rate == 44100
        and decoded.shape[1] == 2
        and len(decoded) > 0
        and bool(np.isfinite(decoded).all())
    )
    reference_passed = False
    if request["reference"]:
        reference, reference_rate = sf.read(
            request["reference"], dtype="float32", always_2d=True
        )
        if (
            reference_rate == rate
            and reference.shape == output.shape
            and np.isfinite(reference).all()
        ):
            difference = output.astype(np.float64) - reference
            reference_passed = (
                float(np.max(np.abs(difference))) <= request["referenceMaxAbs"]
                and float(np.sqrt(np.mean(difference**2))) <= request["referenceRms"]
            )
    peak_ram = peak_ram_bytes()
    if peak_ram is not None and peak_ram > request["maxRamBytes"]:
        raise ValueError("INSUFFICIENT_MEMORY")
    shutil.copyfile(session.musicmute_profile_path, work / "profile.json")
    shutil.copyfile(session.musicmute_native_path, work / "placement.log")
    (work / "result.json").write_text(
        json.dumps(
            {
                "outputValid": valid,
                "referenceCheckPassed": reference_passed,
                "peakRamBytes": peak_ram,
            }
        )
    )


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


def serve(
    directory: Path,
    session: str,
    ffmpeg: str,
    model_dir: Path,
    runtime_path: Path | None = None,
) -> int:
    directory = directory.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="audio-", dir=directory) as temporary:
        work = Path(temporary)
        stems = work / "stems"
        started = time.monotonic()
        try:
            separator = (
                load_separator(stems, model_dir, runtime_path)
                if runtime_path
                else load_separator(stems, model_dir)
            )
        except Exception:  # noqa: BLE001 - sanitize third-party model failures at IPC boundary
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
            except Exception:  # noqa: BLE001 - sanitize third-party processing failures at IPC boundary
                _write_message(
                    directory,
                    "response.json",
                    {"id": identifier, "status": "error", "error": "SEPARATION_FAILED"},
                )
                return 1


def main():
    import sys

    if len(sys.argv) == 3 and sys.argv[1] == "--qualify":
        qualify_audio(Path(sys.argv[2]).resolve(strict=True))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--ffmpeg", type=Path)
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
    if not args.model_dir.is_absolute():
        parser.error("An absolute model cache path is required")
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
    ffmpeg = str(args.ffmpeg) if args.ffmpeg else shutil.which("ffmpeg")
    if not ffmpeg:
        parser.error("FFmpeg is not available on PATH")
    if args.serve is not None:
        if (
            args.input is not None
            or not args.session_id
            or re.fullmatch("[0-9a-f]{32}", args.session_id) is None
        ):
            parser.error("Serve requires a session identifier and no input argument")
        raise SystemExit(
            serve(args.serve, args.session_id, ffmpeg, args.model_dir, args.runtime)
        )
    if args.input is None:
        parser.error("An input file is required")
    source = args.input.resolve()
    if not source.is_file():
        parser.error(f"Input file does not exist: {source}")
    with tempfile.TemporaryDirectory(prefix="music-remover-") as temporary:
        work = Path(temporary)
        wav = prepare_audio(source, work, ffmpeg, prepared=args.prepared)
        stems = work / "stems"
        separator = load_separator(stems, args.model_dir, args.runtime)
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
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    main()
