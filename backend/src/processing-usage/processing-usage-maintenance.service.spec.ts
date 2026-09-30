import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Model } from 'mongoose';
import type { ProcessingTransactions } from '../processing/processing-transactions.js';
import { ProcessingUsageMaintenanceService } from './processing-usage-maintenance.service.js';
import type { AccountUsagePeriod } from './processing-usage.schema.js';
import type { ProcessingUsageService } from './processing-usage.service.js';

function fixture(rows: Array<{ _id: string }> = []) {
  const query = {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maxTimeMS: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(rows),
  };
  const periods = { find: vi.fn((_filter: unknown) => query) };
  const session = { inTransaction: () => true };
  const usage = {
    restoreClosedPeriodExpiry: vi.fn(async (..._args: unknown[]) => true),
  };
  const transactions = {
    run: vi.fn((operation: (session: unknown) => unknown) =>
      operation(session),
    ),
  };
  const service = new ProcessingUsageMaintenanceService(
    periods as unknown as Model<AccountUsagePeriod>,
    usage as unknown as ProcessingUsageService,
    transactions as unknown as ProcessingTransactions,
  );
  return { service, query, periods, usage, transactions, session };
}

describe('ProcessingUsageMaintenanceService', () => {
  afterEach(() => vi.useRealTimers());

  it('repairs only closed, unreserved periods within transactions', async () => {
    const { service, periods, query, usage, session } = fixture([
      { _id: 'owner:2026-08' },
    ]);
    const now = new Date('2026-09-30T12:00:00Z');
    await service.repairDue(now);
    expect(periods.find).toHaveBeenCalledWith(
      expect.objectContaining({
        periodKey: expect.objectContaining({ $lt: '2026-09' }),
        purgeAt: null,
        processingReservationCount: 0,
        processingReservedSeconds: 0,
      }),
    );
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(query.maxTimeMS).toHaveBeenCalledWith(5000);
    expect(usage.restoreClosedPeriodExpiry).toHaveBeenCalledWith(
      'owner:2026-08',
      session,
      now,
    );
  });

  it('advances past an unrepairable full batch and wraps after completing the scan', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      _id: `owner-${String(i).padStart(3, '0')}:2026-08`,
    }));
    const { service, periods, query, usage } = fixture(rows);
    usage.restoreClosedPeriodExpiry.mockResolvedValue(false);
    await service.repairDue();
    query.lean.mockResolvedValueOnce([]);
    await service.repairDue();
    expect(periods.find.mock.calls[1]?.[0]).toMatchObject({
      _id: { $gt: rows[99]!._id },
    });
    query.lean.mockResolvedValueOnce([]);
    await service.repairDue();
    expect(periods.find.mock.calls[2]?.[0]).not.toHaveProperty('_id');
  });

  it('advances after a rejected transaction so one failing row cannot block the scan', async () => {
    const { service, periods, query, usage } = fixture([
      { _id: 'contended:2026-08' },
    ]);
    usage.restoreClosedPeriodExpiry.mockRejectedValueOnce(
      new Error('fixture conflict'),
    );
    await expect(service.repairDue()).rejects.toThrow('fixture conflict');
    query.lean.mockResolvedValueOnce([]);
    await service.repairDue();
    expect(periods.find.mock.calls[1]?.[0]).toMatchObject({
      _id: { $gt: 'contended:2026-08' },
    });
    query.lean.mockResolvedValueOnce([]);
    await service.repairDue();
    expect(periods.find.mock.calls[2]?.[0]).not.toHaveProperty('_id');
  });

  it('does not overlap slow passes and stops after shutdown', async () => {
    vi.useFakeTimers();
    const { service, query, periods } = fixture();
    let release!: () => void;
    query.lean.mockImplementationOnce(
      () =>
        new Promise<Array<{ _id: string }>>((resolve) => {
          release = () => resolve([]);
        }),
    );
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(periods.find).toHaveBeenCalledOnce();
    release();
    await service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(periods.find).toHaveBeenCalledOnce();
  });
});
