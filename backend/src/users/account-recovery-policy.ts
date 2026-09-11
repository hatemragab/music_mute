export const ACCOUNT_RECOVERY_MONTHS = 3;

/** Adds calendar months in UTC and clamps month-end dates (for example, Jan 31 -> Apr 30). */
export function accountRecoveryDeadline(requestedAt: Date): Date {
  const deadline = new Date(requestedAt);
  const day = deadline.getUTCDate();
  deadline.setUTCDate(1);
  deadline.setUTCMonth(deadline.getUTCMonth() + ACCOUNT_RECOVERY_MONTHS);
  const lastDay = new Date(
    Date.UTC(deadline.getUTCFullYear(), deadline.getUTCMonth() + 1, 0),
  ).getUTCDate();
  deadline.setUTCDate(Math.min(day, lastDay));
  return deadline;
}
