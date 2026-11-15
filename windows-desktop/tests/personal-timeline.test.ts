import { describe, expect, it } from "vitest";
import {
  parsePersonalTimeline,
  personalTimelineFromEngine,
  PERSONAL_RECIPE_DIGESTS,
} from "../src/main/personal/timeline.js";
const raw = (trim = true) => ({
  recipeId: trim ? "kim-vocals-v2-trim" : "kim-vocals-v2",
  recipeRevision: 6,
  recipeDigest:
    PERSONAL_RECIPE_DIGESTS[trim ? "kim-vocals-v2-trim" : "kim-vocals-v2"],
  trimEnabled: trim,
  sourceDurationSeconds: 60,
  measuredOutputDurationSeconds: trim ? 59.03 : 60.03,
  sourceSamples: 2646000,
  outputSamples: trim ? 2601900 : 2646000,
  removedSamples: trim ? 44100 : 0,
  editMap: {
    version: 1,
    rangeCount: trim ? 2 : 1,
    chunks: [
      trim
        ? [
            {
              sourceStart: 0,
              sourceEnd: 44100,
              outputStart: 0,
              outputEnd: 44100,
            },
            {
              sourceStart: 88200,
              sourceEnd: 2646000,
              outputStart: 44100,
              outputEnd: 2601900,
            },
          ]
        : [
            {
              sourceStart: 0,
              sourceEnd: 2646000,
              outputStart: 0,
              outputEnd: 2646000,
            },
          ],
    ],
  },
});
describe("personal exact sample timelines", () => {
  it("retains actual trimmed sample ranges and bounded encoder padding", () => {
    expect(personalTimelineFromEngine(raw())).toEqual({
      version: 1,
      trimEnabled: true,
      sourceSamples: 2646000,
      outputSamples: 2601900,
      comparisonRanges: [
        [0, 44100],
        [88200, 2646000],
      ],
    });
    expect(personalTimelineFromEngine(raw(false)).trimEnabled).toBe(false);
  });
  it("refuses silent trim ignoring, changed recipes and unsupported map revisions", () => {
    expect(() =>
      personalTimelineFromEngine({ ...raw(), trimEnabled: false }),
    ).toThrow("PERSONAL_TIMELINE_INVALID");
    expect(() =>
      personalTimelineFromEngine({ ...raw(), recipeDigest: "0".repeat(64) }),
    ).toThrow("PERSONAL_TIMELINE_INVALID");
    expect(() =>
      personalTimelineFromEngine({
        ...raw(),
        editMap: { ...raw().editMap, version: 2 },
      }),
    ).toThrow("PERSONAL_TIMELINE_INVALID");
  });
  it("rejects discontinuous output coordinates, overlaps and non-conserved samples", () => {
    const bad = raw();
    bad.editMap.chunks[0]![1]!.outputStart = 0;
    expect(() => personalTimelineFromEngine(bad)).toThrow(
      "PERSONAL_TIMELINE_INVALID",
    );
    expect(() =>
      personalTimelineFromEngine({ ...raw(), removedSamples: 0 }),
    ).toThrow("PERSONAL_TIMELINE_INVALID");
    expect(() =>
      parsePersonalTimeline({
        version: 1,
        trimEnabled: true,
        sourceSamples: 10,
        outputSamples: 10,
        comparisonRanges: [
          [0, 6],
          [5, 9],
        ],
      }),
    ).toThrow("PERSONAL_TIMELINE_INVALID");
  });
  it("enforces inclusive20minute samples, bounded maps and exact untrimmed identity", () => {
    expect(
      parsePersonalTimeline({
        version: 1,
        trimEnabled: false,
        sourceSamples: 52920000,
        outputSamples: 52920000,
        comparisonRanges: [[0, 52920000]],
      }).sourceSamples,
    ).toBe(52920000);
    expect(() =>
      parsePersonalTimeline({
        version: 1,
        trimEnabled: true,
        sourceSamples: 52920001,
        outputSamples: 1,
        comparisonRanges: [[0, 1]],
      }),
    ).toThrow("PERSONAL_TIMELINE_INVALID");
    expect(() =>
      parsePersonalTimeline({
        version: 1,
        trimEnabled: false,
        sourceSamples: 10,
        outputSamples: 9,
        comparisonRanges: [[1, 10]],
      }),
    ).toThrow("PERSONAL_TIMELINE_INVALID");
    expect(() =>
      personalTimelineFromEngine({
        ...raw(),
        measuredOutputDurationSeconds: 61,
      }),
    ).toThrow("PERSONAL_TIMELINE_INVALID");
  });
});
