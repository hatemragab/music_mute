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
const completed = spawnSync(
  python,
  ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
  {
    cwd: resolve(workerRoot, "engine"),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "inherit",
  },
);
if (completed.error) throw completed.error;
process.exit(completed.status ?? 1);
