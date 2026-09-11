import { adminError } from '../admin/admin-errors.js';
import { parseAdminJobQuery } from '../admin-jobs/admin-jobs-query.js';
import { parseOverviewRange } from '../admin-observability/overview-query.js';

export const MAX_EXPORT_ROWS = 10000;
export type ExportDataset = 'jobs' | 'overview';

export function requireExportCapacity(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_EXPORT_ROWS)
    throw adminError('EXPORT_TOO_LARGE');
}

export function exportQuery(
  dataset: ExportDataset,
  raw: Record<string, unknown>,
  now = new Date(),
) {
  if ('cursor' in raw || 'limit' in raw) throw adminError('INVALID_REQUEST');
  const from = raw.from ?? new Date(now.getTime() - 7 * 86400000).toISOString();
  const to = raw.to ?? now.toISOString();
  const range = parseOverviewRange({
    from,
    to,
    ...(dataset === 'overview' && raw.bucket !== undefined
      ? { bucket: raw.bucket }
      : {}),
  });
  const normalized = {
    ...raw,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
  };
  const filter =
    dataset === 'jobs' ? parseAdminJobQuery(normalized).filter : null;
  if (dataset === 'overview') parseOverviewRange(normalized);
  return { range, filter, normalized };
}
