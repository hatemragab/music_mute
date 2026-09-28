export type RepeatMode = "off" | "all" | "one";

export const LOOP_SECONDS = 15;

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export function trackTitle(
  job: {
    id: string;
    displayName?: string | null;
    sourceTitle?: string | null;
  },
  untitled: string,
): string {
  for (const value of [job.displayName, job.sourceTitle]) {
    const name = value?.trim();
    if (name && !OBJECT_ID.test(name)) return name;
  }
  return untitled;
}

export function chooseNextIndex(
  count: number,
  index: number,
  repeat: RepeatMode,
  shuffle: boolean,
  random: () => number = Math.random,
): number {
  if (count <= 0) return -1;
  if (shuffle) {
    if (count === 1) return repeat === "off" ? -1 : 0;
    if (index < 0 || index >= count)
      return Math.min(count - 1, Math.floor(random() * count));
    const pick = Math.floor(random() * (count - 1));
    return pick >= index ? pick + 1 : pick;
  }
  if (index >= 0 && index + 1 < count) return index + 1;
  if (repeat === "all") return 0;
  return -1;
}

export function hasNextTrack(
  count: number,
  index: number,
  repeat: RepeatMode,
  shuffle: boolean,
): boolean {
  if (count <= 0) return false;
  if (shuffle) return count > 1 || repeat !== "off";
  if (index >= 0 && index + 1 < count) return true;
  return repeat === "all";
}

export interface LoopSpan {
  start: number;
  end: number;
}

/** A short passage starting at the playhead, pulled back when the track ends sooner. */
export function passageLoop(
  time: number,
  duration: number,
  length = LOOP_SECONDS,
): LoopSpan | null {
  if (!(duration > 0.3) || !(length > 0)) return null;
  const span = Math.min(length, duration);
  const start = Math.min(Math.max(0, time), Math.max(0, duration - span));
  return { start, end: start + span };
}
