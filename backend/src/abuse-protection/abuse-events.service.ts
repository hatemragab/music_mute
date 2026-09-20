import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, Types, type Model } from 'mongoose';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import { adminError } from '../admin/admin-errors.js';
import {
  ABUSE_EVENT_SEVERITIES,
  ABUSE_EVENT_TYPES,
  type AbuseEventSeverity,
  type AbuseEventType,
  type RecordAbuseEvent,
} from './abuse-protection.types.js';
import { AbuseEventBucket, AbuseMonthlySummary } from './abuse-event.schema.js';
import { AccountRestriction } from './account-restriction.schema.js';

const DETAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const BUCKET_MS = 60 * 60 * 1000;
const MAX_EVENT_INCREMENT = 10_000;

interface EventQuery {
  accountId?: Types.ObjectId;
  type?: AbuseEventType;
  severity?: AbuseEventSeverity;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

function objectId(value: string): Types.ObjectId {
  if (!/^[a-f0-9]{24}$/i.test(value) || !Types.ObjectId.isValid(value))
    throw adminError('INVALID_REQUEST');
  return new Types.ObjectId(value);
}

function exactDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw adminError('INVALID_REQUEST');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw adminError('INVALID_REQUEST');
  return date;
}

function pageQuery(raw: Record<string, unknown>): EventQuery {
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          'accountId',
          'type',
          'severity',
          'from',
          'to',
          'limit',
          'cursor',
        ].includes(key),
    )
  )
    throw adminError('INVALID_REQUEST');
  const type = raw.type === undefined ? undefined : String(raw.type);
  const severity =
    raw.severity === undefined ? undefined : String(raw.severity);
  if (type && !ABUSE_EVENT_TYPES.includes(type as AbuseEventType))
    throw adminError('INVALID_REQUEST');
  if (
    severity &&
    !ABUSE_EVENT_SEVERITIES.includes(severity as AbuseEventSeverity)
  )
    throw adminError('INVALID_REQUEST');
  const limit = raw.limit === undefined ? 50 : Number(raw.limit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (raw.limit !== undefined && !/^\d{1,3}$/.test(String(raw.limit)))
  )
    throw adminError('INVALID_REQUEST');
  const from = exactDate(raw.from);
  const to = exactDate(raw.to);
  if (from && to && from >= to) throw adminError('INVALID_DATE_RANGE');
  return {
    ...(raw.accountId === undefined
      ? {}
      : { accountId: objectId(String(raw.accountId)) }),
    ...(type ? { type: type as AbuseEventType } : {}),
    ...(severity ? { severity: severity as AbuseEventSeverity } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit,
    ...(raw.cursor === undefined ? {} : { cursor: String(raw.cursor) }),
  };
}

@Injectable()
export class AbuseEventsService implements OnModuleInit {
  constructor(
    @InjectModel(AbuseEventBucket.name)
    private readonly events: Model<AbuseEventBucket>,
    @InjectModel(AbuseMonthlySummary.name)
    private readonly summaries: Model<AbuseMonthlySummary>,
    @InjectModel(AccountRestriction.name)
    private readonly restrictions: Model<AccountRestriction>,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([this.events.init(), this.summaries.init()]);
  }

