import { Types, trusted, type Model } from 'mongoose';
import { NotificationDelivery } from './notification-delivery.schema.js';
import {
  NOTIFICATION_DETAIL_RETENTION_MS,
  scheduleCompletedDeliveryRetention,
} from './notification-retention.js';

describe('completed notification delivery retention', () => {
  const outboxId = new Types.ObjectId();
  const completedAt = new Date('2026-09-30T10:00:00.000Z');

  function modelFor(size: number, pending = false) {
    const rows = Array.from({ length: size }, () => ({
      _id: new Types.ObjectId(),
    }));
    const query = {
      setOptions: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(rows),
    };
    const update = {
      setOptions: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({ modifiedCount: size }),
    };
    const model = {
      exists: vi.fn().mockReturnValue({
        exec: vi
          .fn()
          .mockResolvedValue(pending ? { _id: new Types.ObjectId() } : null),
      }),
      find: vi.fn().mockReturnValue(query),
      updateMany: vi.fn().mockReturnValue(update),
    };
    return { rows, query, model };
  }

  it('assigns completion-based expiry only to terminal rows in a bounded page', async () => {
    const f = modelFor(100);
    const done = await scheduleCompletedDeliveryRetention(
      f.model as unknown as Model<NotificationDelivery>,
      outboxId,
      completedAt,
    );
    expect(done).toBe(false);
    expect(f.query.limit).toHaveBeenCalledWith(100);
    expect(f.model.find).toHaveBeenCalledWith({
      outboxId,
      status: trusted({ $ne: 'pending' }),
      purgeAt: null,
    });
    expect(f.model.updateMany).toHaveBeenCalledWith(
      {
        _id: trusted({ $in: f.rows.map((row) => row._id) }),
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
    );
  });

  it('holds completion and all expiry dates while any pending child remains', async () => {
    const f = modelFor(1, true);
    expect(
      await scheduleCompletedDeliveryRetention(
        f.model as unknown as Model<NotificationDelivery>,
        outboxId,
        completedAt,
      ),
    ).toBe(false);
    expect(f.model.exists).toHaveBeenCalledWith({
      outboxId,
      status: 'pending',
    });
    expect(f.model.find).not.toHaveBeenCalled();
    expect(f.model.updateMany).not.toHaveBeenCalled();
  });

  it('finishes an empty page without deleting or creating delivery records', async () => {
    const f = modelFor(0);
    expect(
      await scheduleCompletedDeliveryRetention(
        f.model as unknown as Model<NotificationDelivery>,
        outboxId,
        completedAt,
      ),
    ).toBe(true);
    expect(f.model.updateMany).not.toHaveBeenCalled();
  });
});
