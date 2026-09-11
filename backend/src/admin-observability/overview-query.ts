import { adminError } from '../admin/admin-errors.js';

const DAY = 86400000;
function parseDate(value: unknown): Date {
  if (typeof value !== 'string') throw adminError('INVALID_DATE_RANGE');
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) throw adminError('INVALID_DATE_RANGE');
  const hours = Number(match[4] ?? 0),
    minutes = Number(match[5] ?? 0);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0))
    throw adminError('INVALID_DATE_RANGE');
  const offset = (hours * 60 + minutes) * (match[3] === '-' ? -1 : 1);
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime() + offset * 60000).toISOString().slice(0, 19) !==
      match[1]
  )
    throw adminError('INVALID_DATE_RANGE');
  return date;
}
export function parseOverviewRange(raw: Record<string, unknown>) {
  if (
    Object.keys(raw).some((key) => !['from', 'to', 'bucket'].includes(key)) ||
    (raw.bucket !== undefined && raw.bucket !== 'day')
  )
    throw adminError('INVALID_REQUEST');
  const from = parseDate(raw.from),
    to = parseDate(raw.to);
  if (from >= to || to.getTime() - from.getTime() > 90 * DAY)
    throw adminError('INVALID_DATE_RANGE');
  return { from, to };
}
export function utcDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  for (
    let at = Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
    );
    at < to.getTime();
    at += DAY
  )
    days.push(new Date(at).toISOString());
  return days;
}
