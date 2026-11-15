import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminSettingsController,
  ProcessingPolicyController,
} from '../src/admin-settings/admin-settings.controller.js';
import { AccountPolicyService } from '../src/admin-settings/account-policy.service.js';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from '../src/admin-settings/account-policy.schema.js';
import { UsersService } from '../src/users/users.service.js';
import { Types } from 'mongoose';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('account policy HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());

  async function setup() {
    const owner = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
      status: 'active',
      sessionsRevokedAfterSec: 0,
    };
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
      providers: [
        { provide: AccountPolicyService, useValue: policies },
        {
          provide: UsersService,
          useValue: { findByFirebaseUid: async () => owner },
        },
      ],
    });
    return { harness, policies, owner };
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

  it('accepts scalar media capability and rejects duplicate or unknown query fields', async () => {
    const { harness, policies } = await setup();
    await harness
      .request(
        'get',
        '/processing-policy?schema_version=2&media_limits_version=2',
      )
      .expect(200);
    expect(policies.publicPolicy).toHaveBeenCalledWith('2', '2', null, null);
    await harness
      .request(
        'get',
        '/processing-policy?media_limits_version=2&media_limits_version=2',
      )
      .expect(409);
    await harness.request('get', '/processing-policy?unknown=2').expect(409);
  });

  it('uses Cloudflare country from this public request and rejects client country input', async () => {
    const { harness, policies } = await setup();
    await harness
      .request('get', '/processing-policy?schema_version=2')
      .set('CF-IPCountry', 'EG')
      .expect(200);
    expect(policies.publicPolicy).toHaveBeenLastCalledWith(
      '2',
      undefined,
      'EG',
      null,
    );
    for (const country of ['XX', 'T1', 'ZZ', '']) {
      await harness
        .request('get', '/processing-policy')
        .set('CF-IPCountry', country)
        .expect(200);
      expect(policies.publicPolicy).toHaveBeenLastCalledWith(
        undefined,
        undefined,
        null,
        null,
      );
    }
    await harness
      .request('get', '/processing-policy?visitor_country=US')
      .set('CF-IPCountry', 'EG')
      .expect(409);
  });

  it('uses only the verified bearer account for policy checkout and keeps guest access', async () => {
    const { harness, policies, owner } = await setup();
    await harness
      .request(
        'get',
        '/processing-policy?schema_version=2',
        undefined,
        'ordinary-google-token',
      )
      .set('CF-IPCountry', 'EG')
      .expect(200);
    expect(policies.publicPolicy).toHaveBeenLastCalledWith(
      '2',
      undefined,
      'EG',
      owner._id.toHexString(),
    );
    await harness
      .request(
        'get',
        '/processing-policy?user_id=507f1f77bcf86cd799439012',
        undefined,
        'ordinary-google-token',
      )
      .expect(409);
    policies.publicPolicy.mockClear();
    for (const token of ['unknown-token', 'revoked-token', 'disabled-token'])
      await harness
        .request('get', '/processing-policy', undefined, token)
        .expect(token === 'disabled-token' ? 403 : 401);
    await harness
      .request('get', '/processing-policy')
      .set('Authorization', 'Basic fixture')
      .expect(401);
    owner.status = 'disabled';
    await harness
      .request('get', '/processing-policy', undefined, 'ordinary-google-token')
      .expect(403);
    expect(policies.publicPolicy).not.toHaveBeenCalled();
    await harness.request('get', '/processing-policy').expect(200);
    expect(policies.publicPolicy).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      null,
      null,
    );
  });

  it('validates native visibility and country values using existing write permissions', async () => {
    const { harness, policies } = await setup();
    const token = harness.signInAs('owner');
    await harness
      .request(
        'put',
        '/admin/settings/account-policy',
        wireJson({
          ...update,
          linkImportEnabled: true,
          linkImportDisabledCountries: ['US', 'EG'],
          linkImportDisabledUserIds: ['507f1f77bcf86cd799439011'],
        }),
        token,
      )
      .expect(200);
    expect(policies.update).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        linkImportEnabled: true,
        linkImportDisabledCountries: ['US', 'EG'],
        linkImportDisabledUserIds: ['507f1f77bcf86cd799439011'],
      }),
    );
    policies.update.mockClear();
    for (const extra of [
      { linkImportEnabled: 'true' },
      { linkImportEnabled: null },
      { linkImportDisabledCountries: ['XX'] },
      { linkImportDisabledCountries: ['T1'] },
      { linkImportDisabledCountries: ['ZZ'] },
      { linkImportDisabledCountries: ['eg'] },
      { linkImportDisabledCountries: ['EG', 'EG'] },
      { linkImportDisabledCountries: null },
      { linkImportDisabledUserIds: null },
      { linkImportDisabledUserIds: ['not-an-account'] },
      { linkImportDisabledUserIds: ['507f1f77bcf86cd799439011\n'] },
      { linkImportDisabledUserIds: ['507F1F77BCF86CD799439011'] },
      {
        linkImportDisabledUserIds: [
          '507f1f77bcf86cd799439011',
          '507f1f77bcf86cd799439011',
        ],
      },
      {
        linkImportDisabledUserIds: Array.from({ length: 1001 }, (_, i) =>
          i.toString(16).padStart(24, '0'),
        ),
      },
    ])
      await harness
        .request(
          'put',
          '/admin/settings/account-policy',
          wireJson({ ...update, ...extra }),
          token,
        )
        .expect(400);
    expect(policies.update).not.toHaveBeenCalled();
    await harness
      .request(
        'put',
        '/admin/settings/account-policy',
        wireJson({
          ...update,
          linkImportEnabled: false,
          linkImportDisabledCountries: [],
        }),
        harness.signInAs('viewer'),
      )
      .expect(403);
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
