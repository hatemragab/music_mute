import { ConfigService } from '@nestjs/config';
import { ProcessingAdmissionService } from './processing-admission.service.js';

describe('ProcessingAdmissionService', () => {
  afterEach(() => vi.useRealTimers());
  function fixture(overrides: Record<string, unknown> = {}) {
    const fences = {
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    };
    const users = {
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const count = vi.fn().mockResolvedValue(0);
    const jobs = { countDocuments: vi.fn(() => ({ session: count })) };
    const effective = vi.fn().mockResolvedValue({
      revision: 2,
      acceptNewJobs: true,
      maintenanceMessageEn: '',
      maintenanceMessageAr: null,
      maxInputBytesExclusive: 1000,
      maxDurationSecondsExclusive: 300,
      maxActiveJobsPerUser: 1,
      updatedAt: new Date(),
      ...overrides,
    });
    const settings = { touchGlobalFence: vi.fn(), effective };
    const service = new ProcessingAdmissionService(
      fences as never,
      users as never,
      jobs as never,
      settings as never,
      new ConfigService({
        AUDIO_PROCESSING_ENABLED: true,
        PROCESSING_URL_SECONDS: 900,
      }),
    );
    return {
      service,
      fences,
      users,
      jobs,
      count,
      settings,
    };
  }

  it('accepts values strictly below the captured ceilings', async () => {
    const { service } = fixture();
    await expect(
      service.assertNewWork(
        '507f1f77bcf86cd799439011',
        { bytes: 999, durationSeconds: 299.9 },
        {} as never,
      ),
    ).resolves.toMatchObject({
      settingsRevision: 2,
      maxInputBytesExclusive: 1000,
      maxDurationSecondsExclusive: 300,
      maxActiveJobsPerUser: 1,
    });
  });

  it.each([
    { bytes: 1000, durationSeconds: 10 },
    { bytes: 100, durationSeconds: 300 },
  ])('rejects the exclusive boundary %j', async (input) => {
    await expect(
      fixture().service.assertNewWork('user', input, {} as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('serializes and rejects a full per-user active quota', async () => {
    const { service, count, fences } = fixture();
    count.mockResolvedValue(1);
    await expect(
      service.assertNewWork(
        'user',
        { bytes: 100, durationSeconds: 10 },
        {} as never,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fences.updateOne).toHaveBeenCalledWith(
      { _id: 'user:user' },
      expect.anything(),
      expect.objectContaining({ session: expect.anything() }),
    );
  });

  it('excludes only the renewed reservation from a lowered active quota', async () => {
    const { service, count, jobs } = fixture();
    count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(
      service.assertNewWork(
        '507f1f77bcf86cd799439011',
        { bytes: 100, durationSeconds: 10 },
        {} as never,
        '507f1f77bcf86cd799439012',
      ),
    ).resolves.toBeDefined();
    await expect(
      service.assertNewWork(
        '507f1f77bcf86cd799439011',
        { bytes: 100, durationSeconds: 10 },
        {} as never,
        '507f1f77bcf86cd799439012',
      ),
    ).rejects.toMatchObject({ status: 409 });
    const filter = (
      jobs.countDocuments.mock.calls as unknown as [{ _id: { $ne: unknown } }][]
    )[0]![0];
    expect(filter._id.$ne).toBe('507f1f77bcf86cd799439012');
  });

  it('rejects maintenance and suspended accounts without counting jobs', async () => {
    const maintenance = fixture({ acceptNewJobs: false });
    await expect(
      maintenance.service.assertNewWork(
        'user',
        { bytes: 100, durationSeconds: 10 },
        {} as never,
      ),
    ).rejects.toMatchObject({ status: 503 });
    const suspended = fixture();
    suspended.users.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      suspended.service.assertNewWork(
        'user',
        { bytes: 100, durationSeconds: 10 },
        {} as never,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(suspended.jobs.countDocuments).not.toHaveBeenCalled();
  });

  it('applies immutable legacy ceilings and an inferred legacy expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:10:00Z'));
    const { service } = fixture();
    const legacy = {
      createdAt: new Date('2026-09-11T00:00:00Z'),
      admissionSnapshot: null,
      inputReservation: { bytes: 29_999_999, durationSeconds: 599.9 },
    };
    expect(service.assertAcceptedReservation(legacy as never)).toMatchObject({
      settingsRevision: 0,
      maxInputBytesExclusive: 30_000_000,
      maxDurationSecondsExclusive: 600,
    });
    vi.setSystemTime(new Date('2026-09-11T00:16:00Z'));
    expect(() => service.assertAcceptedReservation(legacy as never)).toThrow();
  });
});
