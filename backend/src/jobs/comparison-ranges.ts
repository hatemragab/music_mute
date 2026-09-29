import { MAX_AUDIO_DURATION_SECONDS } from './media-limits.js';
/** Retained source sample intervals at 44.1 kHz, in playback order. */
export function validComparisonRanges(value: unknown): value is number[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3001)
    return false;
  let end = 0;
  for (const range of value) {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every(Number.isSafeInteger) ||
      range[0] < end ||
      range[1] <= range[0] ||
      range[1] > MAX_AUDIO_DURATION_SECONDS * 44100
    )
      return false;
    end = range[1];
  }
  return true;
}
