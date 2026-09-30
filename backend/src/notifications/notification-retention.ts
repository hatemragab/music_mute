import { trusted, type Model, type Types } from 'mongoose';
import type { NotificationDelivery } from './notification-delivery.schema.js';

export const NOTIFICATION_DETAIL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_RETENTION_BATCH_SIZE = 100;
export const NOTIFICATION_RETENTION_RECHECK_MS = 60 * 60 * 1000;

/** Only call after the durable parent has completed and cannot freeze/send again. */
export async function scheduleCompletedDeliveryRetention<
  T extends NotificationDelivery,
>(
  deliveries: Model<T>,
  outboxId: Types.ObjectId,
  completedAt: Date,
): Promise<boolean> {
  // Legacy deletion could complete the parent before cancelling its children.
  // Retain all detail until those children are terminal, including the parent's
  // completion marker and (for campaigns) its summary expiry.
  if (await deliveries.exists({ outboxId, status: 'pending' }).exec())
    return false;
  const rows = await deliveries
    .find({
      outboxId,
      status: trusted({ $ne: 'pending' }),
      purgeAt: null,
    })
    .setOptions({ sanitizeFilter: false })
    .select('_id')
    .sort({ _id: 1 })
    .limit(NOTIFICATION_RETENTION_BATCH_SIZE)
    .lean()
    .exec();
  if (rows.length > 0) {
    await deliveries
      .updateMany(
        {
          _id: trusted({ $in: rows.map((row) => row._id) }),
          outboxId,
          status: trusted({ $ne: 'pending' }),
          purgeAt: null,
        },
        {
          $set: {
            purgeAt: new Date(
              completedAt.getTime() + NOTIFICATION_DETAIL_RETENTION_MS,
            ),
          },
        },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
  }
  return rows.length < NOTIFICATION_RETENTION_BATCH_SIZE;
}
