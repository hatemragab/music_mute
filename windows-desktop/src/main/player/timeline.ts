export type ComparisonRange = readonly [number, number];
export function resolvePlaybackTimeline(
  input: {
    originalDuration: number;
    sourceDuration: number;
    voiceDuration?: number | null;
    trimmed: boolean;
    comparisonRanges?: ComparisonRange[];
  },
  variant: "voice" | "original",
): {
  timeline: PlaybackTimeline;
  comparisonAvailable: boolean;
  coordinate: "original" | "voice-output";
} {
  const original = new PlaybackTimeline(input.originalDuration, false);
  if (
    !Number.isFinite(input.sourceDuration) ||
    input.sourceDuration <= 0 ||
    input.sourceDuration > 7200
  )
    throw new Error("MEDIA_UNAVAILABLE");
  if (!input.trimmed) {
    if (
      Math.abs(input.sourceDuration - original.originalDuration) >
      Math.max(0.25, original.originalDuration * 0.0001)
    )
      throw new Error("MEDIA_UNAVAILABLE");
    return {
      timeline: original,
      comparisonAvailable: true,
      coordinate: "original",
    };
  }
  let mapped: PlaybackTimeline | undefined;
  try {
    const timeline = new PlaybackTimeline(
        input.originalDuration,
        true,
        input.comparisonRanges,
      ),
      voiceDuration =
        variant === "voice" ? input.sourceDuration : input.voiceDuration;
    if (
      voiceDuration !== null &&
      voiceDuration !== undefined &&
      Math.abs(timeline.outputDuration - voiceDuration) <=
        Math.max(0.25, voiceDuration * 0.0001)
    )
      mapped = timeline;
  } catch {
    /* A comparison map is not authority to reject independently verified audio. */
  }
  if (variant === "original") {
    if (
      Math.abs(input.sourceDuration - input.originalDuration) >
      Math.max(0.25, input.originalDuration * 0.0001)
    )
      throw new Error("MEDIA_UNAVAILABLE");
    return {
      timeline: mapped ?? original,
      comparisonAvailable: !!mapped,
      coordinate: "original",
    };
  }
  return mapped
    ? { timeline: mapped, comparisonAvailable: true, coordinate: "original" }
    : {
        timeline: new PlaybackTimeline(input.sourceDuration, false),
        comparisonAvailable: false,
        coordinate: "voice-output",
      };
}
/** Original-time coordinates remain stable for bookmarks, comparison and listening skips. */
export class PlaybackTimeline {
  readonly outputDuration: number;
  private readonly ranges: ComparisonRange[];
  constructor(
    readonly originalDuration: number,
    trimmed: boolean,
    ranges?: ComparisonRange[],
  ) {
    if (
      !Number.isFinite(originalDuration) ||
      originalDuration <= 0 ||
      originalDuration > 7200
    )
      throw new Error("MEDIA_UNAVAILABLE");
    if (!trimmed) {
      this.ranges = [[0, originalDuration * 44100]];
      this.outputDuration = originalDuration;
      return;
    }
    if (!ranges?.length || ranges.length > 100_000)
      throw new Error("COMPARISON_TIMELINE_UNAVAILABLE");
    let previous = 0,
      total = 0;
    this.ranges = ranges.map((range) => {
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !Number.isSafeInteger(range[0]) ||
        !Number.isSafeInteger(range[1]) ||
        range[0] < previous ||
        range[1] <= range[0] ||
        range[1] > Math.ceil(originalDuration * 44100) ||
        range[1] > 52_920_000
      )
        throw new Error("COMPARISON_TIMELINE_UNAVAILABLE");
      previous = range[1];
      total += range[1] - range[0];
      return [...range] as [number, number];
    });
    this.outputDuration = total / 44100;
  }
  toOriginal(seconds: number): number {
    const sample = this.clamp(seconds, this.outputDuration) * 44100;
    let output = 0,
      last = 0;
    for (const [start, end] of this.ranges) {
      const length = end - start;
      if (sample < output + length)
        return (start + Math.max(0, sample - output)) / 44100;
      output += length;
      last = end;
    }
    return last / 44100;
  }
  toOutput(seconds: number): number {
    const sample = this.clamp(seconds, this.originalDuration) * 44100;
    let output = 0;
    for (const [start, end] of this.ranges) {
      if (sample < end)
        return (
          (output + Math.min(end - start, Math.max(0, sample - start))) / 44100
        );
      output += end - start;
    }
    return output / 44100;
  }
  private clamp(value: number, max: number): number {
    if (!Number.isFinite(value)) throw new Error("INVALID_REQUEST");
    return Math.max(0, Math.min(max, value));
  }
}
