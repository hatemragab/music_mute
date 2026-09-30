import type { Model, Types } from 'mongoose';
import type { NotificationDeliveryStatus } from '../notifications/notification-delivery.schema.js';
import type { CampaignDelivery } from './notification-campaign.schema.js';

export type CampaignDeliveryCounts = Record<NotificationDeliveryStatus, number>;

export async function campaignDeliveryCounts(
  deliveries: Model<CampaignDelivery>,
  outboxId: Types.ObjectId,
): Promise<CampaignDeliveryCounts> {
  const counts: CampaignDeliveryCounts = {
    pending: 0,
    sent: 0,
    failed: 0,
    invalid: 0,
    ineligible: 0,
  };
  const groups = await deliveries
    .aggregate<{ _id: NotificationDeliveryStatus; count: number }>([
      { $match: { outboxId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    .option({ maxTimeMS: 5000 });
  for (const group of groups) counts[group._id] = group.count;
  return counts;
}
