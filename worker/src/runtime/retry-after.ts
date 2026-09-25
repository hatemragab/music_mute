export const MAX_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

// Preserve a bounded server delay so callers can distinguish a short retry
// from a rate limit that must be surfaced to the worker runtime.
export function retryAfterMilliseconds(
  value: string | null,
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds)
      ? Math.min(MAX_RETRY_AFTER_MS, seconds * 1_000)
      : MAX_RETRY_AFTER_MS;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}
