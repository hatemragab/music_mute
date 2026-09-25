import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminSettingsController,
  ProcessingPolicyController,
} from '../src/admin-settings/admin-settings.controller.js';
import { AccountPolicyService } from '../src/admin-settings/account-policy.service.js';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from '../src/admin-settings/account-policy.schema.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('account policy HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());

  async function setup() {
    const value = {
      plan: 'standard',
      revision: 0,
      acceptNewJobs: true,
      maintenanceMessageEn: '',
      maintenanceMessageAr: null,
      values: DEFAULT_ACCOUNT_POLICY_VALUES,
      enforcedFeatures: ['processing_minutes'],
      updatedBy: 'system',
      updatedAt: new Date(0).toISOString(),
    };
    const policies = {
      current: vi.fn().mockResolvedValue(value),
      update: vi.fn().mockResolvedValue({ ...value, revision: 1 }),
      publicPolicy: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        revision: 0,
        acceptNewJobs: false,
        messageEn: '',
        messageAr: null,
        limits: {
          maxDurationSeconds: 1_200,
          maxPreparedAudioBytes: 50_000_000,
          maxProcessingJobs: 1,
        },
        checkedAt: new Date().toISOString(),
      }),
    };
    harness = await createAdminHarness({
      controllers: [AdminSettingsController, ProcessingPolicyController],
      providers: [{ provide: AccountPolicyService, useValue: policies }],
    });
    return { harness, policies };
  }

  const update = {
    acceptNewJobs: false,
    maintenanceMessageEn: 'Maintenance in progress',
    maintenanceMessageAr: null,
    ...DEFAULT_ACCOUNT_POLICY_VALUES,
    expectedRevision: 0,
    operationId: '33a50392-3c94-4e46-b5aa-c3ac84031280',
    reason: 'Planned maintenance',
  };

  it('allows public no-store policy reads without Firebase', async () => {
    const { harness } = await setup();
    const response = await harness
      .request('get', '/processing-policy?schema_version=2')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.accept_new_jobs).toBe(false);
    expect(response.body).not.toHaveProperty('updated_by');
    expect(response.body.limits.max_duration_seconds).toBe(1_200);
    expect(response.body.limits).not.toHaveProperty('allowance_audio_seconds');
    await harness
      .request('get', '/processing-policy?schemaVersion=2')
      .expect(400);
  });

  it('removes the old processing settings administrator routes', async () => {
    const { harness } = await setup();
    const token = harness.signInAs('owner');
    await harness
      .request('get', '/admin/settings/processing', undefined, token)
      .expect(404);
    await harness
      .request('put', '/admin/settings/processing', {}, token)
      .expect(404);
  });

  it('enforces settings permissions and fresh owner writes', async () => {
    const { harness, policies } = await setup();
    await harness.request('get', '/admin/settings/account-policy').expect(401);
    await harness
      .request(
        'get',
        '/admin/settings/account-policy',
        undefined,
        harness.signInAs('viewer'),
      )
      .expect(200);
    await harness
      .request(
        'put',
        '/admin/settings/account-policy',
        wireJson(update),
        harness.signInAs('support'),
      )
      .expect(403);
    await harness
      .request(
        'put',
        '/admin/settings/account-policy',
        wireJson(update),
        harness.signInAs('owner'),
      )
      .expect(200);
    expect(policies.update).toHaveBeenCalledOnce();
  });

  it('rejects incomplete, unsafe, and closed-without-message policy writes', async () => {
    const { harness, policies } = await setup();
    const token = harness.signInAs('owner');
    await harness
      .request(
        'put',
        '/admin/settings/account-policy',
        wireJson({ ...update, signedUrlTtlSeconds: 601 }),
        token,
      )
      .expect(400);
    await harness
      .request(
        'put',
        '/admin/settings/account-policy',
        wireJson({ ...update, maintenanceMessageEn: '   ' }),
        token,
      )
      .expect(400);
    const { reason: _reason, ...missing } = update;
    await harness
      .request(
        'put',
        '/admin/settings/account-policy',
        wireJson(missing),
        token,
      )
      .expect(400);
    expect(policies.update).not.toHaveBeenCalled();
  });
});
