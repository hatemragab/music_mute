import type { ComparisonRange } from "../player/timeline.js";
export interface PersonalTimeline {
  version: 1;
  trimEnabled: boolean;
  sourceSamples: number;
  outputSamples: number;
  comparisonRanges: ComparisonRange[];
}
export const PERSONAL_RECIPE_DIGESTS = {
  "kim-vocals-v2":
    "23e22a5fe3b9a604f7ff5241f0fa7194bacf153fc37df83d83898949610a89d9",
  "kim-vocals-v2-trim":
    "97198c83fd88101420299121bf6ef0f81d350f6228762c2892d817283241fc04",
} as const;
const MAX_SAMPLES = 1200 * 44100;
const invalid = (): never => {
  throw new Error("PERSONAL_TIMELINE_INVALID");
};
export function parsePersonalTimeline(value: unknown): PersonalTimeline {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const row = value as PersonalTimeline;
  if (
    Object.keys(row).sort().join() !==
      "comparisonRanges,outputSamples,sourceSamples,trimEnabled,version" ||
    row.version !== 1 ||
    typeof row.trimEnabled !== "boolean" ||
    !Number.isSafeInteger(row.sourceSamples) ||
    row.sourceSamples < 1 ||
    row.sourceSamples > MAX_SAMPLES ||
    !Number.isSafeInteger(row.outputSamples) ||
    row.outputSamples < 1 ||
    row.outputSamples > row.sourceSamples ||
    !Array.isArray(row.comparisonRanges) ||
    row.comparisonRanges.length < 1 ||
    row.comparisonRanges.length > 256
  )
    return invalid();
  let output = 0,
    last = 0;
  for (const range of row.comparisonRanges) {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every(Number.isSafeInteger) ||
      range[0] < last ||
      range[0] < 0 ||
      range[1] <= range[0] ||
      range[1] > row.sourceSamples
    )
      return invalid();
    output += range[1] - range[0];
    last = range[1];
  }
  if (
    output !== row.outputSamples ||
    (!row.trimEnabled &&
      (row.outputSamples !== row.sourceSamples ||
        row.comparisonRanges.length !== 1 ||
        row.comparisonRanges[0]![0] !== 0 ||
        row.comparisonRanges[0]![1] !== row.sourceSamples))
  )
    return invalid();
  return structuredClone(row);
}
export function personalTimelineFromEngine(
  raw: Record<string, unknown>,
): PersonalTimeline {
  const recipe = raw.recipeId;
  if (recipe !== "kim-vocals-v2" && recipe !== "kim-vocals-v2-trim")
    return invalid();
  if (
    raw.recipeRevision !== 6 ||
    raw.recipeDigest !== PERSONAL_RECIPE_DIGESTS[recipe] ||
    raw.trimEnabled !== (recipe === "kim-vocals-v2-trim")
  )
    return invalid();
  const map = raw.editMap as {
    version: number;
    rangeCount: number;
    chunks: Record<string, unknown>[][];
  };
  if (
    !map ||
    Object.keys(map).sort().join() !== "chunks,rangeCount,version" ||
    map.version !== 1 ||
    !Number.isSafeInteger(map.rangeCount) ||
    map.rangeCount < 1 ||
    map.rangeCount > 256 ||
    !Array.isArray(map.chunks) ||
    map.chunks.length < 1 ||
    map.chunks.length > 4 ||
    map.chunks.some(
      (chunk) => !Array.isArray(chunk) || chunk.length < 1 || chunk.length > 64,
    )
  )
    return invalid();
  const ranges = map.chunks.flat();
  if (ranges.length !== map.rangeCount) return invalid();
  let cursor = 0;
  const comparisonRanges: ComparisonRange[] = [];
  for (const row of ranges) {
    if (
      !row ||
      Object.keys(row).sort().join() !==
        "outputEnd,outputStart,sourceEnd,sourceStart" ||
      ![row.sourceStart, row.sourceEnd, row.outputStart, row.outputEnd].every(
        Number.isSafeInteger,
      ) ||
      row.outputStart !== cursor ||
      Number(row.outputEnd) <= cursor ||
      Number(row.sourceEnd) - Number(row.sourceStart) !==
        Number(row.outputEnd) - cursor
    )
      return invalid();
    cursor = Number(row.outputEnd);
    comparisonRanges.push([Number(row.sourceStart), Number(row.sourceEnd)]);
  }
  const timeline = parsePersonalTimeline({
    version: 1,
    trimEnabled: raw.trimEnabled,
    sourceSamples: raw.sourceSamples,
    outputSamples: raw.outputSamples,
    comparisonRanges,
  });
  if (
    cursor !== timeline.outputSamples ||
    raw.removedSamples !== timeline.sourceSamples - timeline.outputSamples ||
    typeof raw.sourceDurationSeconds !== "number" ||
    !Number.isFinite(raw.sourceDurationSeconds) ||
    Math.abs(raw.sourceDurationSeconds - timeline.sourceSamples / 44100) >
      0.25 ||
    typeof raw.measuredOutputDurationSeconds !== "number" ||
    !Number.isFinite(raw.measuredOutputDurationSeconds) ||
    Math.abs(
      raw.measuredOutputDurationSeconds - timeline.outputSamples / 44100,
    ) > 0.25
  )
    return invalid();
  return timeline;
}
