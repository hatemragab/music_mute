import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { verifyMacRelease } from "../platform/macos/release-manifest.js";

/** Two-slot evidence currently exists only for the packaged Apple Silicon runtime. */
export async function installedCapacityIdentity(options: {
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  modelCacheRoot: string;
  fixturePath: string;
  modelDigest: string;
}) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new TypeError("Capacity identity is unsupported on this host");
  if (!/^[a-f0-9]{64}$/u.test(options.modelDigest))
    throw new TypeError("Capacity model digest is invalid");
  const engine = await realpath(options.engineRoot);
  const releaseRoot = dirname(dirname(engine));
  if (engine !== join(releaseRoot, "app", "engine"))
    throw new TypeError("Capacity requires a packaged engine");
  for (const [configured, packaged] of [
    [
      options.pythonPath,
      join(releaseRoot, "runtime", "python", "bin", "python3"),
    ],
    [options.ffmpegPath, join(releaseRoot, "runtime", "bin", "ffmpeg")],
    [options.ffprobePath, join(releaseRoot, "runtime", "bin", "ffprobe")],
  ] as const) {
    if ((await realpath(configured)) !== (await realpath(packaged)))
      throw new TypeError("Capacity runtime executable identity changed");
  }
  // The manifest digest alone is insufficient: verify its actual file inventory.
  await verifyMacRelease(releaseRoot);
  const releaseManifestDigest = createHash("sha256")
    .update(await readFile(join(releaseRoot, "release-manifest.json")))
    .digest("hex");
  const modelDigest = await hashRegularFile(
    join(options.modelCacheRoot, options.modelDigest, "Kim_Vocal_2.onnx"),
  );
  if (modelDigest !== options.modelDigest)
    throw new TypeError("Capacity model content changed");
  const fixtureDigest = await hashRegularFile(options.fixturePath);
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
      }),
    )
    .digest("hex");
  return { releaseManifestDigest, modelDigest, fixtureDigest, hostDigest };
}

async function hashRegularFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new TypeError("Capacity artifact is not a regular file");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
