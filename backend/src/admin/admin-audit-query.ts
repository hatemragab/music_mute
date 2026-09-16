export interface ProcessingChangeMetadata {
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}
const processingAuditFields = new Set([
  'allowanceAudioSeconds',
  'allowanceExpiresAt',
  'processingSuspended',
  'suspensionExpiresAt',
  'acceptNewJobs',
  'maxActiveJobsPerUser',
]);
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { adminError } from './admin-errors.js';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const name = /^[a-z][a-z0-9_.-]{0,79}$/;

export interface AuditPageQuery {
  limit: number;
  cursor?: string;
  from?: Date;
  to?: Date;
  actorUid?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
}

export interface AuditExportMetadata {
  dataset: 'jobs' | 'overview';
  from: string;
  to: string;
  rowCount: number;
}

export interface AuditEventInput {
  processingChanges?: ProcessingChangeMetadata[] | null;
  exportMetadata?: AuditExportMetadata | null;
  actorUid: string;
  action: string;
  resourceType: string;
  resourceId: string;
  operationId: string;
  reason: string | null;
  previousRevision: number | null;
  nextRevision: number | null;
  outcome: 'succeeded';
}

function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

export function validOperationId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 16) throw adminError('INVALID_REQUEST');
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`,
      )
      .join(',')}}`;
  }
  throw adminError('INVALID_REQUEST');
}

export function operationFingerprint(value: unknown): string {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded) > 65536) throw adminError('INVALID_REQUEST');
  return createHash('sha256').update(encoded).digest('hex');
}

export function auditPage(raw: Record<string, unknown>): AuditPageQuery {
  const allowed = [
    'limit',
    'cursor',
    'from',
    'to',
    'actorUid',
    'action',
    'resourceType',
    'resourceId',
  ];
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    throw adminError('INVALID_REQUEST');
  const limit = raw.limit === undefined ? 25 : Number(raw.limit);
  if (
    (raw.limit !== undefined && !/^\d{1,3}$/.test(String(raw.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw adminError('INVALID_REQUEST');
  const result: AuditPageQuery = { limit };
  for (const key of [
    'actorUid',
    'action',
    'resourceType',
    'resourceId',
  ] as const) {
    if (raw[key] !== undefined) {
      if (
        !bounded(raw[key], 128) ||
        ((key === 'action' || key === 'resourceType') && !name.test(raw[key]))
      )
        throw adminError('INVALID_REQUEST');
      result[key] = raw[key];
    }
  }
  for (const key of ['from', 'to'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw[key]))
        throw adminError('INVALID_DATE_RANGE');
      const date = new Date(raw[key]);
      if (!Number.isFinite(date.getTime()))
        throw adminError('INVALID_DATE_RANGE');
      result[key] = date;
    }
  }
  if (result.from && result.to && result.from >= result.to)
    throw adminError('INVALID_DATE_RANGE');
  if (raw.cursor !== undefined) {
    if (!bounded(raw.cursor, 4096)) throw adminError('INVALID_CURSOR');
    result.cursor = raw.cursor;
  }
  return result;
}

function scope(query: AuditPageQuery): string {
  return operationFingerprint({
    from: query.from?.toISOString() ?? null,
    to: query.to?.toISOString() ?? null,
    actorUid: query.actorUid ?? null,
    action: query.action ?? null,
    resourceType: query.resourceType ?? null,
    resourceId: query.resourceId ?? null,
  });
}

export function encodeAuditCursor(
  query: AuditPageQuery,
  id: string,
  at: Date,
): string {
  return Buffer.from(
    JSON.stringify({ id, at: at.toISOString(), scope: scope(query) }),
  ).toString('base64url');
}

export function decodeAuditCursor(
  query: AuditPageQuery,
  cursor: string,
): { id: string; at: Date } {
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error();
    const value = decoded as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(',') !== 'at,id,scope' ||
      value.scope !== scope(query) ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9]{24}$/.test(value.id) ||
      !Types.ObjectId.isValid(value.id) ||
      typeof value.at !== 'string'
    )
      throw new Error();
    const at = new Date(value.at);
    if (!Number.isFinite(at.getTime()) || at.toISOString() !== value.at)
      throw new Error();
    return { id: value.id, at };
  } catch {
    throw adminError('INVALID_CURSOR');
  }
}

