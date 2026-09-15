import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  Types,
  trusted,
  type Connection,
  type Model,
  type QueryFilter,
} from 'mongoose';
import { timingSafeEqual } from 'node:crypto';
import { adminError } from '../admin/admin-errors.js';
import { WORKER_ID_PATTERN } from '../worker/worker-registration.schema.js';
import { WorkerEvent } from './worker-event.schema.js';
import {
  EVENT_CATEGORIES,
  EVENT_STAGES,
  EVENT_STATUSES,
  EVENT_UUID,
  eventFingerprint,
  reportingState,
} from './worker-event-policy.js';

@Injectable()
export class WorkerEventsQueryService {
  constructor(
    @InjectConnection() private readonly db: Connection,
    @InjectModel(WorkerEvent.name) private readonly events: Model<WorkerEvent>,
    private readonly config: ConfigService,
  ) {}
  async forWorker(id: string, query: Record<string, unknown>) {
    if (!WORKER_ID_PATTERN.test(id)) throw adminError('INVALID_REQUEST');
    const worker = await this.db
      .collection<{ _id: string; installationId: string }>('audio_workers')
      .findOne({ _id: id }, { projection: { installationId: 1 } });
    if (!worker) throw adminError('RESOURCE_NOT_FOUND');
    if (!EVENT_UUID.test(worker.installationId ?? ''))
      throw adminError('INVALID_REQUEST');
    return this.forInstallation(worker.installationId, query);
  }
  async forInstallation(
    installationId: string,
    query: Record<string, unknown>,
  ) {
    if (!EVENT_UUID.test(installationId)) throw adminError('INVALID_REQUEST');
    if (
      !(await this.db
        .collection<{ _id: string }>('worker_installations')
        .findOne({ _id: installationId }, { projection: { _id: 1 } }))
    )
      throw adminError('RESOURCE_NOT_FOUND');
    if (
      Object.keys(query).some(
        (key) =>
          ![
            'category',
            'operationId',
            'stage',
            'status',
            'from',
            'to',
            'limit',
            'cursor',
          ].includes(key),
      ) ||
      Object.values(query).some((value) => typeof value !== 'string')
    )
      throw adminError('INVALID_REQUEST');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw adminError('INVALID_REQUEST');
    const filters: Record<string, string> = {};
    for (const [key, allowed] of [
      ['category', EVENT_CATEGORIES],
      ['stage', EVENT_STAGES],
      ['status', EVENT_STATUSES],
    ] as const) {
      if (query[key] !== undefined) {
        if (!allowed.includes(query[key] as never))
          throw adminError('INVALID_REQUEST');
        filters[key] = query[key] as string;
      }
    }
    if (query.operationId !== undefined) {
      if (!EVENT_UUID.test(query.operationId as string))
        throw adminError('INVALID_REQUEST');
      filters.operationId = query.operationId as string;
    }
    const times: Record<string, Date> = {};
    for (const key of ['from', 'to'])
      if (query[key] !== undefined) {
        const value = query[key] as string;
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString() !== value
        )
          throw adminError('INVALID_REQUEST');
        times[key] = new Date(value);
        filters[key] = value;
      }
    if (times.from && times.to && times.from > times.to)
      throw adminError('INVALID_REQUEST');
    const secret = this.config.getOrThrow<string>('RATE_LIMIT_HASH_SECRET');
    const filterId = eventFingerprint({ installationId, ...filters }, secret);
    const now = new Date();
    const scope = { installationId, expiresAt: trusted({ $gt: now }) };
    const filter: QueryFilter<WorkerEvent> = {
      ...scope,
      ...Object.fromEntries(
        Object.entries(filters).filter(
          ([key]) => !['from', 'to'].includes(key),
        ),
      ),
    };
    if (times.from || times.to)
      filter.receivedAt = trusted({
        ...(times.from ? { $gte: times.from } : {}),
        ...(times.to ? { $lte: times.to } : {}),
      });
    if (query.cursor !== undefined) {
      try {
        const cursor = query.cursor as string;
        if (cursor.length > 2048) throw new Error();
        const [encoded, signature, ...extra] = cursor.split('.');
        if (
          extra.length ||
          !encoded ||
          !signature ||
          !/^[a-f0-9]{64}$/.test(signature)
        )
          throw new Error();
        const expected = eventFingerprint(encoded, secret);
        if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
          throw new Error();
        const decoded = JSON.parse(
          Buffer.from(encoded, 'base64url').toString(),
        ) as { filterId: string; receivedAt: string; id: string };
        if (
          decoded.filterId !== filterId ||
          !/^[a-f0-9]{24}$/.test(decoded.id) ||
          !Number.isFinite(Date.parse(decoded.receivedAt))
        )
          throw new Error();
        const date = new Date(decoded.receivedAt);
        filter.$or = [
          { receivedAt: trusted({ $lt: date }) },
          {
            receivedAt: date,
            _id: trusted({ $lt: new Types.ObjectId(decoded.id) }),
          },
        ];
      } catch {
        throw adminError('INVALID_REQUEST');
      }
    }
    const [rows, latest] = await Promise.all([
      this.events
        .find(filter)
        .sort({ receivedAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean(),
      this.events
        .findOne(scope)
        .sort({ receivedAt: -1, _id: -1 })
        .select('operationId')
        .lean(),
    ]);
    // Receipt picks the reporting operation; sequence orders that operation.
    // A later spool flush of old progress must not undo its terminal outcome.
    const head = latest
      ? await this.events
          .findOne({ ...scope, operationId: latest.operationId })
          .sort({ sequence: -1, receivedAt: -1, _id: -1 })
          .select('status receivedAt')
          .lean()
      : null;
    const page = rows.slice(0, limit),
      last = page.at(-1);
    let nextCursor: string | null = null;
    if (rows.length > limit && last) {
      const encoded = Buffer.from(
        JSON.stringify({
          filterId,
          receivedAt: last.receivedAt.toISOString(),
          id: last._id.toString(),
        }),
      ).toString('base64url');
      nextCursor = encoded + '.' + eventFingerprint(encoded, secret);
    }
    return {
      items: page.map((row) => ({
        eventId: row.eventId,
        installationId: row.installationId,
        workerId: row.workerId,
        operationId: row.operationId,
        sequence: row.sequence,
        category: row.category,
        stage: row.stage,
        status: row.status,
        occurredAt: row.occurredAt,
        ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
        ...(row.code ? { code: row.code } : {}),
        ...(row.details ? { details: row.details } : {}),
        receivedAt: row.receivedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      nextCursor,
      reporting: {
        scope: 'most_recently_reported_operation',
        operationId: latest?.operationId ?? null,
        ...reportingState(
          head,
          now,
          this.config.getOrThrow<number>('WORKER_EVENTS_STALE_SECONDS'),
        ),
      },
      serverTime: now.toISOString(),
    };
  }
}
