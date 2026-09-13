import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path


class PackageTests(unittest.TestCase):
    def test_archive_contains_runtime_and_exact_separator_but_no_private_state(self):
        script = Path(__file__).resolve().parents[1] / "package.py"
        spec = importlib.util.spec_from_file_location("worker_packaging", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            archive = module.build(Path(directory) / "worker.zip")
            with zipfile.ZipFile(archive) as bundle:
                names = bundle.namelist()
                self.assertIn("MusicMuteWindowsWorker/Start-Worker.ps1", names)
                self.assertIn("MusicMuteWindowsWorker/Benchmark-Worker.ps1", names)
                for runtime in (
                    "engine",
                    "power",
                    "progress",
                    "benchmark",
                    "execution",
                    "media_limits",
                ):
                    self.assertIn(
                        f"MusicMuteWindowsWorker/musicmute_worker/{runtime}.py", names
                    )
                for test in (
                    "warm_worker",
                    "engine",
                    "separator",
                    "reliability",
                    "benchmark",
                    "execution",
                    "execution_worker",
                    "media_limits",
                    "progress_v2",
                ):
                    self.assertIn(f"MusicMuteWindowsWorker/tests/test_{test}.py", names)
                self.assertIn(
                    "MusicMuteWindowsWorker/musicmute_worker/worker.py", names
                )
                self.assertIn("MusicMuteWindowsWorker/tests/test_processes.py", names)
                self.assertFalse(
                    any(
                        "state/" in name
                        or "__pycache__" in name
                        or name.endswith(
                            ("worker.config.json", "worker-secret.dpapi", "python.path")
                        )
                        for name in names
                    )
                )
                self.assertEqual(
                    bundle.read("MusicMuteWindowsWorker/separate.py"),
                    (script.parents[1] / "backend" / "separate.py").read_bytes(),
                )


if __name__ == "__main__":
    unittest.main()