export function validateAuditEvent(
  value: AuditEventInput | Record<string, unknown>,
): AuditEventInput {
  const keys = [
    'actorUid',
    'action',
    'resourceType',
    'resourceId',
    'operationId',
    'reason',
    'previousRevision',
    'nextRevision',
    'outcome',
  ];
  if (
    Object.keys(value).some(
      (key) =>
        key !== 'processingChanges' &&
        key !== 'exportMetadata' &&
        !keys.includes(key),
    ) ||
    keys.some((key) => !(key in value))
  )
    throw adminError('INVALID_REQUEST');
  if (
    !bounded(value.actorUid, 128) ||
    !bounded(value.resourceId, 128) ||
    typeof value.action !== 'string' ||
    !name.test(value.action) ||
    typeof value.resourceType !== 'string' ||
    !name.test(value.resourceType) ||
    !validOperationId(value.operationId) ||
    value.outcome !== 'succeeded'
  )
    throw adminError('INVALID_REQUEST');
  if (
    value.reason !== null &&
    (!bounded(value.reason, 500) || value.reason.trim() !== value.reason)
  )
    throw adminError('INVALID_REQUEST');
  for (const key of ['previousRevision', 'nextRevision'] as const) {
    if (
      value[key] !== null &&
      (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
    )
      throw adminError('INVALID_REQUEST');
  }
  if (value.processingChanges != null) {
    if (
      !Array.isArray(value.processingChanges) ||
      value.processingChanges.length > 20 ||
      !['user', 'processing_settings'].includes(String(value.resourceType))
    )
      throw adminError('INVALID_REQUEST');
    for (const change of value.processingChanges as ProcessingChangeMetadata[]) {
      if (
        !change ||
        Object.keys(change).sort().join(',') !== 'after,before,field' ||
        !processingAuditFields.has(change.field)
      )
        throw adminError('INVALID_REQUEST');
      for (const item of [change.before, change.after])
        if (
          item !== null &&
          !(
            typeof item === 'boolean' ||
            (typeof item === 'number' && Number.isFinite(item)) ||
            (typeof item === 'string' &&
              item.length <= 200 &&
              !/[\r\n]/.test(item) &&
              !item.includes(String.fromCharCode(0)))
          )
        )
          throw adminError('INVALID_REQUEST');
    }
  }
  if (value.exportMetadata != null) {
    const metadata = value.exportMetadata as AuditExportMetadata;
    if (
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.keys(metadata).sort().join(',') !== 'dataset,from,rowCount,to' ||
      !['jobs', 'overview'].includes(metadata.dataset) ||
      value.resourceType !== 'export' ||
      value.action !== `exports.${metadata.dataset}` ||
      !Number.isSafeInteger(metadata.rowCount) ||
      metadata.rowCount < 0 ||
      metadata.rowCount > 10000 ||
      typeof metadata.from !== 'string' ||
      typeof metadata.to !== 'string' ||
      !Number.isFinite(Date.parse(metadata.from)) ||
      !Number.isFinite(Date.parse(metadata.to)) ||
      new Date(metadata.from).toISOString() !== metadata.from ||
      new Date(metadata.to).toISOString() !== metadata.to ||
      Date.parse(metadata.from) >= Date.parse(metadata.to) ||
      Date.parse(metadata.to) - Date.parse(metadata.from) > 90 * 86400000
    )
      throw adminError('INVALID_REQUEST');
  }
  return value as unknown as AuditEventInput;
}
