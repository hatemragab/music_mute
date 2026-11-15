import { expect, it } from "vitest";
import { buildPerformanceReport } from "../src/platform/macos/performance-report.js";
import type { OperationalEvent } from "../src/platform/macos/operational-logs.js";

const incarnation = "6f82355c-17bd-4253-af31-cd624f4a03fe";
const modelDigest = "a".repeat(64);
const recipeDigest = "b".repeat(64);
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 22, 12, 0, seconds)).toISOString();

it("reports measured stages, RTF, median, retries, and comparable cohorts", () => {
  const events: OperationalEvent[] = [];
  for (const [index, separationMs, bitrate] of [
    [1, 90_000, 320],
    [2, 80_000, 320],
    [3, 100_000, 320],
    [4, 60_000, 192],
  ] as const) {
    const id = `d211790${index}-803e-41be-b5e2-c4d3a0472b69`;
    const jobId = `507461bf507461bf507461b${index}`;
    events.push(
      entry(
        index * 2 - 1,
        "attempt-started",
        id,
        jobId,
        {
          attemptNumber: index === 4 ? 2 : 1,
          provider: "mps",
          gpuId: "gpu0",
          incarnation,
          recipeId: "kim-vocals-v2",
          recipeDigest,
          modelDigest,
          outputBitrateKbps: bitrate,
          groupSize: 1,
          modelLoadState: "preloaded",
        },
        index * 200,
      ),
    );
    events.push(
      entry(
        index * 2,
        "attempt-succeeded",
        id,
        jobId,
        {
          measuredInputDurationSeconds: 180,
          outputBytes: 1_000_000,
          stageTimings: [
            { stage: "download", durationMs: 500 },
            { stage: "preparation", durationMs: 3_000 },
            { stage: "separation", durationMs: separationMs },
            { stage: "encode", durationMs: 2_000 },
            { stage: "upload", durationMs: 700 },
            { stage: "completionAck", durationMs: 100 },
          ],
        },
        index * 200 + 120,
      ),
    );
  }
  events.push(
    entry(
      9,
      "attempt-started",
      "d2117905-803e-41be-b5e2-c4d3a0472b69",
      "507461bf507461bf507461b5",
      { attemptNumber: 2 },
    ),
  );
  events.push(
    entry(
      10,
      "attempt-failed",
      "d2117905-803e-41be-b5e2-c4d3a0472b69",
      "507461bf507461bf507461b5",
      { code: "DOWNLOAD_FAILED" },
    ),
  );
  const report = buildPerformanceReport(events, {
    last: 10,
    incompleteHistory: false,
    truncatedByQueryLimit: false,
  });
  expect(report.states).toMatchObject({ succeeded: 4, failed: 1, retried: 2 });
  expect(report.cohorts).toHaveLength(2);
  const main = report.cohorts.find(
    (cohort) => cohort.outputBitrateKbps === 320,
  )!;
  expect(main.sampleCount).toBe(3);
  expect(main.stageMs.separation).toEqual({
    count: 3,
    median: 90_000,
    min: 80_000,
    max: 100_000,
  });
  expect(main.separationRtf?.median).toBeCloseTo(0.5);
  expect(
    report.samples.find((sample) => sample.outputBitrateKbps === 320)
      ?.dominantMeasuredStage,
  ).toBe("separation");
  expect(report.samples[0]?.missingStages).not.toContain("preparation");
  expect(report.samples[0]?.missingStages).not.toContain("encode");
  expect(report.missingCoverage).toContain("backend queue");
});

it("expects the post-MP3 trim and encode stages only for trimmed jobs", () => {
  const id = "d2117901-803e-41be-b5e2-c4d3a0472b69";
  const jobId = "507461bf507461bf507461b1";
  const report = buildPerformanceReport(
    [
      entry(1, "attempt-started", id, jobId, {
        recipeId: "kim-vocals-v2-trim",
      }),
      entry(2, "attempt-succeeded", id, jobId, {
        stageTimings: [{ stage: "separation", durationMs: 10_000 }],
      }),
    ],
    { last: 1, incompleteHistory: false, truncatedByQueryLimit: false },
  );
  expect(report.samples[0]?.missingStages).toContain("trim");
  expect(report.samples[0]?.missingStages).toContain("encode");
});

it("marks missing timings and does not group incomplete observations", () => {
  const id = "d2117901-803e-41be-b5e2-c4d3a0472b69";
  const jobId = "507461bf507461bf507461b1";
  const report = buildPerformanceReport(
    [
      entry(1, "attempt-started", id, jobId, {}),
      entry(2, "attempt-succeeded", id, jobId, {
        stageTimings: [{ stage: "separation", durationMs: "unknown" }],
      }),
    ],
    { last: 1, incompleteHistory: true, truncatedByQueryLimit: false },
  );
  expect(report.ungroupedSuccesses).toBe(1);
  expect(report.samples[0]).toMatchObject({
    separationRtf: null,
    missingStages: expect.arrayContaining(["separation"]),
  });
  expect(report.incompleteHistory).toBe(true);
});

it("reports the encoded bitrate when it is below the recipe maximum", () => {
  const id = "d2117901-803e-41be-b5e2-c4d3a0472b69";
  const jobId = "507461bf507461bf507461b1";
  const report = buildPerformanceReport(
    [
      entry(1, "attempt-started", id, jobId, {
        outputBitrateKbps: 160,
        recipeId: "kim-vocals-v2",
        provider: "mps",
        gpuId: "gpu0",
        incarnation,
        modelDigest,
        recipeDigest,
        groupSize: 1,
        modelLoadState: "preloaded",
      }),
      entry(2, "attempt-succeeded", id, jobId, {
        outputBitrateKbps: 128,
        measuredInputDurationSeconds: 180,
        outputBytes: 1_000_000,
        stageTimings: [{ stage: "separation", durationMs: 90_000 }],
      }),
    ],
    { last: 1, incompleteHistory: false, truncatedByQueryLimit: false },
  );
  expect(report.samples[0]?.outputBitrateKbps).toBe(128);
  expect(report.cohorts[0]?.outputBitrateKbps).toBe(128);
});

function entry(
  sequence: number,
  kind: string,
  attemptId: string,
  jobId: string,
  fields: Record<string, unknown>,
  seconds = sequence,
): OperationalEvent {
  return {
    recordedAt: at(seconds),
    level: kind === "attempt-failed" ? "error" : "info",
    event: {
      schemaVersion: 2,
      sequence,
      kind,
      component: "worker-runtime",
      attemptId,
      jobId,
      ...fields,
    },
  };
}
