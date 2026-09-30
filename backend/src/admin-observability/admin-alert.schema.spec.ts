import { describe, expect, it } from 'vitest';
import { AdminAlertSchema } from './admin-alert.schema.js';

describe('administrator alert retention', () => {
  it('expires only resolved episodes after 90 days and keeps active-condition uniqueness', () => {
    expect(AdminAlertSchema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { resolvedAt: 1 },
          expect.objectContaining({
            name: 'admin_alert_resolved_expiry',
            expireAfterSeconds: 7_776_000,
            partialFilterExpression: { state: 'resolved' },
          }),
        ],
        [
          { type: 1, resourceId: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { state: 'active' },
          }),
        ],
      ]),
    );
  });
});
