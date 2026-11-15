import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, trusted, type ClientSession, type Model } from 'mongoose';
import { AdminAuditEvent } from './admin-audit.schema.js';
import {
  auditPage,
  decodeAuditCursor,
  encodeAuditCursor,
  validateAuditEvent,
  type AuditEventInput,
} from './admin-audit-query.js';

@Injectable()
export class AdminAuditService implements OnModuleInit {
  constructor(
    @InjectModel(AdminAuditEvent.name)
    private readonly events: Model<AdminAuditEvent>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.events.init();
  }

  async record(event: AuditEventInput, session: ClientSession): Promise<void> {
    if (!session.inTransaction())
      throw new Error('Audit requires a transaction');
    const metadata = validateAuditEvent(event);
    await this.events.create([{ ...metadata, at: new Date() }], { session });
  }

  async list(raw: Record<string, unknown>) {
    const query = auditPage(raw);
    const filter: Record<string, unknown> = {};
    for (const key of [
      'actorUid',
      'action',
      'resourceType',
      'resourceId',
    ] as const) {
      if (query[key] !== undefined) filter[key] = query[key];
    }
    if (query.from || query.to)
      filter.at = trusted({
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lt: query.to } : {}),
      });
    if (query.cursor) {
      const after = decodeAuditCursor(query, query.cursor);
      filter.$or = [
        { at: trusted({ $lt: after.at }) },
        { at: after.at, _id: trusted({ $lt: new Types.ObjectId(after.id) }) },
      ];
    }
    const records = await this.events
      .find(filter)
      .sort({ at: -1, _id: -1 })
      .limit(query.limit + 1)
      .maxTimeMS(5000)
      .lean();
    const hasMore = records.length > query.limit;
    const visible = records.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      items: visible.map((event) => ({
        id: event._id.toString(),
        actorUid: event.actorUid,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        operationId: event.operationId,
        reason: event.reason,
        at: event.at.toISOString(),
        previousRevision: event.previousRevision,
        nextRevision: event.nextRevision,
        outcome: event.outcome,
        ...(event.processingChanges
          ? {
              processingChanges: event.processingChanges.map(
                ({ field, before, after }) => ({ field, before, after }),
              ),
            }
          : {}),
        ...(event.exportMetadata
          ? {
              exportMetadata: {
                dataset: event.exportMetadata.dataset,
                from: event.exportMetadata.from,
                to: event.exportMetadata.to,
                rowCount: event.exportMetadata.rowCount,
              },
            }
          : {}),
      })),
      nextCursor:
        hasMore && last
          ? encodeAuditCursor(query, last._id.toString(), last.at)
          : null,
      asOf: new Date().toISOString(),
    };
  }
}
