import type { AccountPolicyOverride } from "@/api/contracts";

export function validateAccountPolicyOverride(
  values: AccountPolicyOverride["values"],
  effective: AccountPolicyOverride["values"],
  expiresAt: string,
  now = new Date(),
) {
  const errors: string[] = [];
  const entries = Object.entries(values);
  if (!entries.length) errors.push("Choose at least one replacement value.");
  for (const [key, amount] of entries) {
    if (!Number.isSafeInteger(amount) || amount < 1)
      errors.push(`${key} must be a positive whole number.`);
  }
  if ((values.signedUrlTtlSeconds ?? 1) > 600)
    errors.push("Signed URL validity cannot exceed 600 seconds.");
  const merged = { ...effective, ...values };
  if (
    merged.dailyUploadGrants !== undefined &&
    merged.monthlyUploadGrants !== undefined &&
    merged.monthlyUploadGrants < merged.dailyUploadGrants
  )
    errors.push("Monthly upload grants cannot be lower than daily grants.");
  if (expiresAt) {
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires) || expires <= now.getTime())
      errors.push("Choose a future expiry, or leave it empty for no expiry.");
  }
  return errors;
}

export function restrictionExpiry(
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
      "Choose a future restriction expiry within 30 days, or leave it empty.",
    );
  return date.toISOString();
}
