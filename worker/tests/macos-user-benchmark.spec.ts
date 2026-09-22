import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeLocalLifecycle } from "../src/runtime/local-lifecycle.js";
import {
  benchmarkMacUserWorker,
  summarizeFileBenchmarkReport,
} from "../src/platform/macos/user-benchmark.js";
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

describe("macOS local benchmark admission", () => {
  it("refuses while the worker is active or loaded", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-benchmark-"));
    roots.push(root);
    await chmod(root, 0o700);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await initializeLocalLifecycle(layout.lifecyclePath);
    const qualify = vi.fn();

    await expect(
      benchmarkMacUserWorker({
        layout,
        uid: process.getuid!(),
        launchAgent: {
          status: async () => ({ loaded: true, running: true }),
          bootstrap: async () => undefined,
          bootout: async () => undefined,
        },
        qualify,
      }),
    ).rejects.toThrow("already-drained and stopped");
    expect(qualify).not.toHaveBeenCalled();
  });

  it.each(["kim-vocals-v2", "kim-vocals-v2-trim"] as const)(
    "summarizes exactly one %s pass",
    (recipeId) => {
      const result = summarizeFileBenchmarkReport(
        {
          status: "PASS",
          provider: "mps",
          providerDispatch: {
            proven: true,
            acceleratedNodeEvents: 76,
            cpuNodeEvents: 0,
          },
          preloadSeconds: 5,
          totalSeconds: 16,
          recipes: [recipeResult(recipeId, 11, 0)],
        },
        {
          inputPath: "/Users/test/song.mp3",
          inputBytes: 1234,
          recipeId,
          processWallSeconds: 17,
        },
      );

      expect(result).toMatchObject({
        status: "PASS",
        scope: "local-engine-only",
        networkUsed: false,
        modelPreloadSeconds: 5,
        firstPassSeconds: 11,
        coldSeconds: 16,
        warm: null,
      });
      expect(result.iterations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stageTimings: { modelLoad: 0, separation: 9, trim: 0.2 },
          }),
        ]),
      );
    },
  );

  it("summarizes a second pass as warm performance", () => {
    const result = summarizeFileBenchmarkReport(
      {
        status: "PASS",
        provider: "mps",
        providerDispatch: {
          proven: true,
          acceleratedNodeEvents: 76,
          cpuNodeEvents: 0,
        },
        preloadSeconds: 5,
        totalSeconds: 25,
        recipes: [
          recipeResult("kim-vocals-v2-trim", 11, 0),
          recipeResult("kim-vocals-v2-trim", 9, 0),
        ],
      },
      {
        inputPath: "/Users/test/song.mp3",
        inputBytes: 1234,
        recipeId: "kim-vocals-v2-trim",
        iterationCount: 2,
        processWallSeconds: 26,
      },
    );

    expect(result).toMatchObject({
      modelPreloadSeconds: 5,
      firstPassSeconds: 11,
      coldSeconds: 16,
      warm: {
        passes: 1,
        meanSeconds: 9,
        minSeconds: 9,
        maxSeconds: 9,
        speedupVsFirstPass: 11 / 9,
      },
    });
  });
});

function recipeResult(
  recipeId: "kim-vocals-v2" | "kim-vocals-v2-trim",
  endToEndSeconds: number,
  modelLoad: number,
) {
  return {
    recipeId,
    endToEndSeconds,
    sourceDurationSeconds: 162,
    outputDurationSeconds: 158,
    resultBytes: 3_800_000,
    stageTimings: { modelLoad, separation: 9, trim: 0.2 },
  };
}
