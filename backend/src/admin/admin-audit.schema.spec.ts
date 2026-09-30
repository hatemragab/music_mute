import { describe, expect, it } from 'vitest';
import { AdminAuditEventSchema } from './admin-audit.schema.js';
import { AdminOperationSchema } from './admin-operation.schema.js';

describe('administrator audit retention', () => {
  it('expires audit history after 365 days without expiring command replay receipts', () => {
    expect(AdminAuditEventSchema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { at: 1 },
          expect.objectContaining({
            name: 'admin_audit_expiry',
            expireAfterSeconds: 31_536_000,
          }),
        ],
      ]),
    );
    expect(
      AdminOperationSchema.indexes().some(
        ([, options]) => options.expireAfterSeconds !== undefined,
      ),
    ).toBe(false);
  });
});
