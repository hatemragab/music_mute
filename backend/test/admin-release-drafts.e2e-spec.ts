import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';
import { AdminReleasesController } from '../src/releases/admin-releases.controller.js';
import { ReleaseDraftsService } from '../src/releases/release-drafts.service.js';
import { ReleasePublicationService } from '../src/releases/release-publication.service.js';

describe('release administration HTTP admission', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  async function setup() {
    const drafts = {
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      proposal: vi.fn(async () => ({
        platform: 'android',
        source: 'direct_apk',
        current: { versionName: '0.1.0', buildNumber: 1 },
        suggested: { versionName: '0.1.1', buildNumber: 2 },
      })),
      create: vi.fn(async () => ({ id: 'fixture', state: 'draft' })),
    };
    harness = await createAdminHarness({
      controllers: [AdminReleasesController],
      providers: [
        { provide: ReleaseDraftsService, useValue: drafts },
        { provide: ReleasePublicationService, useValue: {} },
      ],
    });
    return drafts;
  }
  const body = {
    platform: 'android',
    source: 'direct_apk',
    versionName: '1',
    buildNumber: 1,
    changelogEn: 'Initial',
    storeUrl: null,
    operationId: '97cb8747-2823-43e0-b333-66ab50ff751b',
    reason: 'Initial release',
  };
  it('denies anonymous and support reads before accessing release data', async () => {
    const drafts = await setup();
    await harness.request('get', '/admin/releases').expect(401);
    await harness
      .request('get', '/admin/releases', undefined, harness.signInAs('support'))
      .expect(403);
    expect(drafts.list).not.toHaveBeenCalled();
  });
  it('permits release managers and rejects malformed drafts before writes', async () => {
    const drafts = await setup(),
      token = harness.signInAs('release_manager');
    await harness
      .request('post', '/admin/releases', { ...body, buildNumber: 0 }, token)
      .expect(400);
    await harness
      .request(
        'post',
        '/admin/releases',
        { ...body, state: 'published' },
        token,
      )
      .expect(400);
    expect(drafts.create).not.toHaveBeenCalled();
    const response = await harness
      .request('post', '/admin/releases', body, token)
      .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.state).toBe('draft');
  });
  it('returns the trusted proposal for a compatible release channel', async () => {
    const drafts = await setup();
    const response = await harness
      .request(
        'get',
        '/admin/releases/proposal?platform=android&source=direct_apk',
        undefined,
        harness.signInAs('release_manager'),
      )
      .expect(200);
    expect(response.body).toEqual({
      platform: 'android',
      source: 'direct_apk',
      current: { versionName: '0.1.0', buildNumber: 1 },
      suggested: { versionName: '0.1.1', buildNumber: 2 },
    });
    expect(drafts.proposal).toHaveBeenCalledWith({
      platform: 'android',
      source: 'direct_apk',
    });
  });
});
