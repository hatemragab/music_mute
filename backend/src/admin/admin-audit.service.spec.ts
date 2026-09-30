import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { AdminAuditService } from './admin-audit.service.js';

describe('administrator audit history', () => {
  it('uses the chronological index and preserves tied-date cursor filters across pages', async () => {
    const at = new Date('2026-09-30T10:00:00.000Z');
    const row = (id: string) => ({
      _id: new Types.ObjectId(id),
      actorUid: 'selected',
      action: 'jobs.cancel',
      resourceType: 'job',
      resourceId: 'job-one',
      operationId: '1c2a047d-e63e-40d5-8a71-22ee3b65d804',
      reason: 'Customer support request',
      at,
      previousRevision: 1,
      nextRevision: 2,
      outcome: 'succeeded',
    });
    const first = row('64b000000000000000000002');
    const second = row('64b000000000000000000001');
    const query = {
      hint: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maxTimeMS: vi.fn().mockReturnThis(),
      lean: vi
        .fn()
        .mockResolvedValueOnce([first, second])
        .mockResolvedValueOnce([second]),
    };
    const events = { find: vi.fn((_filter: unknown) => query) };
    const service = new AdminAuditService(events as never);
    const initial = await service.list({ actorUid: 'selected', limit: '1' });
    const next = await service.list({
      actorUid: 'selected',
      limit: '1',
      cursor: initial.nextCursor,
    });

    expect(initial.items.map(({ id }) => id)).toEqual([first._id.toString()]);
    expect(next.items.map(({ id }) => id)).toEqual([second._id.toString()]);
    expect(next.nextCursor).toBeNull();
    expect(query.hint).toHaveBeenNthCalledWith(1, 'admin_audit_time');
    expect(query.hint).toHaveBeenNthCalledWith(2, 'admin_audit_time');
    expect(query.sort).toHaveBeenCalledWith({ at: -1, _id: -1 });
    expect(query.limit).toHaveBeenCalledWith(2);
    expect(query.maxTimeMS).toHaveBeenCalledWith(5000);
    expect(events.find.mock.calls[1]?.[0]).toMatchObject({
      actorUid: 'selected',
      $or: [{ at: { $lt: at } }, { at, _id: { $lt: first._id } }],
    });
  });
});
