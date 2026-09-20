"""Qualified CoreML/DirectML adapter around python-audio-separator."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from .artifacts import verify_model
from .media import MediaProcessingError, inspect_lossless_audio
from .provider_adapter import (
    Provider,
    provider_session,
)
from .recipes import MODEL_FILENAME


class SeparatorError(RuntimeError):
    """Raised when the qualified separation adapter cannot safely run."""


class KimSeparator:
    def __init__(
        self,
        provider: Provider,
        model_path: Path,
        *,
        directml_device_id: int = 0,
        profile_directory: Path | None = None,
    ) -> None:
        self.provider = provider
        self.model_path = verify_model(model_path)
        self.directml_device_id = directml_device_id
        self.profile_directory = profile_directory
        self._profile_sessions: list[Any] = []
        self._profiles_finished = False
        self._separator = self._load()

    def _load(self) -> Any:
        try:
            from audio_separator.separator import Separator

            with provider_session(
                self.provider,
                self.directml_device_id,
                profile_directory=self.profile_directory,
            ) as sessions:
                separator = Separator(
                    log_level=logging.WARNING,
                    model_file_dir=str(self.model_path.parent),
                    output_dir=str(self.model_path.parent),
                    output_format="FLAC",
                    output_single_stem="Vocals",
                    use_soundfile=True,
                    use_directml=self.provider == "directml",
                )
                separator.load_model(model_filename=MODEL_FILENAME)
                self._profile_sessions.extend(sessions)
            return separator
        except Exception as error:  # third-party errors are sanitized at this boundary
            raise SeparatorError("Kim model could not be loaded") from error

    def separate(self, source: Path, output_directory: Path) -> Path:
        if output_directory.exists():
            shutil.rmtree(output_directory)
        output_directory.mkdir(parents=True)
        try:
            self._separator.output_dir = str(output_directory)
            model = getattr(self._separator, "model_instance", None)
            if model is None:
                raise SeparatorError("Kim model is unavailable")
            model.output_dir = str(output_directory)
            reset = getattr(model, "clear_file_specific_paths", None)
            if reset is not None:
                reset()
            filenames = self._separator.separate(
                str(source), custom_output_names={"Vocals": "vocals"}
            )
            if not isinstance(filenames, list) or len(filenames) != 1:
                raise SeparatorError("Kim separator did not return one vocal stem")
            vocal = (output_directory / filenames[0]).resolve(strict=True)
            if (
                not vocal.is_relative_to(output_directory.resolve(strict=True))
                or vocal.is_symlink()
                or not vocal.is_file()
            ):
                raise SeparatorError("Kim separator output path is invalid")
            inspect_lossless_audio(vocal)
            return vocal
        except (MediaProcessingError, OSError, RuntimeError) as error:
            if isinstance(error, SeparatorError):
                raise
            raise SeparatorError("Kim separation failed") from error

    def finish_profiles(self) -> tuple[Path, ...]:
        if self.profile_directory is None or not self._profile_sessions:
            raise SeparatorError("Kim provider profiling is unavailable")
        if self._profiles_finished:
            raise SeparatorError("Kim provider profiling already finished")
        self._profiles_finished = True
        try:
            return tuple(
                Path(session.end_profiling()).resolve(strict=True)
                for session in self._profile_sessions
            )
        except (OSError, RuntimeError, ValueError) as error:
            raise SeparatorError(
                "Kim provider profile could not be finalized"
            ) from error
