import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workerRoot = resolve(import.meta.dirname, "..");
const localPython =
  process.platform === "win32"
    ? resolve(workerRoot, ".venv", "Scripts", "python.exe")
    : resolve(workerRoot, ".venv", "bin", "python");
const python =
  process.env.MUSICMUTE_PYTHON ??
  (existsSync(localPython)
    ? localPython
    : process.platform === "win32"
      ? "python"
      : "python3");
const preflight = spawnSync(
  python,
  ["-B", "-c", "import numpy, torch, soundfile, audio_separator"],
  {
    cwd: resolve(workerRoot, "engine"),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  },
);
if (preflight.error || preflight.status !== 0) {
  console.error(
    "Engine test dependencies are unavailable. Create worker/.venv with Python 3.13 and sync tools/worker-gpu-feasibility/requirements-mps-base.lock.txt (macOS), or select a qualified interpreter with MUSICMUTE_PYTHON. See worker/README.md. No tests were skipped to hide this failure.",
  );
  process.exit(1);
}
const completed = spawnSync(
  python,
  ["-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
  {
    cwd: resolve(workerRoot, "engine"),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "inherit",
  },
);
if (completed.error) throw completed.error;
process.exit(completed.status ?? 1);
