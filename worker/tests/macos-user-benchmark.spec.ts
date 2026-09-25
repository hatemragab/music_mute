import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeLocalLifecycle } from "../src/runtime/local-lifecycle.js";
import {
  benchmarkMacUserWorker,
  compareBenchmarkReports,
  parseStoredRepeatedBenchmarkReport,
  runFileBenchmarkProcess,
  runTwoWorkerCapacityBenchmark,
  summarizeFileBenchmarkReport,
  summarizeRepeatedBenchmarkReport,
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
  it("invalidates a previous PASS before a failed capacity rerun", async () => {
    const home = await mkdtemp(join(tmpdir(), "capacity-rerun-"));
    roots.push(home);
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await writeFile(
      layout.capacityValidationPath,
      JSON.stringify({ status: "PASS" }),
      { mode: 0o600 },
    );
    await expect(
      runTwoWorkerCapacityBenchmark({
        layout,
        machineId: "unused",
        releaseRoot: layout.currentLink,
        fixturePath: join(layout.stateRoot, "qualification.wav"),
        fixtureSha256: "a".repeat(64),
        baseline: {},
      }),
    ).rejects.toThrow();
    expect(
      JSON.parse(await readFile(layout.capacityValidationPath, "utf8")),
    ).toMatchObject({ status: "IN_PROGRESS" });
  });

  it("terminates an interrupted benchmark subprocess", async () => {
    const controller = new AbortController();
    const run = runFileBenchmarkProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: tmpdir(), env: process.env, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await expect(run).rejects.toThrow("interrupted");
  });

  it("keeps every warm sample and compares only compatible GPU reports", () => {
    const baseline = summarizeRepeatedBenchmarkReport(
      repeatedReport([120, 115, 100, 90, 110]),
      {
        processWallSeconds: 500,
        warmupRuns: 1,
        measuredRuns: 3,
      },
    );
    const candidateRaw = repeatedReport([115, 110, 80, 75, 85]);
    candidateRaw.engineDigest = "9".repeat(64);
    const candidate = summarizeRepeatedBenchmarkReport(candidateRaw, {
      processWallSeconds: 460,
      warmupRuns: 1,
      measuredRuns: 3,
    });
    expect(candidate.runs.map((run) => run.role)).toEqual([
      "cold",
      "warmup",
      "measured",
      "measured",
      "measured",
    ]);
    expect(baseline.measuredSummary).toMatchObject({
      count: 3,
      medianSeconds: 100,
      minSeconds: 90,
      maxSeconds: 110,
    });
    expect(compareBenchmarkReports(baseline, candidate)).toMatchObject({
      comparable: true,
      speedup: 1.25,
    });
    candidate.audioSettings.bitrateKbps = 192;
    expect(compareBenchmarkReports(baseline, candidate)).toMatchObject({
      comparable: false,
      speedup: null,
      reasons: ["audio settings differ"],
    });
  });

  it("accepts only evidenced grouped GPU runs and compares them with group 1", () => {
    const baseline = summarizeRepeatedBenchmarkReport(
      repeatedReport([120, 115, 100, 90, 110]),
      { processWallSeconds: 500, warmupRuns: 1, measuredRuns: 3 },
    );
    const raw = repeatedReport([115, 110, 93, 91, 92]);
    const grouped = {
      ...raw,
      audioSettings: { ...raw.audioSettings, groupSize: 2 },
      runs: raw.runs.map((run) => ({
        ...run,
        grouping: {
          selectedSize: 2,
          processedWindows: 30,
          modelCalls: 15,
          largestBatch: 2,
        },
      })),
    };
    const candidate = summarizeRepeatedBenchmarkReport(grouped, {
      processWallSeconds: 460,
      warmupRuns: 1,
      measuredRuns: 3,
      groupSize: 2,
    });
    expect(candidate.runs[0]!.grouping?.modelCalls).toBe(15);
    expect(compareBenchmarkReports(baseline, candidate)).toMatchObject({
      comparable: true,
      speedup: 100 / 92,
    });
    grouped.runs[0]!.grouping.modelCalls = 16;
    expect(() =>
      summarizeRepeatedBenchmarkReport(grouped, {
        processWallSeconds: 460,
        warmupRuns: 1,
        measuredRuns: 3,
        groupSize: 2,
      }),
    ).toThrow("window grouping evidence");
  });

  it("reopens a saved CLI baseline for a comparable candidate run", () => {
    const baseline = summarizeRepeatedBenchmarkReport(
      repeatedReport([120, 115, 100, 90, 110]),
      { processWallSeconds: 500, warmupRuns: 1, measuredRuns: 3 },
    );
    const saved = JSON.parse(JSON.stringify(baseline)) as unknown;
    const loaded = parseStoredRepeatedBenchmarkReport(saved);
    expect(loaded.measuredSummary).toEqual(baseline.measuredSummary);
    expect(loaded.runs).toEqual(baseline.runs);
    expect(compareBenchmarkReports(loaded, baseline)).toMatchObject({
      comparable: true,
      speedup: 1,
    });

    const tampered = JSON.parse(JSON.stringify(baseline)) as {
      measuredSummary: { medianSeconds: number };
    };
    tampered.measuredSummary.medianSeconds = 1;
    expect(
      parseStoredRepeatedBenchmarkReport(tampered).measuredSummary,
    ).toEqual(baseline.measuredSummary);
  });

  it("requires identities for every retained MP3 vocal", () => {
    const raw = repeatedReport([120, 115, 100, 90, 110]);
    raw.savedAudio = true;
    raw.savedAudioArtifacts = raw.runs.map((run) => ({
      iteration: run.iteration,
      role: run.role,
      format: "mp3",
      fileName: `${String(run.iteration).padStart(2, "0")}-${run.role}-vocals.mp3`,
      sha256: "0".repeat(64),
      bytes: 1024,
    }));
    const report = summarizeRepeatedBenchmarkReport(raw, {
      processWallSeconds: 500,
      warmupRuns: 1,
      measuredRuns: 3,
    });
    expect(report.savedAudioArtifacts).toHaveLength(5);
    expect(
      parseStoredRepeatedBenchmarkReport(JSON.parse(JSON.stringify(report))),
    ).toMatchObject({ savedAudioArtifacts: report.savedAudioArtifacts });
    raw.savedAudioArtifacts[0]!.fileName = "different.flac";
    expect(() =>
      summarizeRepeatedBenchmarkReport(raw, {
        processWallSeconds: 500,
        warmupRuns: 1,
        measuredRuns: 3,
      }),
    ).toThrow("saved audio identity");
  });

  it("continues to parse earlier reports containing MP3 and FLAC vocals", () => {
    const raw = repeatedReport([120, 115, 100, 90, 110]);
    raw.savedAudio = true;
    raw.savedAudioArtifacts = raw.runs.flatMap((run) =>
      (["mp3", "flac"] as const).map((format) => ({
        iteration: run.iteration,
        role: run.role,
        format,
        fileName: `${String(run.iteration).padStart(2, "0")}-${run.role}-vocals.${format}`,
        sha256: "0".repeat(64),
        bytes: 1024,
      })),
    );
    const report = summarizeRepeatedBenchmarkReport(raw, {
      processWallSeconds: 500,
      warmupRuns: 1,
      measuredRuns: 3,
    });
    expect(report.savedAudioArtifacts).toHaveLength(10);
  });

  it("rejects an unsupported or unproven repeated GPU report", () => {
    const raw = repeatedReport([120, 115, 100, 90, 110]);
    raw.providerDispatch = {
      proven: false,
      acceleratedNodeEvents: 0,
      cpuNodeEvents: 1,
    };
    expect(() =>
      summarizeRepeatedBenchmarkReport(raw, {
        processWallSeconds: 500,
        warmupRuns: 1,
        measuredRuns: 3,
      }),
    ).toThrow("GPU dispatch");
  });

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

function repeatedReport(times: number[]) {
  return {
    schemaVersion: 2,
    status: "PASS",
    scope: "local-engine-only",
    sourceMode: "candidate-engine",
    engineDigest: "a".repeat(64),
    releaseManifestDigest: "b".repeat(64),
    fixtureDigest: "c".repeat(64),
    modelDigest: "d".repeat(64),
    recipeId: "kim-vocals-v2",
    recipeDigest: "e".repeat(64),
    provider: "mps",
    fallbackDisabled: true,
    providerDispatch: {
      proven: true,
      acceleratedNodeEvents: 1,
      cpuNodeEvents: 0,
    },
    gpuModel: "Apple M4",
    osVersion: "26.0",
    runtime: {
      python: "3.13",
      torch: "2.14.0",
      onnxRuntime: "1.30.0",
      audioSeparator: "0.47.0",
      ffmpeg: "8.0.3",
      ffprobe: "8.0.3",
    },
    source: {
      sha256: "c".repeat(64),
      bytes: 4_000_000,
      decodedDurationSeconds: 180,
      decodedSamples: 7_938_000,
      sampleRate: 44_100,
      channels: 2,
    },
    audioSettings: {
      format: "mp3",
      bitrateKbps: 320,
      groupSize: 1,
      hopLength: 1024,
      segmentSize: 256,
      fftSize: 7680,
      overlap: 0.0294,
    },
    preloadSeconds: 5,
    warmupRuns: 1,
    measuredRuns: 3,
    savedAudio: false,
    savedAudioArtifacts: [] as Array<{
      iteration: number;
      role: string;
      format: string;
      fileName: string;
      sha256: string;
      bytes: number;
    }>,
    runs: times.map((seconds, index) => ({
      iteration: index + 1,
      role: index === 0 ? "cold" : index === 1 ? "warmup" : "measured",
      recipeId: "kim-vocals-v2",
      recipeDigest: "e".repeat(64),
      resultDigest: "f".repeat(64),
      resultBytes: 4_000_000,
      sourceDurationSeconds: 180,
      measuredInputDurationSeconds: 180,
      measuredInputSamples: 7_938_000,
      outputDurationSeconds: 180,
      endToEndSeconds: seconds,
      stageTimings: { preparation: 4, separation: seconds - 20, encode: 2 },
      gpuMemoryBefore: { tensorAllocatedBytes: 100, driverAllocatedBytes: 200 },
      gpuMemoryAfter: { tensorAllocatedBytes: 110, driverAllocatedBytes: 220 },
    })),
  };
}

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
