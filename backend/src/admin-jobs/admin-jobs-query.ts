import { Types, trusted } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import { JOB_STATUSES, type JobStatus } from '../jobs/job.types.js';
export function adminJobId(id: unknown): Types.ObjectId {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))
    throw adminError('INVALID_REQUEST');
  return new Types.ObjectId(id);
}
export function encodeAdminJobCursor(
  scope: string,
  at: Date,
  id: string,
): string {
  return Buffer.from(
    JSON.stringify({ scope, at: at.toISOString(), id }),
  ).toString('base64url');
}
export function parseAdminJobQuery(raw: Record<string, unknown>) {
  const allowed = [
    'limit',
    'cursor',
    'status',
    'userId',
    'jobId',
    'from',
    'to',
  ];
  if (Object.keys(raw).some((k) => !allowed.includes(k)))
    throw adminError('INVALID_REQUEST');
  const limit = raw.limit === undefined ? 25 : Number(raw.limit);
  if (
    (raw.limit !== undefined &&
      (typeof raw.limit !== 'string' || !/^\d{1,3}$/.test(raw.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw adminError('INVALID_REQUEST');
  const scopeValues: Record<string, unknown> = {};
  const filter: Record<string, unknown> = { deletedAt: null };
  if (raw.status !== undefined) {
    if (!JOB_STATUSES.includes(raw.status as JobStatus))
      throw adminError('INVALID_REQUEST');
    filter.status = raw.status;
    scopeValues.status = raw.status;
  }
  for (const key of ['userId', 'jobId'] as const)
    if (raw[key] !== undefined) {
      filter[key === 'jobId' ? '_id' : key] = adminJobId(raw[key]);
      scopeValues[key] = raw[key];
    }
  const dates: { from?: Date; to?: Date } = {};
  for (const key of ['from', 'to'] as const)
    if (raw[key] !== undefined) {
      if (
        typeof raw[key] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw[key])
      )
        throw adminError('INVALID_DATE_RANGE');
      const date = new Date(raw[key]);
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 19) !== raw[key].slice(0, 19)
      )
        throw adminError('INVALID_DATE_RANGE');
      dates[key] = date;
      scopeValues[key] = date.toISOString();
    }
  if (dates.from && dates.to && dates.from >= dates.to)
    throw adminError('INVALID_DATE_RANGE');
  if (dates.from || dates.to)
    filter.createdAt = trusted({
      ...(dates.from ? { $gte: dates.from } : {}),
      ...(dates.to ? { $lt: dates.to } : {}),
    });
  const scope = operationFingerprint(scopeValues);
  let after: { at: Date; id: string } | undefined;
  if (raw.cursor !== undefined) {
    try {
      if (
        typeof raw.cursor !== 'string' ||
        raw.cursor.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(raw.cursor)
      )
        throw new Error();
      const c = JSON.parse(
        Buffer.from(raw.cursor, 'base64url').toString(),
      ) as Record<string, unknown>;
      if (
        !c ||
        Object.keys(c).sort().join(',') !== 'at,id,scope' ||
        c.scope !== scope ||
        typeof c.at !== 'string' ||
        typeof c.id !== 'string'
      )
        throw new Error();
      const at = new Date(c.at);
      adminJobId(c.id);
      if (
        at.toISOString() !== c.at ||
        encodeAdminJobCursor(scope, at, c.id) !== raw.cursor
      )
        throw new Error();
      after = { at, id: c.id };
      filter.$or = [
        { createdAt: trusted({ $lt: at }) },
        { createdAt: at, _id: trusted({ $lt: adminJobId(c.id) }) },
      ];
    } catch {
      throw adminError('INVALID_CURSOR');
    }
  }
  return { limit, filter, scope, after };
}
