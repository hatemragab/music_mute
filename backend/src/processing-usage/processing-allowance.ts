import { adminError } from '../admin/admin-errors.js';
export function effectiveAllowance(
  user: {
    processingAllowanceAudioSeconds?: number | null;
    processingAllowanceExpiresAt?: Date | null;
  },
  now: Date,
  base = 3600,
): number {
  const amount = user.processingAllowanceAudioSeconds;
  return amount !== undefined &&
    amount !== null &&
    Number.isSafeInteger(amount) &&
    amount >= base &&
    amount <= 86400 &&
    user.processingAllowanceExpiresAt &&
    user.processingAllowanceExpiresAt > now
    ? amount
    : base;
}
export function assertAllowanceExpiry(value: string, now: Date): Date {
  const expiry = new Date(value);
  if (
    !Number.isFinite(expiry.getTime()) ||
    expiry <= now ||
    expiry.getTime() > now.getTime() + 30 * 86400_000
  )
    throw adminError('INVALID_REQUEST');
  return expiry;
}
