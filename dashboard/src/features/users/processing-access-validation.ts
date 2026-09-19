export function validateAccountPolicyOverride(
  minutes: number,
  expiresAt: string,
  now = new Date(),
) {
  const errors: string[] = [];
  const seconds = minutes * 60;
  if (!Number.isSafeInteger(seconds) || seconds < 1)
    errors.push(
      "Monthly processing must be a positive whole number of seconds.",
    );
  if (expiresAt) {
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires) || expires <= now.getTime())
      errors.push("Choose a future expiry, or leave it empty for no expiry.");
  }
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
