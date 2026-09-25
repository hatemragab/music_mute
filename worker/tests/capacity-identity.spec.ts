import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { installedCapacityIdentity } from "../src/runtime/capacity-identity.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "binds evidence to verified installed bytes, model, fixture and host",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "capacity-identity-"));
    try {
      const release = join(root, "release");
      const engineRoot = join(release, "app", "engine");
      const modelCacheRoot = join(root, "models");
      const fixturePath = join(root, "qualification.wav");
      const model = Buffer.from("synthetic model");
      const modelDigest = createHash("sha256").update(model).digest("hex");
      for (const file of [
        "app/dist/src/cli/main.js",
        "runtime/node/bin/node",
        "runtime/python/bin/python3",
        "runtime/bin/ffmpeg",
        "runtime/bin/ffprobe",
      ]) {
        const path = join(release, file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      for (const file of [
        "runtime/media-source-manifest.json",
        "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
        "runtime/licenses/lame/COPYING",
        "app/engine/recipes.py",
      ]) {
        const path = join(release, file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "fixture", { mode: 0o644 });
      }
      await chmod(release, 0o755);
      await mkdir(join(modelCacheRoot, modelDigest), { recursive: true });
      const modelPath = join(modelCacheRoot, modelDigest, "Kim_Vocal_2.onnx");
      await writeFile(modelPath, model);
      await writeFile(fixturePath, "audio fixture");
      await writeMacReleaseManifest(release, "0.1.0");
      const options = {
        engineRoot,
        modelCacheRoot,
        modelDigest,
        fixturePath,
        pythonPath: join(release, "runtime/python/bin/python3"),
        ffmpegPath: join(release, "runtime/bin/ffmpeg"),
        ffprobePath: join(release, "runtime/bin/ffprobe"),
      };
      const identity = await installedCapacityIdentity(options);
      expect(identity.modelDigest).toBe(modelDigest);
      await expect(
        installedCapacityIdentity({
          ...options,
          pythonPath: options.ffmpegPath,
        }),
      ).rejects.toThrow("executable identity changed");
      expect(identity.hostDigest).toMatch(/^[a-f0-9]{64}$/u);
      await writeFile(fixturePath, "different fixture");
      expect((await installedCapacityIdentity(options)).fixtureDigest).not.toBe(
        identity.fixtureDigest,
      );
      await writeFile(modelPath, "corrupt model");
      await expect(installedCapacityIdentity(options)).rejects.toThrow(
        "model content changed",
      );
      await writeFile(modelPath, model);
      await writeFile(join(engineRoot, "recipes.py"), "changed recipe");
      await expect(installedCapacityIdentity(options)).rejects.toThrow();
      await rm(join(release, "release-manifest.json"));
      await writeMacReleaseManifest(release, "0.1.1");
      expect(
        (await installedCapacityIdentity(options)).releaseManifestDigest,
      ).not.toBe(identity.releaseManifestDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
