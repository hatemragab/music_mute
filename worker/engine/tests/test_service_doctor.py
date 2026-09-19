from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from musicmute_engine.service_doctor import (
    ServiceDoctorError,
    executable_version,
    validate_media_runtime,
)


class ServiceDoctorTests(unittest.TestCase):
    def test_executable_version_is_bounded_and_sanitized(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "ffmpeg"
            executable.write_text("#!/bin/sh\nprintf 'ffmpeg version test\\n'\n")
            executable.chmod(0o755)
            self.assertEqual(executable_version(executable), "ffmpeg version test")

    def test_symlinked_executable_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "real"
            executable.write_text("#!/bin/sh\nexit 0\n")
            executable.chmod(0o755)
            link = Path(directory) / "link"
            link.symlink_to(executable)
            with self.assertRaisesRegex(ServiceDoctorError, "unsafe"):
                executable_version(link)

    def test_failed_executable_is_rejected(self) -> None:
        completed = mock.Mock(returncode=2, stdout=b"failure\n")
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "ffmpeg"
            executable.write_text("#!/bin/sh\nexit 2\n")
            executable.chmod(0o755)
            with mock.patch("subprocess.run", return_value=completed):
                with self.assertRaisesRegex(ServiceDoctorError, "failed"):
                    executable_version(executable)

    def test_media_runtime_requires_exact_offline_capabilities(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ffmpeg = self._executable(Path(directory) / "ffmpeg")
            ffprobe = self._executable(Path(directory) / "ffprobe")
            completed = [
                mock.Mock(
                    returncode=0,
                    stdout=b"ffmpeg version 8.0.3 Copyright test\n",
                ),
                mock.Mock(
                    returncode=0,
                    stdout=b"ffprobe version 8.0.3 Copyright test\n",
                ),
                mock.Mock(returncode=0, stdout=b" A....D libmp3lame MP3\n"),
                mock.Mock(
                    returncode=0,
                    stdout=(
                        b" TS afftdn A->A\n"
                        b" .. aresample A->A\n"
                        b" T. silenceremove A->A\n"
                    ),
                ),
                mock.Mock(returncode=0, stdout=b"Input:\n  file\n  pipe\n"),
            ]
            with mock.patch("subprocess.run", side_effect=completed):
                self.assertEqual(
                    validate_media_runtime(ffmpeg, ffprobe),
                    (
                        "ffmpeg version 8.0.3 Copyright test",
                        "ffprobe version 8.0.3 Copyright test",
                    ),
                )

    def test_media_runtime_rejects_network_protocols(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ffmpeg = self._executable(Path(directory) / "ffmpeg")
            ffprobe = self._executable(Path(directory) / "ffprobe")
            completed = [
                mock.Mock(returncode=0, stdout=b"ffmpeg version 8.0.3 test\n"),
                mock.Mock(returncode=0, stdout=b"ffprobe version 8.0.3 test\n"),
                mock.Mock(returncode=0, stdout=b" A....D libmp3lame MP3\n"),
                mock.Mock(
                    returncode=0,
                    stdout=(
                        b" TS afftdn A->A\n"
                        b" .. aresample A->A\n"
                        b" T. silenceremove A->A\n"
                    ),
                ),
                mock.Mock(returncode=0, stdout=b"Input:\n  file\n  https\n"),
            ]
            with mock.patch("subprocess.run", side_effect=completed):
                with self.assertRaisesRegex(ServiceDoctorError, "protocol set"):
                    validate_media_runtime(ffmpeg, ffprobe)

    @staticmethod
    def _executable(path: Path) -> Path:
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o755)
        return path


if __name__ == "__main__":
    unittest.main()
