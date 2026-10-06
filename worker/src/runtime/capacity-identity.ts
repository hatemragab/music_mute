import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  appBaseRelease,
  readAppBinding,
  verifyManagedMacRelease as verifyMacRelease,
} from "../platform/macos/app-installation-binding.js";
import { verifyWindowsRelease } from "../platform/windows/release-manifest.js";
import { parseDirectmlIdentity } from "../platform/shared/file-benchmark.js";
import { runtimePlatformAdapter } from "../platform/runtime-adapter.js";

/** Verify installed bytes before binding capacity to this host and GPU driver. */
export async function installedCapacityIdentity(options: {
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  modelCacheRoot: string;
  fixturePath: string;
  modelDigest: string;
}) {
  const adapter = runtimePlatformAdapter(process);
  const windows = adapter.platform === "win32";
  if (!/^[a-f0-9]{64}$/u.test(options.modelDigest))
    throw new TypeError("Capacity model digest is invalid");
  const engine = await realpath(options.engineRoot);
  const releaseRoot = dirname(dirname(engine));
  if (engine !== join(releaseRoot, "app", "engine"))
    throw new TypeError("Capacity requires a packaged engine");
  const binding = windows ? null : await readAppBinding(releaseRoot);
  const toolsRoot = binding
    ? join(appBaseRelease(binding), "runtime")
    : releaseRoot;
  for (const [configured, packaged] of [
    [
      options.pythonPath,
      windows
        ? join(releaseRoot, "runtime", "python", "python.exe")
        : join(toolsRoot, "runtime", "python", "bin", "python3"),
    ],
    [
      options.ffmpegPath,
      join(toolsRoot, "runtime", "bin", windows ? "ffmpeg.exe" : "ffmpeg"),
    ],
    [
      options.ffprobePath,
      join(toolsRoot, "runtime", "bin", windows ? "ffprobe.exe" : "ffprobe"),
    ],
  ] as const) {
    if ((await realpath(configured)) !== (await realpath(packaged)))
      throw new TypeError("Capacity runtime executable identity changed");
  }
  // The manifest digest alone is insufficient: verify its actual file inventory.
  await (windows
    ? verifyWindowsRelease(releaseRoot)
    : verifyMacRelease(releaseRoot));
  const releaseManifestDigest = createHash("sha256")
    .update(await readFile(join(releaseRoot, "release-manifest.json")))
    .digest("hex");
  const modelDigest = await hashRegularFile(
    join(options.modelCacheRoot, options.modelDigest, "Kim_Vocal_2.onnx"),
  );
  if (modelDigest !== options.modelDigest)
    throw new TypeError("Capacity model content changed");
  const fixtureDigest = await hashRegularFile(options.fixturePath);
  let gpuIdentity: Record<string, unknown> | null = null;
  if (windows) {
    const result = await promisify(execFile)(
      options.pythonPath,
      ["-I", "-B", join(engine, "musicmute_engine", "windows_gpu.py")],
      {
        cwd: engine,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 16 * 1024,
      },
    );
    gpuIdentity = stableCapacityGpuIdentity(JSON.parse(result.stdout));
  }
  // Apple Silicon's integrated GPU shares its SoC and memory with the CPU.
  // Bind both that hardware class and the OS kernel serving the MPS provider.
  const hostDigest = createHash("sha256")
    .update(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        processors: cpus().map(({ model }) => model),
        memoryBytes: totalmem(),
        gpuIdentity,
      }),
    )
    .digest("hex");
  return {
    releaseManifestDigest,
    modelDigest,
    fixtureDigest,
    hostDigest,
    provider: adapter.provider,
    gpuIdentity,
  };
}

/** A DXGI LUID identifies an adapter only until reboot, not its driver/hardware. */
export function stableCapacityGpuIdentity(
  value: unknown,
): Record<string, unknown> {
  const { luid: _luid, ...identity } = parseDirectmlIdentity(value);
  return identity;
}

async function hashRegularFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new TypeError("Capacity artifact is not a regular file");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
