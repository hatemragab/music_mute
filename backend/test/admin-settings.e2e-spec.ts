import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminSettingsController,
  ProcessingPolicyController,
} from '../src/admin-settings/admin-settings.controller.js';
import { ProcessingSettingsService } from '../src/admin-settings/processing-settings.service.js';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

describe('processing settings HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());

  async function setup() {
    const value = {
      revision: 0,
      acceptNewJobs: true,
      maintenanceMessageEn: '',
      maintenanceMessageAr: null,
      maxInputBytesExclusive: 30_000_000,
      maxDurationSecondsExclusive: 600,
      maxActiveJobsPerUser: null,
      updatedAt: new Date(0).toISOString(),
    };
    const settings = {
      current: vi.fn().mockResolvedValue(value),
      update: vi.fn().mockResolvedValue({ ...value, revision: 1 }),
      publicPolicy: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        revision: 0,
        acceptNewJobs: true,
        messageEn: '',
        messageAr: null,
        limits: {
          maxInputBytesExclusive: 30_000_000,
          maxDurationSecondsExclusive: 600,
          maxActiveJobsPerUser: null,
        },
        checkedAt: new Date().toISOString(),
      }),
    };
    harness = await createAdminHarness({
      controllers: [AdminSettingsController, ProcessingPolicyController],
      providers: [{ provide: ProcessingSettingsService, useValue: settings }],
    });
    return { harness, settings };
  }

  const update = {
    acceptNewJobs: false,
    maintenanceMessageEn: 'Maintenance in progress',
    maintenanceMessageAr: null,
    maxInputBytesExclusive: 20_000_000,
    maxDurationSecondsExclusive: 300,
    maxActiveJobsPerUser: 1,
    expectedRevision: 0,
    operationId: '33a50392-3c94-4e46-b5aa-c3ac84031280',
    reason: 'Planned maintenance',
  };

  it('allows public no-store policy reads without Firebase', async () => {
    const { harness } = await setup();
    const response = await harness
      .request('get', '/processing-policy')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toHaveProperty('updatedBy');
    expect(response.body.limits.maxActiveJobsPerUser).toBeNull();
  });

  it('enforces settings permissions and fresh owner writes', async () => {
    const { harness, settings } = await setup();
    await harness.request('get', '/admin/settings/processing').expect(401);
    await harness
      .request(
        'get',
        '/admin/settings/processing',
        undefined,
        harness.signInAs('viewer'),
      )
      .expect(200);
    await harness
      .request(
        'put',
        '/admin/settings/processing',
        update,
        harness.signInAs('support'),
      )
      .expect(403);
    await harness
      .request(
        'put',
        '/admin/settings/processing',
        update,
        harness.signInAs('owner'),
      )
      .expect(200);
    expect(settings.update).toHaveBeenCalledOnce();
  });

  it('rejects incomplete, over-ceiling, and closed-without-message settings', async () => {
    const { harness, settings } = await setup();
    const token = harness.signInAs('owner');
    await harness
      .request(
        'put',
        '/admin/settings/processing',
        { ...update, maxInputBytesExclusive: 30_000_001 },
        token,
      )
      .expect(400);
    await harness
      .request(
        'put',
        '/admin/settings/processing',
        { ...update, maintenanceMessageEn: '   ' },
        token,
      )
      .expect(400);
    const { reason: _reason, ...missing } = update;
    await harness
      .request('put', '/admin/settings/processing', missing, token)
      .expect(400);
    expect(settings.update).not.toHaveBeenCalled();
  });
});
