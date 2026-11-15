import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_RECIPE_IDS } from "../protocol/v1/protocol.js";
import { qualifyMacUserRelease } from "../src/platform/macos/user-installer.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "darwin")(
  "macOS qualification media retention",
  () => {
    it.each([false, true])(
      "detects an exited qualification promptly (observed running=%s)",
      async (ran) => {
        const f = await timingFixture();
        let elapsed = 0;
        let loaded = false;
        let probes = 0;
        const launchAgent = {
          status: vi.fn(async () => ({
            loaded,
            running: loaded && ran && probes++ === 0,
            detail: "not running",
          })),
          bootstrap: vi.fn(async () => {
            loaded = true;
            await writeFile(f.outputPath, "partial", { mode: 0o600 });
          }),
          bootout: vi.fn(async () => {
            loaded = false;
          }),
        };
        await expect(
          qualifyMacUserRelease(
            f.layout,
            f.releaseRoot,
            f.fixturePath,
            f.fixtureDigest,
            launchAgent,
            false,
            {
              now: () => elapsed,
              wait: async (milliseconds) => {
                elapsed += milliseconds;
              },
            },
          ),
        ).rejects.toThrow("service stopped before publishing its report");
        expect(elapsed).toBeLessThanOrEqual(15_000);
        if (!ran) expect(elapsed).toBe(15_000);
        expect(loaded).toBe(false);
        expect(await readFile(f.outputPath, "utf8")).toBe("partial");
      },
    );

    it("permits slow launch and lets a report published during an exit observation win", async () => {
      const f = await timingFixture();
      let elapsed = 0;
      let loaded = false;
      const reportPath = join(f.layout.stateRoot, "qualification.json");
      const launchAgent = {
        status: vi.fn(async () => {
          if (loaded && elapsed >= 15_000) {
            await writeFile(
              reportPath,
              JSON.stringify(evidence(f.outputPath, f.fixtureDigest)),
              { mode: 0o600 },
            );
            return { loaded, running: false, detail: "not running" };
          }
          return { loaded, running: false };
        }),
        bootstrap: vi.fn(async () => {
          loaded = true;
          await writeFile(f.outputPath, "qualified output", { mode: 0o600 });
        }),
        bootout: vi.fn(async () => {
          loaded = false;
        }),
      };
      await expect(
        qualifyMacUserRelease(
          f.layout,
          f.releaseRoot,
          f.fixturePath,
          f.fixtureDigest,
          launchAgent,
          true,
          {
            now: () => elapsed,
            wait: async (milliseconds) => {
              elapsed += milliseconds;
            },
          },
        ),
      ).resolves.toBe(reportPath);
      expect(elapsed).toBe(15_000);
      expect(loaded).toBe(false);
      expect(await readFile(f.outputPath, "utf8")).toBe("qualified output");
    });

    it("preserves the result when qualification service teardown cannot be confirmed", async () => {
      const f = await timingFixture();
      let loaded = false;
      const launchAgent = {
        status: vi.fn(async () => ({ loaded, running: loaded })),
        bootstrap: vi.fn(async () => {
          loaded = true;
          await writeFile(f.outputPath, "qualified output", { mode: 0o600 });
          await writeFile(
            join(f.layout.stateRoot, "qualification.json"),
            JSON.stringify(evidence(f.outputPath, f.fixtureDigest)),
            { mode: 0o600 },
          );
        }),
        bootout: vi.fn(async () => {
          throw new Error("fixture teardown unavailable");
        }),
      };
      await expect(
        qualifyMacUserRelease(
          f.layout,
          f.releaseRoot,
          f.fixturePath,
          f.fixtureDigest,
          launchAgent,
          false,
        ),
      ).rejects.toThrow("fixture teardown unavailable");
      expect(loaded).toBe(true);
      expect(await readFile(f.outputPath, "utf8")).toBe("qualified output");
    });
    it.each([true, false])(
      "retains only enrollment candidates after stopping qualification (enrollment=%s)",
      async (retain) => {
        const root = await mkdtemp(
          join(tmpdir(), "mw-mac-qualification-cleanup-"),
        );
        roots.push(root);
        const layout = createMacUserLayout(root);
        await createMacUserDirectories(layout);
        const releaseRoot = join(layout.releasesRoot, "0.1.3");
        for (const path of [
          "app/dist/src/cli/main.js",
          "runtime/node/bin/node",
          "runtime/python/bin/python3",
          "runtime/bin/ffmpeg",
          "runtime/bin/ffprobe",
          "runtime/media-source-manifest.json",
          "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
          "runtime/licenses/lame/COPYING",
        ]) {
          await mkdir(dirname(join(releaseRoot, path)), {
            recursive: true,
            mode: 0o700,
          });
          await writeFile(join(releaseRoot, path), "fixture", { mode: 0o755 });
        }
        await mkdir(join(releaseRoot, "app", "engine"), { mode: 0o700 });
        await writeMacReleaseManifest(releaseRoot, "0.1.3");
        const fixturePath = join(root, "fixture.wav");
        await writeFile(fixturePath, "fixture");
        const fixtureDigest = createHash("sha256")
          .update("fixture")
          .digest("hex");
        const workspace = join(
          layout.workRoot,
          `qualification-${randomUUID()}`,
        );
        const outputPath = join(workspace, "vocals.mp3");
        const reportPath = join(layout.stateRoot, "qualification.json");
        let loaded = false;
        const launchAgent = {
          status: vi.fn(async () => ({ loaded, running: loaded })),
          bootstrap: vi.fn(async () => {
            loaded = true;
            await mkdir(workspace);
            await writeFile(outputPath, "qualified output");
            await writeFile(
              reportPath,
              JSON.stringify(evidence(outputPath, fixtureDigest)),
            );
          }),
          bootout: vi.fn(async () => {
            // Never remove the candidate before the qualification service stops.
            await expect(readFile(outputPath, "utf8")).resolves.toBe(
              "qualified output",
            );
            loaded = false;
          }),
        };

        await expect(
          qualifyMacUserRelease(
            layout,
            releaseRoot,
            fixturePath,
            fixtureDigest,
            launchAgent,
            ...(retain ? [] : [false]),
          ),
        ).resolves.toBe(reportPath);
        expect(loaded).toBe(false);
        await expect(readFile(reportPath, "utf8")).resolves.toContain(
          '"status":"PASS"',
        );
        if (retain)
          await expect(readFile(outputPath, "utf8")).resolves.toBe(
            "qualified output",
          );
        else
          await expect(lstat(workspace)).rejects.toMatchObject({
            code: "ENOENT",
          });
      },
    );
  },
);