  async record(input: RecordAbuseEvent): Promise<void> {
    const accountId = objectId(input.accountId);
    const occurredAt = input.occurredAt ?? new Date();
    if (!Number.isFinite(occurredAt.getTime()))
      throw new TypeError('Invalid abuse event timestamp');
    const increment = input.count ?? 1;
    if (
      !Number.isSafeInteger(increment) ||
      increment < 1 ||
      increment > MAX_EVENT_INCREMENT
    )
      throw new TypeError('Invalid abuse event count');
    const bucketStart = new Date(
      Math.floor(occurredAt.getTime() / BUCKET_MS) * BUCKET_MS,
    );
    const bucketEnd = new Date(bucketStart.getTime() + BUCKET_MS);
    const monthStart = new Date(
      Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), 1),
    );
    const summaryExpiry = new Date(monthStart);
    summaryExpiry.setUTCMonth(summaryExpiry.getUTCMonth() + 13);
    const month = monthStart.toISOString().slice(0, 7);
    const restrictionId = input.restrictionId
      ? objectId(input.restrictionId)
      : null;

    await Promise.all([
      this.events.updateOne(
        {
          accountId,
          type: input.type,
          operationClass: input.operationClass,
          bucketStart,
        },
        [
          {
            $set: {
              accountId,
              type: input.type,
              operationClass: input.operationClass,
              bucketStart,
              bucketEnd,
              firstOccurredAt: {
                $min: [
                  { $ifNull: ['$firstOccurredAt', occurredAt] },
                  occurredAt,
                ],
              },
              lastOccurredAt: {
                $max: [
                  { $ifNull: ['$lastOccurredAt', occurredAt] },
                  occurredAt,
                ],
              },
              severity: input.severity,
              count: {
                $min: [
                  1_000_000,
                  { $add: [{ $ifNull: ['$count', 0] }, increment] },
                ],
              },
              policyRevision: input.policyRevision ?? null,
              restrictionId,
              expiresAt: new Date(bucketEnd.getTime() + DETAIL_RETENTION_MS),
            },
          },
        ],
        { upsert: true, updatePipeline: true },
      ),
      this.summaries.updateOne(
        { accountId, type: input.type, month },
        [
          {
            $set: {
              accountId,
              type: input.type,
              month,
              firstOccurredAt: {
                $min: [
                  { $ifNull: ['$firstOccurredAt', occurredAt] },
                  occurredAt,
                ],
              },
              lastOccurredAt: {
                $max: [
                  { $ifNull: ['$lastOccurredAt', occurredAt] },
                  occurredAt,
                ],
              },
              count: {
                $min: [
                  100_000_000,
                  { $add: [{ $ifNull: ['$count', 0] }, increment] },
                ],
              },
              expiresAt: summaryExpiry,
            },
          },
        ],
        { upsert: true, updatePipeline: true },
      ),
    ]);
  }

  async list(raw: Record<string, unknown>) {
    const query = pageQuery(raw);
    const scope = operationFingerprint({
      accountId: query.accountId?.toHexString() ?? null,
      type: query.type ?? null,
      severity: query.severity ?? null,
      from: query.from?.toISOString() ?? null,
      to: query.to?.toISOString() ?? null,
    });
    const after = query.cursor ? this.decodeCursor(query.cursor, scope) : null;
    const filter: Record<string, unknown> = {
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
    };
    if (query.from || query.to)
      filter.lastOccurredAt = trusted({
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lt: query.to } : {}),
      });
    if (after)
      filter.$or = [
        { lastOccurredAt: trusted({ $lt: after.at }) },
        {
          lastOccurredAt: after.at,
          _id: trusted({ $lt: new Types.ObjectId(after.id) }),
        },
      ];
    const rows = await this.events
      .find(filter)
      .select({
        accountId: 1,
        type: 1,
        severity: 1,
        operationClass: 1,
        firstOccurredAt: 1,
        lastOccurredAt: 1,
        count: 1,
        policyRevision: 1,
        restrictionId: 1,
      })
      .sort({ lastOccurredAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .maxTimeMS(5000)
      .lean();
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1);
    const accountIds = [
      ...new Map(
        visible.map((event) => [
          event.accountId.toHexString(),
          event.accountId,
        ]),
      ).values(),
    ];
    const restrictionRows = accountIds.length
      ? await this.restrictions
          .find({ accountId: trusted({ $in: accountIds }) })
          .select({ accountId: 1, status: 1, expiresAt: 1 })
          .maxTimeMS(5000)
          .lean()
      : [];
    const now = new Date();
    const restrictionByAccount = new Map(
      restrictionRows.map((restriction) => [
        restriction.accountId.toHexString(),
        restriction.status === 'active' &&
        restriction.expiresAt &&
        restriction.expiresAt <= now
          ? 'expired'
          : restriction.status,
      ]),
    );
    return {
      items: visible.map((event) => ({
        id: event._id.toString(),
        accountId: event.accountId.toString(),
        type: event.type,
        severity: event.severity,
        operationClass: event.operationClass,
        count: event.count,
        firstOccurredAt: event.firstOccurredAt.toISOString(),
        lastOccurredAt: event.lastOccurredAt.toISOString(),
        policyRevision: event.policyRevision ?? null,
        restrictionId: event.restrictionId?.toString() ?? null,
        restrictionStatus:
          restrictionByAccount.get(event.accountId.toHexString()) ?? 'none',
      })),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                at: last.lastOccurredAt.toISOString(),
                id: last._id.toString(),
                scope,
              }),
            ).toString('base64url')
          : null,
      asOf: new Date().toISOString(),
    };
  }

  private decodeCursor(
    cursor: string,
    scope: string,
  ): { at: Date; id: string } {
    try {
      if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new Error();
      const decoded = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      if (
        !decoded ||
        Object.keys(decoded).sort().join(',') !== 'at,id,scope' ||
        decoded.scope !== scope ||
        typeof decoded.id !== 'string' ||
        !/^[a-f0-9]{24}$/.test(decoded.id) ||
        typeof decoded.at !== 'string'
      )
        throw new Error();
      const at = new Date(decoded.at);
      if (!Number.isFinite(at.getTime()) || at.toISOString() !== decoded.at)
        throw new Error();
      return { at, id: decoded.id };
    } catch {
      throw adminError('INVALID_CURSOR');
    }
  }
}
