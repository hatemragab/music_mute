import {
  summarizeMonthlyProcessing,
  utcMonthPeriod,
} from './usage-accounting.js';

describe('UTC calendar-month account usage', () => {
  it('renews at the exact UTC month boundary without rolling replenishments', () => {
    const september = utcMonthPeriod(new Date('2026-09-30T23:59:59.999Z'));
    const october = utcMonthPeriod(new Date('2026-10-01T00:00:00.000Z'));
    expect(september).toMatchObject({
      key: '2026-09',
      start: new Date('2026-09-01T00:00:00.000Z'),
      end: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(october).toMatchObject({
      key: '2026-10',
      start: new Date('2026-10-01T00:00:00.000Z'),
      end: new Date('2026-11-01T00:00:00.000Z'),
    });
  });

  it('gives a new or empty period the complete 7,200-second allowance', () => {
    expect(
      summarizeMonthlyProcessing(
        {
          processingUsedSeconds: 0,
          processingReservedSeconds: 0,
          processingReleasedSeconds: 0,
        },
        7_200,
      ),
    ).toEqual({
      usedSeconds: 0,
      reservedSeconds: 0,
      releasedSeconds: 0,
      remainingSeconds: 7_200,
    });
  });

  it('never returns negative remaining capacity after an admin reduction', () => {
    expect(
      summarizeMonthlyProcessing(
        {
          processingUsedSeconds: 6_000,
          processingReservedSeconds: 1_200,
          processingReleasedSeconds: 300,
        },
        3_600,
      ).remainingSeconds,
    ).toBe(0);
  });
});