async function timingFixture() {
  const root = await mkdtemp(join(tmpdir(), "mw-mac-qualification-timing-"));
  roots.push(root);
  const layout = createMacUserLayout(root);
  await createMacUserDirectories(layout);
  const releaseRoot = join(layout.releasesRoot, "0.1.3");
  for (const path of [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
    "runtime/media-source-manifest.json",
    "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
    "runtime/licenses/lame/COPYING",
  ]) {
    await mkdir(dirname(join(releaseRoot, path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(releaseRoot, path), "fixture", { mode: 0o755 });
  }
  await mkdir(join(releaseRoot, "app", "engine"), { mode: 0o700 });
  await writeMacReleaseManifest(releaseRoot, "0.1.3");
  const fixturePath = join(root, "fixture.wav");
  await writeFile(fixturePath, "fixture", { mode: 0o600 });
  const fixtureDigest = createHash("sha256").update("fixture").digest("hex");
  const workspace = join(layout.workRoot, `qualification-${randomUUID()}`);
  await mkdir(workspace, { mode: 0o700 });
  return {
    layout,
    releaseRoot,
    fixturePath,
    fixtureDigest,
    outputPath: join(workspace, "vocals.mp3"),
  };
}

function evidence(outputPath: string, fixtureDigest: string) {
  return {
    schemaVersion: 1,
    status: "PASS",
    platform: "darwin-arm64",
    provider: "mps",
    gpuId: "gpu0",
    directmlDeviceId: 0,
    serviceIdentity: "tester",
    releaseManifestDigest: "a".repeat(64),
    modelDigest: "b".repeat(64),
    fixtureDigest,
    providerDispatch: {
      expectedProvider: "MPS",
      profileCount: 0,
      acceleratedNodeEvents: 2,
      cpuNodeEvents: 0,
      proven: true,
    },
    recipes: WORKER_RECIPE_IDS.map((recipeId) => ({
      recipeId,
      recipeDigest: "c".repeat(64),
      resultDigest: "d".repeat(64),
      resultBytes: 16,
      sourceDurationSeconds: 6,
      outputDurationSeconds: 6,
      endToEndSeconds: 1,
    })),
    uploadCandidate: {
      path: outputPath,
      resultDigest: "d".repeat(64),
      resultBytes: 16,
      contentType: "audio/mpeg",
    },
    totalSeconds: 2,
  };
}
