import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


class PackageTests(unittest.TestCase):
    def test_extracted_source_archive_can_render_its_bootstrap_templates(self):
        script = Path(__file__).resolve().parents[1] / "package.py"
        spec = importlib.util.spec_from_file_location("worker_packaging", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            archive = module.build(root / "worker.zip")
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(root / "extracted")
            extracted = root / "extracted/worker"
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    "tests",
                    "-p",
                    "test_bootstrap_recipe.py",
                    "-q",
                ],
                cwd=extracted,
                env={**os.environ, "PYTHONPATH": str(extracted)},
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_archive_contains_runtime_and_exact_separator_but_no_private_state(self):
        script = Path(__file__).resolve().parents[1] / "package.py"
        spec = importlib.util.spec_from_file_location("worker_packaging", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            archive = module.build(Path(directory) / "worker.zip")
            with zipfile.ZipFile(archive) as bundle:
                names = bundle.namelist()
                self.assertIn("worker/pyproject.toml", names)
                self.assertIn("worker/musicmute_worker/launcher.py", names)
                for runtime in (
                    "engine",
                    "power",
                    "progress",
                    "benchmark",
                    "execution",
                    "media_limits",
                ):
                    self.assertIn(f"worker/musicmute_worker/{runtime}.py", names)
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
                    self.assertIn(f"worker/tests/test_{test}.py", names)
                self.assertIn("worker/musicmute_worker/worker.py", names)
                self.assertIn("worker/tests/test_processes.py", names)
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
                    bundle.read("worker/musicmute_worker/separation.py"),
                    (script.parent / "musicmute_worker" / "separation.py").read_bytes(),
                )


if __name__ == "__main__":
    unittest.main()
