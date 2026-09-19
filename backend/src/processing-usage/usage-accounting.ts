export interface UtcMonthPeriod {
  key: string;
  start: Date;
  end: Date;
  purgeAt: Date;
}

export interface UtcDayPeriod {
  key: string;
  start: Date;
  end: Date;
  purgeAt: Date;
}

export function utcDayPeriod(now: Date): UtcDayPeriod {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid usage date');
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const purgeAt = new Date(end.getTime() + 35 * 24 * 60 * 60 * 1000);
  return {
    key: start.toISOString().slice(0, 10),
    start,
    end,
    purgeAt,
  };
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

export function usageDayId(accountId: { toHexString(): string }, key: string) {
  return `${accountId.toHexString()}:${key}`;
}

export function uploadGrantReceiptId(
  accountId: { toHexString(): string },
  requestId: string,
) {
  return `${accountId.toHexString()}:upload:${requestId}`;
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
