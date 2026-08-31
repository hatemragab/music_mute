"""python-audio-separator (ONNX) wrapper — import-safe.

Models are baked into the image under MODEL_DIR (default /app/models, override
via env MODEL_DIR). Heavy deps (audio_separator, onnxruntime, torch) are
imported lazily so this module is importable without them.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List

# PLAN.md 3.1 / 5 — env DEFAULT_MODEL controls default; MODEL_DIR baked in image.
MODEL_MAP: dict[str, str] = {
    "UVR-MDX-NET-Inst_HQ_3": "UVR-MDX-NET-Inst_HQ_3.onnx",
    "Kim_Vocal_2": "Kim_Vocal_2.onnx",
    "htdemucs": "htdemucs",
}

# Valid stems values per API (main.py) — used to map outputs.
_STEM_SETS: dict[str, list[str]] = {
    # model -> default stems it naturally produces; caller may filter via `stems` arg
    "UVR-MDX-NET-Inst_HQ_3": ["vocals", "instrumental"],
    "Kim_Vocal_2": ["vocals"],
    "htdemucs": ["vocals", "drums", "bass", "other"],
}


def _model_dir() -> Path:
    return Path(os.environ.get("MODEL_DIR", "/app/models"))


def _model_filename(model_name: str) -> str:
    try:
        return MODEL_MAP[model_name]
    except KeyError as exc:
        raise ValueError(f"Unknown model {model_name!r}. Valid: {sorted(MODEL_MAP)}") from exc


def _model_path(model_name: str) -> Path:
    return _model_dir() / _model_filename(model_name)


class SeparatorWrapper:
    """Thin wrapper around audio_separator.Separator with module-level caching.

    Usage:
        w = SeparatorWrapper.get("UVR-MDX-NET-Inst_HQ_3")
        out_wavs = w.separate("/tmp/input.wav", model="UVR-MDX-NET-Inst_HQ_3", stems="2stems")

    The underlying Separator is loaded lazily on first get(); subsequent gets
    return the cached instance. Import of audio_separator happens lazily too so
    that the module is import-safe without heavy deps.
    """

    # Module-level cache keyed by model_name
    _instances: dict[str, "SeparatorWrapper"] = {}

    def __init__(self, model_name: str, separator: object) -> None:
        self.model_name = model_name
        self._separator = separator  # audio_separator.Separator instance

    @classmethod
    def get(cls, model_name: str) -> "SeparatorWrapper":
        """Return cached wrapper for model_name, loading it if needed."""
        if model_name in cls._instances:
            return cls._instances[model_name]

        filename = _model_filename(model_name)
        mpath = _model_path(model_name)

        # For htdemucs the Separator may expect a model name rather than a file;
        # still validate that something plausible is configured. For ONNX models,
        # require the file to exist with a clear error so Cloud Run Job logs are
        # actionable (image-baked models missing = build bug).
        if model_name != "htdemucs" and not mpath.is_file():
            raise FileNotFoundError(
                f"Model file not found for {model_name!r}: {mpath} "
                f"(MODEL_DIR={_model_dir()}). Ensure the ONNX model is baked into the image "
                f"under { _model_dir() }/ or set MODEL_DIR to its location."
            )

        try:
            from audio_separator.separator import Separator  # type: ignore
        except ImportError as exc:
            raise ImportError(
                "python-audio-separator is required for separation. "
                "Install with `pip install audio-separator[gpu]` or `audio-separator` (CPU, ONNX)."
            ) from exc

        # Separator API: Separator(model_filename=..., output_dir="/tmp", use_autocast=False)
        # Some versions accept `model_file_dir`; we set output_dir to /tmp and let
        # the caller pass per-job output dirs via separate().
        try:
            sep = Separator(
                model_filename=str(filename),
                output_dir="/tmp",
                use_autocast=False,
            )
        except TypeError:
            # Older/newer API compat: try alternate kw names.
            try:
                sep = Separator(
                    model_file_dir=str(_model_dir()),
                    output_dir="/tmp",
                    use_autocast=False,
                )
            except Exception as e2:
                raise RuntimeError(f"Failed to construct audio_separator.Separator: {e2}") from e2
        except Exception as exc:
            raise RuntimeError(f"Failed to construct audio_separator.Separator for {model_name!r}: {exc}") from exc

        inst = cls(model_name, sep)
        cls._instances[model_name] = inst
        return inst

    @classmethod
    def clear_cache(cls) -> None:
        """Clear the instance cache (useful in tests)."""
        cls._instances.clear()

    def separate(self, input_wav: str | os.PathLike[str], model: str | None = None, stems: str = "2stems") -> List[str]:
        """Run separation on input_wav. Returns list of output wav paths.

        Args:
            input_wav: Path to 44.1 kHz stereo wav (caller should have ffmpeg-converted).
            model: Model name override (defaults to this wrapper's model_name).
            stems: One of "vocals" | "2stems" | "4stems" — hint for which outputs
                   to keep. For MDX models, "vocals" keeps only vocals; "2stems"
                   keeps vocals+instrumental; "4stems" is only meaningful for htdemucs.

        Returns:
            List of absolute wav file paths produced by the separator. Order is not
            guaranteed; caller should map by filename.

        Raises:
            FileNotFoundError if input_wav does not exist.
            RuntimeError if the separator call fails.
        """
        src = str(input_wav)
        if not Path(src).is_file():
            raise FileNotFoundError(f"Input wav not found: {src!r}")
        use_model = model or self.model_name
        if use_model not in MODEL_MAP:
            raise ValueError(f"Unknown model {use_model!r}. Valid: {sorted(MODEL_MAP)}")

        sep: object = self._separator
        # The audio_separator API has varied across versions: some expose
        # `separate(path)` -> list[str], others `separate(audio_file=...)`.
        # We try both via getattr and call.
        output_files: List[str] | None = None
        last_exc: Exception | None = None
        for kwargs in (
            {"audio_file_path": src},
            {"audio_file": src},
            {"file_path": src},
            {"path": src},
        ):
            try:
                # Prefer keyword invocation
                out = getattr(sep, "separate")(**kwargs)  # type: ignore[arg-type]
                if isinstance(out, (list, tuple)):
                    output_files = [str(x) for x in out]
                elif isinstance(out, str):
                    output_files = [out]
                elif out is None:
                    # Some versions write to output_dir and return None — scan /tmp
                    output_files = None
                else:
                    output_files = [str(out)]
                break
            except TypeError as exc:
                last_exc = exc
                continue
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"Separator failed for {src!r} with {use_model!r}: {exc}") from exc
        else:
            # Positional fallback
            try:
                out = getattr(sep, "separate")(src)  # type: ignore[misc]
                if isinstance(out, (list, tuple)):
                    output_files = [str(x) for x in out]
                elif isinstance(out, str):
                    output_files = [out]
                else:
                    output_files = None
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(
                    f"Separator failed for {src!r} with {use_model!r}: {exc} (last TypeError: {last_exc})"
                ) from exc

        if output_files is None:
            # Scan /tmp for recently written wavs as fallback.
            cands = sorted(Path("/tmp").glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
            output_files = [str(c) for c in cands[:4]] if cands else []
            if not output_files:
                raise RuntimeError(f"Separator produced no output files for {src!r} (model {use_model!r})")

        # Filter / map by stems request.
        stems = (stems or "2stems").strip().lower()
        if use_model == "Kim_Vocal_2":
            # Always vocals-only; ignore 4stems.
            output_files = _filter_by_keywords(output_files, ["vocal"], fallback="keep_all")
            if stems == "vocals" and len(output_files) > 1:
                output_files = output_files[:1]
        elif use_model == "UVR-MDX-NET-Inst_HQ_3":
            if stems == "vocals":
                output_files = _filter_by_keywords(output_files, ["vocal"], fallback="first")
            else:
                # 2stems: expect vocals + instrumental/accompaniment
                pass
        elif use_model == "htdemucs":
            if stems == "vocals":
                output_files = _filter_by_keywords(output_files, ["vocal"], fallback="first")
            elif stems == "2stems":
                output_files = _filter_by_keywords(output_files, ["vocal", "instrument"], fallback="first_two")
            else:  # 4stems — keep all
                pass

        return output_files


def _filter_by_keywords(paths: List[str], keywords: List[str], *, fallback: str = "keep_all") -> List[str]:
    """Keep only paths whose filename contains one of keywords (case-insensitive).

    fallback:
      - keep_all: return original list if no match
      - first: return [first path] if no match
      - first_two: return first two if no match
    """
    low = [p.lower() for p in paths]
    kw_low = [k.lower() for k in keywords]
    matched = [p for p, l in zip(paths, low) if any(k in l for k in kw_low)]
    if matched:
        return matched
    if fallback == "first":
        return paths[:1] if paths else []
    if fallback == "first_two":
        return paths[:2] if paths else []
    return paths


# Convenience: allow `from app.services.separator import MODEL_MAP, SeparatorWrapper`
__all__ = ["MODEL_MAP", "SeparatorWrapper"]
