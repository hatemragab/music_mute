export function repeatedReport(times: number[]) {
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
