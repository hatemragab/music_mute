import { execFile } from "node:child_process";
import { cp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Install the locked, production-only Node closure inside the release tree. */
export async function installProductionDependencies(
  workerRoot: string,
  appRoot: string,
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(workerRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  if (Object.keys(manifest.dependencies ?? {}).length === 0) return;
  await cp(join(workerRoot, "pnpm-lock.yaml"), join(appRoot, "pnpm-lock.yaml"));
  try {
    await execFileAsync(
      "pnpm",
      [
        "install",
        "--prod",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.node-linker=hoisted",
      ],
      { cwd: appRoot, timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    // The Windows release manifest rejects links; hoisted installs only create
    // unused executable links under .bin, so omit those from both platforms.
    await rm(join(appRoot, "node_modules", ".bin"), {
      recursive: true,
      force: true,
    });
  } catch {
    throw new Error("Locked offline production dependencies are unavailable");
  }
}

/** A release with the Node reporter must also contain its Python reporter. */
export async function assertPythonSentrySdk(
  workerRoot: string,
  pythonBinary: string,
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(workerRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  if (!manifest.dependencies?.["@sentry/node"]) return;
  try {
    await execFileAsync(pythonBinary, ["-I", "-B", "-c", "import sentry_sdk"], {
      timeout: 10_000,
      maxBuffer: 1024,
    });
  } catch {
    throw new Error("Private Python runtime lacks the locked Sentry SDK");
  }
}

/** Inject Debug IDs before hashing the immutable release, when CI supplies a token. */
export async function uploadWorkerSourceMaps(
  workerRoot: string,
  appRoot: string,
  releaseVersion: string,
): Promise<void> {
  const token = process.env.SENTRY_AUTH_TOKEN?.trim();
  if (!token) return;
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(releaseVersion))
    throw new TypeError("Worker release version is invalid");
  const manifest = JSON.parse(
    await readFile(join(workerRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  if (!manifest.dependencies?.["@sentry/node"]) return;
  const dist = join(appRoot, "dist");
  const environment = { ...process.env, SENTRY_AUTH_TOKEN: token };
  const execute = async (arguments_: string[]) => {
    try {
      await execFileAsync("pnpm", ["exec", "sentry-cli", ...arguments_], {
        cwd: workerRoot,
        env: environment,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      throw new Error("Worker Sentry source map upload failed");
    }
  };
  await execute(["sourcemaps", "inject", dist]);
  await execute([
    "sourcemaps",
    "upload",
    "--org",
    "vchat-9f",
    "--project",
    "musicmute-worker-cli",
    "--release",
    `musicmute-worker-cli@${releaseVersion}`,
    "--validate",
    "--wait",
    dist,
  ]);
  for (const entry of await readdir(dist, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".map"))
      await unlink(join(entry.parentPath, entry.name));
  }
}
