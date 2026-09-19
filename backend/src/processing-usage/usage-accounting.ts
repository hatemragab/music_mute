export interface UtcMonthPeriod {
  key: string;
  start: Date;
  end: Date;
  purgeAt: Date;
}

export function utcMonthPeriod(now: Date): UtcMonthPeriod {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid usage date');
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const purgeAt = new Date(Date.UTC(year, month + 13, 1));
  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    start,
    end,
    purgeAt,
  };
}

export function usagePeriodId(
  accountId: { toHexString(): string },
  key: string,
) {
  return `${accountId.toHexString()}:${key}`;
}

export interface ProcessingUsageCounters {
  processingUsedSeconds: number;
  processingReservedSeconds: number;
  processingReleasedSeconds: number;
}

export function summarizeMonthlyProcessing(
  counters: ProcessingUsageCounters,
  limit: number,
) {
  for (const value of [
    counters.processingUsedSeconds,
    counters.processingReservedSeconds,
    counters.processingReleasedSeconds,
    limit,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid monthly processing counters');
  return {
    usedSeconds: counters.processingUsedSeconds,
    reservedSeconds: counters.processingReservedSeconds,
    releasedSeconds: counters.processingReleasedSeconds,
    remainingSeconds: Math.max(
      0,
      limit -
        counters.processingUsedSeconds -
        counters.processingReservedSeconds,
    ),
  };
}
