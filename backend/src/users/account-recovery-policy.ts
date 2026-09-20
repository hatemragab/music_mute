export const ACCOUNT_RECOVERY_DAYS = 15;
export const ACCOUNT_RECOVERY_MS = ACCOUNT_RECOVERY_DAYS * 24 * 60 * 60 * 1_000;

/** Returns the exact recovery deadline: fifteen elapsed 24-hour periods. */
export function accountRecoveryDeadline(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + ACCOUNT_RECOVERY_MS);
}
