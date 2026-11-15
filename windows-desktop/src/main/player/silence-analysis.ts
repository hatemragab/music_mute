export interface SilenceRange {
  start: number;
  end: number;
}
export interface PcmFormat {
  sampleRate: number;
  channels: number;
  maxSeconds?: number;
}
export const SILENCE_ANALYSIS_VERSION = "rms-50db-1024frames-400ms-pad60ms-v1";
/** Same block RMS/minimum/padding as macOS; bounded streaming PCM, no artifact mutation. */
export async function analyzeFloatPcm(
  chunks: AsyncIterable<Uint8Array>,
  format: PcmFormat,
  signal: AbortSignal,
): Promise<{ duration: number; ranges: SilenceRange[] }> {
  const { sampleRate, channels } = format,
    maxSeconds = format.maxSeconds ?? 7200;
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    ![1, 2].includes(channels) ||
    !Number.isFinite(maxSeconds) ||
    maxSeconds <= 0 ||
    maxSeconds > 7200
  )
    throw new Error("SILENCE_UNAVAILABLE");
  const blockSamples = 1024 * channels,
    maxFrames = Math.floor(sampleRate * maxSeconds),
    ranges: SilenceRange[] = [];
  let carry = Buffer.alloc(0),
    samples = 0,
    totalFrames = 0,
    sum = 0,
    silentStart: number | null = null;
  const block = () => {
    const frames = samples / channels,
      position = totalFrames / sampleRate,
      next = (totalFrames + frames) / sampleRate;
    const rms = Math.sqrt(sum / samples);
    if (rms < 0.00316227766) {
      if (silentStart === null) silentStart = position;
    } else if (silentStart !== null) {
      if (position - silentStart >= 0.4)
        ranges.push({
          start: silentStart + 0.06,
          end: Math.max(silentStart + 0.06, position - 0.06),
        });
      silentStart = null;
    }
    totalFrames += frames;
    samples = 0;
    sum = 0;
    if (
      totalFrames > maxFrames ||
      next > maxSeconds + 1 / sampleRate ||
      ranges.length > 10000
    )
      throw new Error("SILENCE_UNAVAILABLE");
  };
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    if (chunk.byteLength > 1024 * 1024) throw new Error("SILENCE_UNAVAILABLE");
    const bytes = carry.length
      ? Buffer.concat([carry, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const complete = bytes.length - (bytes.length % 4);
    for (let offset = 0; offset < complete; offset += 4) {
      const value = bytes.readFloatLE(offset);
      if (!Number.isFinite(value) || Math.abs(value) > 16)
        throw new Error("SILENCE_UNAVAILABLE");
      sum += value * value;
      samples++;
      if (samples === blockSamples) block();
    }
    carry = Buffer.from(bytes.subarray(complete));
  }
  signal.throwIfAborted();
  if (carry.length || samples % channels)
    throw new Error("SILENCE_UNAVAILABLE");
  if (samples) block();
  if (totalFrames < 1) throw new Error("SILENCE_UNAVAILABLE");
  const duration = totalFrames / sampleRate;
  if (silentStart !== null && duration - silentStart >= 0.4)
    ranges.push({
      start: silentStart + 0.06,
      end: Math.max(silentStart + 0.06, duration - 0.06),
    });
  if (ranges.length > 10000) throw new Error("SILENCE_UNAVAILABLE");
  return { duration, ranges };
}
export function validateSilenceRanges(
  value: unknown,
  duration: number,
): SilenceRange[] {
  if (
    !Array.isArray(value) ||
    value.length > 10000 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 7200
  )
    throw new Error("SILENCE_UNAVAILABLE");
  let previous = 0;
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join() !== "end,start"
    )
      throw new Error("SILENCE_UNAVAILABLE");
    const range = item as SilenceRange;
    if (
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.start < previous ||
      range.end <= range.start ||
      range.end > duration + 0.0001
    )
      throw new Error("SILENCE_UNAVAILABLE");
    previous = range.end;
    return { start: range.start, end: range.end };
  });
}
