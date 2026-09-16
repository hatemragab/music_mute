import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { AdminAlertsService } from './admin-alerts.service.js';

function chain<T>(value: T) {
  const result: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['sort', 'limit', 'maxTimeMS', 'session'])
    result[name] = vi.fn(() => result);
  result.lean = vi.fn().mockResolvedValue(value);
  return result;
}

describe('AdminAlertsService', () => {
  it('acknowledges an active alert without resolving its condition', async () => {
    const id = new Types.ObjectId('64b000000000000000000001');
    const current = {
      _id: id,
      type: 'apk_rejected',
      severity: 'critical',
      resourceId: 'release-a',
      state: 'active',
      firstSeenAt: new Date('2026-09-11T00:00:00Z'),
      lastSeenAt: new Date('2026-09-11T00:01:00Z'),
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      revision: 0,
      message: 'APK verification was rejected',
    };
    const alerts = {
      findOne: vi.fn(() => chain(current)),
      findOneAndUpdate: vi.fn(() =>
        chain({
          ...current,
          acknowledgedAt: new Date('2026-09-11T00:02:00Z'),
          acknowledgedBy: 'manager',
          revision: 1,
        }),
      ),
    };
    const operations = {
      run: vi.fn(async (_actor, _command, mutate) => ({
        value: (await mutate({})).value,
        receipt: {},
        replayed: false,
      })),
    };
    const service = new AdminAlertsService(
      alerts as never,
      {} as never,
      {} as never,
      operations as never,
    );
    const result = await service.acknowledge(
      { uid: 'manager', role: 'support', accessRevision: 0 } as never,
      id.toHexString(),
      {
        expectedRevision: 0,
        operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
        reason: 'Incident is being investigated',
      },
    );
    expect(result.state).toBe('active');
    expect(result.acknowledgedBy).toBe('manager');
    const update = (
      alerts.findOneAndUpdate.mock.calls as unknown as [
        unknown,
        { $set: Record<string, unknown> },
      ][]
    )[0]![1];
    expect(update.$set).not.toHaveProperty('state');
    expect(update.$set).not.toHaveProperty('resolvedAt');
  });

  it('rejects a repeated acknowledgment of the same episode', async () => {
    const id = new Types.ObjectId('64b000000000000000000003');
    const alerts = {
      findOne: vi.fn(() =>
        chain({
          _id: id,
          state: 'active',
          acknowledgedAt: new Date('2026-09-11T00:02:00Z'),
          revision: 1,
        }),
      ),
    };
    const operations = {
      run: vi.fn(async (_actor, _command, mutate) => mutate({})),
    };
    const service = new AdminAlertsService(
      alerts as never,
      {} as never,
      {} as never,
      operations as never,
    );
    await expect(
      service.acknowledge(
        { uid: 'manager', role: 'support', accessRevision: 0 } as never,
        id.toHexString(),
        {
          expectedRevision: 1,
          operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
          reason: 'Already under investigation',
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'INVALID_REQUEST' } });
  });

  it('binds alert cursors to state and severity filters', async () => {
    const firstId = new Types.ObjectId('64b000000000000000000002');
    const row = {
      _id: firstId,
      type: 'apk_rejected',
      severity: 'warning',
      resourceId: 'release-a',
      state: 'active',
      firstSeenAt: new Date('2026-09-11T00:00:00Z'),
      lastSeenAt: new Date('2026-09-11T00:01:00Z'),
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      revision: 0,
      message: 'APK verification was rejected',
    };
    const service = new AdminAlertsService(
      {
        find: vi
          .fn()
          .mockReturnValueOnce(chain([row, row]))
          .mockReturnValueOnce(chain([])),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const first = await service.list({ state: 'active', limit: '1' });
    await expect(
      service.list({
        state: 'resolved',
        limit: '1',
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
  });
});
