export function validateAllowance(
  minutes: number,
  expiresAt: string,
  now = new Date(),
) {
  const errors: string[] = [];
  const seconds = minutes * 60;
  if (!Number.isSafeInteger(seconds) || seconds < 3600 || seconds > 86400)
    errors.push("Allowance must be from 60 to 1,440 audio minutes.");
  const expires = Date.parse(expiresAt);
  if (
    !Number.isFinite(expires) ||
    expires <= now.getTime() ||
    expires - now.getTime() > 30 * 86400_000
  )
    errors.push("Choose a future expiry within 30 days.");
  return errors;
}

export function suspensionExpiry(
  value: string,
  now = new Date(),
): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date <= now ||
    date.getTime() - now.getTime() > 30 * 86400_000
  )
    throw new Error(
      "Choose a future suspension expiry within 30 days, or leave it empty.",
    );
  return date.toISOString();
}
