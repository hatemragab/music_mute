import { describe, expect, it } from "vitest";
import { parseChildProcessResult } from "../src/runtime/contracts.js";
const result = {
  attemptId: "792a801d-f6f0-4ab6-baa9-5d3cf84f7940",
  outputPath: "/tmp/output.mp3",
  bytes: 100,
  sha256: `${"A".repeat(43)}=`,
  contentType: "audio/mpeg",
  measuredInputDurationSeconds: 10,
  measuredOutputDurationSeconds: 9,
  recipeId: "kim-vocals-v2",
  recipeRevision: 5,
  recipeDigest: "a".repeat(64),
  modelDigest: "b".repeat(64),
  trimEnabled: true,
  denoiseEnabled: false,
  outputFormat: "mp3",
  outputBitrateKbps: 160,
  stageTimings: { separation: 1.5 },
};
describe("separation timing diagnostics", () => {
  it("keeps nested timings separate from authoritative processing stages", () => {
    const parsed = parseChildProcessResult({
      ...result,
      separationTimings: { separationPrimaryDemix: 1.2, separationMatchMix: 0 },
    });
    expect(parsed.stageTimings).toEqual([
      { stage: "separation", durationMs: 1500 },
    ]);
    expect(parsed.separationTimings).toEqual([
      { stage: "separationPrimaryDemix", durationMs: 1200 },
      { stage: "separationMatchMix", durationMs: 0 },
    ]);
    expect(parseChildProcessResult(result).separationTimings).toEqual([]);
  });
  it.each([NaN, Infinity, -1, 7201])(
    "rejects invalid duration %s",
    (seconds) => {
      expect(() =>
        parseChildProcessResult({
          ...result,
          separationTimings: { separationCleanup: seconds },
        }),
      ).toThrow();
    },
  );
  it("rejects unrecognized detail fields", () => {
    expect(() =>
      parseChildProcessResult({
        ...result,
        separationTimings: { arbitrary: 1 },
      }),
    ).toThrow();
  });
});
