import { model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_PROCESSING_SETTINGS,
  ProcessingSettingsSchema,
} from './processing-settings.schema.js';
import {
  ProcessingSettingsService,
  validateProcessingSettings,
} from './processing-settings.service.js';

describe('processing settings', () => {
  it('preserves legacy admission limits without inserting defaults', async () => {
    const findById = vi.fn(() => ({ lean: vi.fn().mockResolvedValue(null) }));
    const service = new ProcessingSettingsService(
      { findById } as never,
      {} as never,
      {} as never,
      new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
    );
    await expect(service.current()).resolves.toMatchObject({
      revision: 0,
      ...DEFAULT_PROCESSING_SETTINGS,
    });
    expect(findById).toHaveBeenCalledOnce();
  });

  it('publishes admission availability only when settings and the feature gate allow it', async () => {
    const findById = vi.fn(() => ({ lean: vi.fn().mockResolvedValue(null) }));
    const disabled = new ProcessingSettingsService(
      { findById } as never,
      {} as never,
      {} as never,
      new ConfigService({ AUDIO_PROCESSING_ENABLED: false }),
    );
    const enabled = new ProcessingSettingsService(
      { findById } as never,
      {} as never,
      {} as never,
      new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
    );
    await expect(disabled.publicPolicy()).resolves.toMatchObject({
      acceptNewJobs: false,
    });
    await expect(enabled.publicPolicy()).resolves.toMatchObject({
      acceptNewJobs: true,
    });
  });

  it('validates exclusive ceilings, optional Arabic, and maintenance text', () => {
    const valid = { ...DEFAULT_PROCESSING_SETTINGS };
    expect(() => validateProcessingSettings(valid)).not.toThrow();
    expect(() =>
      validateProcessingSettings({
        ...valid,
        maxInputBytesExclusive: 30_000_001,
      }),
    ).toThrow();
    expect(() =>
      validateProcessingSettings({
        ...valid,
        maxDurationSecondsExclusive: 600.1,
      }),
    ).toThrow();
    expect(() =>
      validateProcessingSettings({ ...valid, maxActiveJobsPerUser: 1 }),
    ).not.toThrow();
    expect(() =>
      validateProcessingSettings({
        ...valid,
        maxActiveJobsPerUser: null,
        maintenanceMessageAr: null,
      }),
    ).not.toThrow();
    expect(() =>
      validateProcessingSettings({
        ...valid,
        acceptNewJobs: false,
        maintenanceMessageEn: '',
      }),
    ).toThrow();
  });

  it('updates by expected revision through the audited operation transaction', async () => {
    const stored = {
      _id: 'processing',
      revision: 2,
      ...DEFAULT_PROCESSING_SETTINGS,
      updatedAt: new Date('2026-09-11T00:00:00Z'),
    };
    const updated = {
      ...stored,
      revision: 3,
      acceptNewJobs: false,
      maintenanceMessageEn: 'Maintenance',
      updatedAt: new Date('2026-09-11T00:01:00Z'),
    };
    const findById = vi.fn(() => ({
      session: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(stored),
    }));
    const findOneAndUpdate = vi.fn(() => ({
      lean: vi.fn().mockResolvedValue(updated),
    }));
    const fences = {
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    };
    const operations = {
      run: vi.fn(async (_actor, command, mutate) => ({
        value: (await mutate({})).value,
        receipt: {},
        replayed: false,
        command,
      })),
    };
    const service = new ProcessingSettingsService(
      { findById, findOneAndUpdate } as never,
      fences as never,
      operations as never,
      new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
    );
    await expect(
      service.update({ uid: 'owner' } as never, {
        acceptNewJobs: false,
        maintenanceMessageEn: 'Maintenance',
        maintenanceMessageAr: null,
        maxInputBytesExclusive: 30_000_000,
        maxDurationSecondsExclusive: 600,
        maxActiveJobsPerUser: null,
        expectedRevision: 2,
        operationId: 'e5add2a7-366d-4845-9cde-046f582a436d',
        reason: 'Planned maintenance',
      }),
    ).resolves.toMatchObject({ revision: 3, acceptNewJobs: false });
    expect(fences.updateOne).toHaveBeenCalledWith(
      { _id: 'settings' },
      expect.anything(),
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(operations.run.mock.calls[0]?.[1]).toMatchObject({
      action: 'settings.processing.update',
      reason: 'Planned maintenance',
    });
  });

  it('presents an initial hydrated settings document as an allowlisted response', async () => {
    const Settings = model(
      `InitialSettings${Date.now()}`,
      ProcessingSettingsSchema,
    );
    const created = new Settings({
      _id: 'processing',
      revision: 1,
      ...DEFAULT_PROCESSING_SETTINGS,
      updatedAt: new Date('2026-09-11T00:00:00Z'),
    });
    const operations = {
      run: vi.fn(async (_actor, _command, mutate) => ({
        value: (await mutate({})).value,
        receipt: {},
        replayed: false,
      })),
    };
    const service = new ProcessingSettingsService(
      {
        findById: vi.fn(() => ({
          session: vi.fn().mockReturnThis(),
          lean: vi.fn().mockResolvedValue(null),
        })),
        create: vi.fn().mockResolvedValue([created]),
      } as never,
      { updateOne: vi.fn().mockResolvedValue({ acknowledged: true }) } as never,
      operations as never,
      new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
    );
    const response = await service.update({ uid: 'owner' } as never, {
      ...DEFAULT_PROCESSING_SETTINGS,
      expectedRevision: 0,
      operationId: '33a50392-3c94-4e46-b5aa-c3ac84031280',
      reason: 'Initialize settings',
    });
    expect(response).toEqual({
      revision: 1,
      ...DEFAULT_PROCESSING_SETTINGS,
      updatedAt: '2026-09-11T00:00:00.000Z',
    });
    expect(response).not.toHaveProperty('$__');
    expect(response).not.toHaveProperty('_doc');
  });
});
