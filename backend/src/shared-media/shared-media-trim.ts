import { createHash } from 'node:crypto';
import type { WorkerRecipeSnapshot } from '../jobs/job.types.js';

export const DERIVED_TRIM_PROFILE = 'full-mp3-gap-trim-v1' as const;
export const TRIM_SAMPLE_RATE = 44_100;
export const TRIM_CHANNELS = 2;
const WINDOW_SAMPLES = 441;

export function isQuietPcmWindow(pcm: Buffer): boolean {
  let left = 0;
  let right = 0;
  for (let i = 0; i < pcm.length; i += 4) {
    left += (pcm.readInt16LE(i) / 32_768) ** 2;
    right += (pcm.readInt16LE(i + 2) / 32_768) ** 2;
  }
  return Math.sqrt(Math.max(left, right) / (pcm.length / 4)) < 0.01;
}

export function retainedRangesFromWindows(
  silent: boolean[],
  samples: number,
): [number, number][] {
  const cuts: [number, number][] = [];
  let quietStart: number | null = null;
  for (let window = 0; window <= silent.length; window++) {
    const start = Math.min(window * WINDOW_SAMPLES, samples);
    if (silent[window] && quietStart === null) quietStart = start;
    if (!silent[window] && quietStart !== null) {
      if (start - quietStart >= 26_460) {
        const left = quietStart + (quietStart > 0 ? 8_820 : 0);
        const right = start - (start < samples ? 8_820 : 0);
        if (right > left) cuts.push([left, right]);
      }
      quietStart = null;
    }
  }
  const keep: [number, number][] = [];
  let cursor = 0;
  for (const [left, right] of cuts) {
    if (left > cursor) keep.push([cursor, left]);
    cursor = right;
  }
  if (cursor < samples) keep.push([cursor, samples]);
  return keep.length ? keep : [[0, samples]];
}

/** Separate identity: this rendition incurs one extra lossy encode, no inference. */
export function derivedTrimRecipe(
  full: WorkerRecipeSnapshot,
): WorkerRecipeSnapshot {
  const { recipeDigest: _digest, ...base } = full;
  const material: Omit<WorkerRecipeSnapshot, 'recipeDigest'> = {
    ...base,
    recipeId: 'kim-vocals-v2-trim',
    recipeRevision: 7,
    trimEnabled: true,
    trimProfileId: 'trim-vocal-mp3-v1',
    stepIds: [
      'trim-vocal-mp3-v1',
      'encode-mp3-up-to-160k-v1',
      'validate-audio-v1',
    ],
  };
  // Snapshot fields contain scalars and a scalar array; the sorted root is canonical.
  const canonical = JSON.stringify(material, Object.keys(material).sort());
  return {
    ...material,
    recipeDigest: createHash('sha256').update(canonical).digest('hex'),
  };
}

/** Same 10ms max-channel RMS, -40dB, 600ms gaps and 200ms padding as the engine. */
export function retainedPcmRanges(pcm: Buffer): [number, number][] {
  if (!pcm.length || pcm.length % 4) throw new TypeError('Invalid stereo PCM');
  const samples = pcm.length / 4;
  const silent: boolean[] = [];
  for (let start = 0; start < samples; start += WINDOW_SAMPLES) {
    const end = Math.min(start + WINDOW_SAMPLES, samples);
    silent.push(isQuietPcmWindow(pcm.subarray(start * 4, end * 4)));
  }
  return retainedRangesFromWindows(silent, samples);
}

/** Retained boundaries get the engine's 5ms fades; original timeline ranges survive. */
export function trimPcm(pcm: Buffer) {
  const ranges = retainedPcmRanges(pcm);
  const total = pcm.length / 4;
  const output = Buffer.allocUnsafe(
    ranges.reduce((n, [start, end]) => n + (end - start) * 4, 0),
  );
  let cursor = 0;
  for (const [start, end] of ranges) {
    const bytes = (end - start) * 4;
    pcm.copy(output, cursor, start * 4, end * 4);
    const fade = Math.min(220, Math.floor((end - start) / 2));
    for (let offset = 0; offset < fade; offset++) {
      const gain = fade === 1 ? 0 : offset / (fade - 1);
      for (let channel = 0; channel < TRIM_CHANNELS; channel++) {
        if (start > 0) {
          const index = cursor + offset * 4 + channel * 2;
          output.writeInt16LE(
            Math.round(output.readInt16LE(index) * gain),
            index,
          );
        }
        if (end < total) {
          const index = cursor + (end - start - 1 - offset) * 4 + channel * 2;
          output.writeInt16LE(
            Math.round(output.readInt16LE(index) * gain),
            index,
          );
        }
      }
    }
    cursor += bytes;
  }
  return {
    pcm: output,
    comparisonRanges: ranges,
  };
}
