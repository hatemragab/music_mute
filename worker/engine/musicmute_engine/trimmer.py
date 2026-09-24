"""Reference-compatible internal vocal-gap trimming."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

from .limits import CHANNELS, MAX_LOSSLESS_SAMPLES, SAMPLE_RATE


@dataclass(frozen=True)
class EditRange:
    source_start: int
    source_end: int
    output_start: int
    output_end: int


@dataclass(frozen=True)
class TrimResult:
    audio_path: Path
    source_samples: int
    output_samples: int
    sample_rate: int
    channels: int
    retained_ranges: tuple[EditRange, ...]

    @property
    def removed_samples(self) -> int:
        return self.source_samples - self.output_samples


def trim_vocal_gaps(
    source: Path,
    destination: Path,
    threshold_db: float = -32,
    min_silence: float = 0.6,
    padding: float = 0.2,
    *,
    reuse_unchanged: bool = False,
) -> TrimResult:
    """Trim quiet gaps using 10 ms RMS windows and retained vocal padding."""
    _validate_parameters(threshold_db, min_silence, padding)
    import numpy as np
    import soundfile as sf

    with sf.SoundFile(source) as stream:
        rate, channels, samples = stream.samplerate, stream.channels, len(stream)
        if (
            rate != SAMPLE_RATE
            or channels != CHANNELS
            or samples <= 0
            or samples > MAX_LOSSLESS_SAMPLES
        ):
            raise ValueError("Vocal input sample count is outside worker limits")
        frame = max(1, round(rate * 0.01))
        count = (samples + frame - 1) // frame
        silent = np.empty(count, dtype=np.bool_)
        threshold = 10 ** (threshold_db / 20)
        cursor = 0
        while cursor < count:
            audio = stream.read(frame * 1024, dtype="float32", always_2d=True)
            if stream.subtype != "PCM_16" and not np.isfinite(audio).all():
                raise ValueError("Vocal input contains non-finite samples")
            complete = len(audio) // frame
            if complete:
                groups = audio[: complete * frame].reshape(complete, frame, channels)
                rms = np.sqrt(np.mean(groups**2, axis=1)).max(axis=1)
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
        cuts: list[tuple[int, int]] = []
        pad = round(padding * rate)
        for first, last in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
            start, end = int(first * frame), min(int(last * frame), samples)
            if end - start >= round(min_silence * rate):
                left = start + (pad if start > 0 else 0)
                right = end - (pad if end < samples else 0)
                if right > left:
                    cuts.append((left, right))

        keep: list[tuple[int, int]] = []
        cursor = 0
        for left, right in cuts:
            if left > cursor:
                keep.append((cursor, left))
            cursor = right
        if cursor < samples:
            keep.append((cursor, samples))
        if not keep:
            keep = [(0, samples)]

        if reuse_unchanged and keep == [(0, samples)]:
            return TrimResult(
                audio_path=source,
                source_samples=samples,
                output_samples=samples,
                sample_rate=rate,
                channels=channels,
                retained_ranges=(EditRange(0, samples, 0, samples),),
            )

        destination.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        edit_map: list[EditRange] = []
        with sf.SoundFile(
            destination,
            "w",
            samplerate=rate,
            channels=channels,
            format="WAV",
            subtype="PCM_16",
        ) as target:
            for start, end in keep:
                output_start = written
                stream.seek(start)
                fade = min(round(rate * 0.005), (end - start) // 2)
                ramp = (
                    np.linspace(0, 1, fade, dtype=np.float32)[:, None] if fade else None
                )
                position = start
                while position < end:
                    block = stream.read(
                        min(65536, end - position),
                        dtype="float32",
                        always_2d=True,
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
                    pcm16 = np.rint(block * 32768).clip(-32768, 32767).astype(np.int16)
                    target.write(pcm16)
                    written += len(block)
                    position += len(block)
                edit_map.append(EditRange(start, end, output_start, written))

    return TrimResult(
        audio_path=destination,
        source_samples=samples,
        output_samples=written,
        sample_rate=rate,
        channels=channels,
        retained_ranges=tuple(edit_map),
    )


def _validate_parameters(
    threshold_db: float, min_silence: float, padding: float
) -> None:
    values = (threshold_db, min_silence, padding)
    if any(isinstance(value, bool) or not math.isfinite(value) for value in values):
        raise ValueError("Trimmer parameters must be finite numbers")
    if threshold_db >= 0:
        raise ValueError("Trimmer threshold must be below 0 dBFS")
    if min_silence <= 0:
        raise ValueError("Minimum silence must be positive")
    if padding < 0 or 2 * padding >= min_silence:
        raise ValueError("Trimmer padding must be nonnegative and below half the gap")
