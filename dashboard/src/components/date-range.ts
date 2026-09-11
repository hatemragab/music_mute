export interface DateRange {
  from: string;
  to: string;
}

const MAX_RANGE_MS = 90 * 86_400_000;

export const validateDateRange = (range: DateRange): string | null => {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to))
    return "Choose a valid date.";
  if (to <= from) return "The To date must be after the From date.";
  if (to - from > MAX_RANGE_MS) return "The range cannot exceed 90 days.";
  return null;
};

export const parseDateRange = (
  from: string | null,
  to: string | null,
  fallback: DateRange,
): DateRange => {
  if (!from || !to) return fallback;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()))
    return fallback;
  const range = { from: fromDate.toISOString(), to: toDate.toISOString() };
  return validateDateRange(range) ? fallback : range;
};

const startOfUtcDay = (date: Date) =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );

export const createRange = (days: number): DateRange => {
  const to = new Date();
  const from = startOfUtcDay(new Date(to.getTime() - (days - 1) * 86_400_000));
  return { from: from.toISOString(), to: to.toISOString() };
};
