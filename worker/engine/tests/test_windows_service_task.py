from __future__ import annotations

import unittest
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from musicmute_engine.windows_service_task import main


class WindowsServiceTaskTests(unittest.TestCase):
    def test_rejects_modules_outside_the_service_task_allowlist(self) -> None:
        with patch("sys.argv", ["task", "untrusted.module", "--", "input"]), patch("musicmute_engine.windows_service_task.own_job") as job:
            self.assertEqual(main(), 2)
            job.assert_not_called()

    def test_owns_descendants_and_watches_wrapper_before_loading_the_task(self) -> None:
        calls: list[str] = []
        deadline = MagicMock()

        def execute(module, run_name, alter_sys):
            calls.append("execute")
            self.assertEqual(module, "musicmute_engine.benchmark_file")
            self.assertEqual(run_name, "__main__")
            self.assertTrue(alter_sys)
            import sys
            self.assertEqual(sys.argv, [module, "--provider", "directml"])
            raise SystemExit(0)

        with (
            patch("sys.argv", ["task", "musicmute_engine.benchmark_file", "--", "--provider", "directml"]),
            patch("musicmute_engine.windows_service_task.own_job", side_effect=lambda: calls.append("job") or 42),
            patch("musicmute_engine.windows_service_task.watch_parent", side_effect=lambda _pid: calls.append("parent")),
            patch("musicmute_engine.windows_service_task.threading.Timer", return_value=deadline),
            patch("musicmute_engine.windows_service_task.runpy.run_module", side_effect=execute),
        ):
            self.assertEqual(main(), 0)
        self.assertEqual(calls, ["job", "parent", "execute"])
        deadline.start.assert_called_once()
        deadline.cancel.assert_called_once()

    def test_task_functions_are_resolvable_by_multiprocessing_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            module = "musicmute_service_task_spawn_fixture"
            Path(directory, f"{module}.py").write_text(
                "import pickle,time\n"
                "from musicmute_engine.benchmark_coordinator import run_cohort\n"
                "def worker(argument, ready, measured):\n"
                "    ready()\n"
                "    start=time.perf_counter()\n"
                "    time.sleep(0.01)\n"
                "    measured(time.perf_counter()-start)\n"
                "if __name__ == '__main__':\n"
                "    pickle.dumps(worker)\n"
                "    result=run_cohort(worker,[None,None],timeout_seconds=20)\n"
                "    assert len(set(result['workerPids'])) == 2\n",
                encoding="utf-8",
            )
            with (
                patch.object(sys, "path", [directory, *sys.path]),
                patch.object(sys, "argv", ["task", module, "--", "input"]),
                patch("musicmute_engine.windows_service_task.TASKS", {module}),
                patch("musicmute_engine.windows_service_task.own_job", return_value=42),
                patch("musicmute_engine.windows_service_task.watch_parent"),
                patch("musicmute_engine.windows_service_task.threading.Timer"),
            ):
                self.assertEqual(main(), 0)

    def test_does_not_load_inference_when_ownership_fails(self) -> None:
        with (
            patch("sys.argv", ["task", "musicmute_engine.qualification", "--", "--provider", "directml"]),
            patch("musicmute_engine.windows_service_task.own_job", side_effect=OSError("denied")),
            patch("musicmute_engine.windows_service_task.runpy.run_module") as run,
        ):
            self.assertEqual(main(), 2)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
