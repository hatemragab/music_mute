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
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_RECIPE_IDS } from "../protocol/v1/protocol.js";
import { qualifyMacUserRelease } from "../src/platform/macos/user-installer.js";
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
