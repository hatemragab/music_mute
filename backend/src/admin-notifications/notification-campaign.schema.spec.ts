import { model } from 'mongoose';
import {
  CampaignDeliverySchema,
  NotificationCampaignSchema,
} from './notification-campaign.schema.js';

describe('notification campaign retention', () => {
  it('keeps final counters separate from expiring recipient details', async () => {
    const Campaign = model(
      'NotificationCampaignRetentionSpec',
      NotificationCampaignSchema,
    );
    const campaign = new Campaign({
      title: 'Notice',
      body: 'A test',
      actorUid: 'fixture-admin',
      reason: 'Test',
      state: 'completed',
      finalCounts: {
        pending: 0,
        sent: 100,
        failed: 2,
        invalid: 1,
        ineligible: 3,
      },
    });
    await expect(campaign.validate()).resolves.toBeUndefined();
    expect(campaign.finalCounts!.sent).toBe(100);
    campaign.finalCounts!.sent = -1;
    await expect(campaign.validate()).rejects.toThrow();
    expect(NotificationCampaignSchema.indexes()).toContainEqual([
      { purgeAt: 1 },
      {
        expireAfterSeconds: 0,
        partialFilterExpression: { state: 'completed' },
        name: 'notification_campaign_retention',
      },
    ]);
    expect(CampaignDeliverySchema.indexes()).toContainEqual([
      { purgeAt: 1 },
      {
        expireAfterSeconds: 0,
        partialFilterExpression: {
          status: { $in: ['sent', 'ineligible', 'invalid', 'failed'] },
        },
        name: 'notification_delivery_retention',
      },
    ]);
  });
});
