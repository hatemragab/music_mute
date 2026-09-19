from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from musicmute_engine.service_doctor import ServiceDoctorError, executable_version


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


if __name__ == "__main__":
    unittest.main()
