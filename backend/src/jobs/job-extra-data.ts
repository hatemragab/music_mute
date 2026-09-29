import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_PREPARED_AUDIO_BYTES,
} from './media-limits.js';
/** Trusted acquisition metadata only. Never persist provider URLs or raw payloads. */
const strings = {
  provider: 64,
  site: 64,
  format_id: 64,
  extension: 16,
  audio_codec: 64,
  container: 64,
  language: 32,
  title: 200,
  artist: 200,
  album: 200,
  channel: 200,
  description: 1000,
} as const;
const numbers = {
  bitrate_kbps: 10000,
  sample_rate_hz: 384000,
  audio_channels: 32,
  provider_file_bytes: MAX_PREPARED_AUDIO_BYTES,
  duration_seconds: MAX_AUDIO_DURATION_SECONDS,
  file_bytes: MAX_PREPARED_AUDIO_BYTES,
} as const;
export type JobExtraData = { schema_version: 1 } & Partial<
  Record<keyof typeof strings, string> & Record<keyof typeof numbers, number>
>;

export function normalizeExtraData(value: unknown): JobExtraData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.schema_version !== 1) return null;
  const result: JobExtraData = { schema_version: 1 };
  for (const [key, maximum] of Object.entries(strings)) {
    const field = input[key];
    if (typeof field !== 'string') continue;
    const clean = [...field.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()]
      .slice(0, maximum)
      .join('');
    // Metadata is text, not an alternate channel for credentials or signed URLs.
    if (!clean || /https?:\/\/|Bearer\s|Basic\s|X-Amz-|Signature=/i.test(clean))
      continue;
    result[key as keyof typeof strings] = clean;
  }
  for (const [key, maximum] of Object.entries(numbers)) {
    const field = input[key];
    if (
      typeof field === 'number' &&
      Number.isFinite(field) &&
      field > 0 &&
      field <= maximum
    )
      result[key as keyof typeof numbers] = field;
  }
  return Object.keys(result).length > 1 ? result : null;
}

export function decodeExtraData(encoded: string | null): JobExtraData | null {
  if (
    !encoded ||
    encoded.length > 4096 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    return null;
  try {
    return normalizeExtraData(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.from(encoded, 'base64'),
        ),
      ),
    );
  } catch {
    return null;
  }
}
