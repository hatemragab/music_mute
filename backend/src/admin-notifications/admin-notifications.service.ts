import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, trusted, type Model } from 'mongoose';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import {
  NotificationCampaign,
  CampaignDelivery,
} from './notification-campaign.schema.js';
import type { CreateNotificationDto } from './create-notification.dto.js';

@Injectable()
export class AdminNotificationsService implements OnModuleInit {
  constructor(
    @InjectModel(NotificationCampaign.name)
    private readonly campaigns: Model<NotificationCampaign>,
    @InjectModel(CampaignDelivery.name)
    private readonly deliveries: Model<CampaignDelivery>,
    private readonly operations: AdminOperationsService,
  ) {}
  async onModuleInit() {
    await Promise.all([this.campaigns.init(), this.deliveries.init()]);
  }
  async create(actor: AdminActor, dto: CreateNotificationDto) {
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/notifications',
        request: { title: dto.title, body: dto.body },
        action: 'notifications.create',
        resourceType: 'notification_campaign',
        reason: dto.reason,
      },
      async (session) => {
        const [campaign] = await this.campaigns.create(
          [
            {
              title: dto.title,
              body: dto.body,
              reason: dto.reason,
              actorUid: actor.uid,
            },
          ],
          { session },
        );
        return { resourceId: campaign._id.toHexString(), value: null };
      },
    );
    return this.detail(result.receipt.resourceId!);
  }
  async list(query: Record<string, unknown>) {
    if (Object.keys(query).some((key) => !['cursor', 'limit'].includes(key)))
      throw adminError('INVALID_REQUEST');
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (query.limit !== undefined && typeof query.limit !== 'string')
    )
      throw adminError('INVALID_REQUEST');
    const cursor = query.cursor === undefined ? null : this.id(query.cursor);
    const rows = await this.campaigns
      .find(cursor ? { _id: trusted({ $lt: cursor }) } : {})
      .sort({ _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      items: await Promise.all(rows.map((row) => this.present(row))),
      asOf: new Date().toISOString(),
      nextCursor: more ? rows.at(-1)!._id.toHexString() : null,
    };
  }
  async detail(id: string) {
    const row = await this.campaigns
      .findById(this.id(id))
      .maxTimeMS(5000)
      .lean();
    if (!row) throw adminError('RESOURCE_NOT_FOUND');
    return this.present(row);
  }
  private id(value: unknown) {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value))
      throw adminError('INVALID_REQUEST');
    return new Types.ObjectId(value);
  }
  private async present(row: NotificationCampaign) {
    const counts = {
      pending: 0,
      sent: 0,
      failed: 0,
      invalid: 0,
      ineligible: 0,
    };
    const groups = await this.deliveries
      .aggregate<{ _id: keyof typeof counts; count: number }>([
        { $match: { outboxId: row._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .option({ maxTimeMS: 5000 });
    for (const group of groups) counts[group._id] = group.count;
    return {
      id: row._id.toHexString(),
      title: row.title,
      body: row.body,
      reason: row.reason,
      actorUid: row.actorUid,
      audience: 'all_users',
      state: row.state,
      targetsFrozen: row.frozen,
      counts,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }
}
