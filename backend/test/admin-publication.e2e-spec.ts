import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';
import { AdminReleasesController } from '../src/releases/admin-releases.controller.js';
import { AdminUpdatePolicyController } from '../src/releases/admin-update-policy.controller.js';
import { ReleaseDraftsService } from '../src/releases/release-drafts.service.js';
import { ReleasePublicationService } from '../src/releases/release-publication.service.js';
describe('publication HTTP authorization', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  it('requires current release permission and fresh authentication for publication', async () => {
    const publication = {
      mutate: vi.fn(async () => ({ policyRevision: 1 })),
      preview: vi.fn(async () => ({ valid: true })),
      current: vi.fn(async () => ({ revision: 0 })),
    };
    harness = await createAdminHarness({
      controllers: [AdminReleasesController, AdminUpdatePolicyController],
      providers: [
        { provide: ReleaseDraftsService, useValue: {} },
        { provide: ReleasePublicationService, useValue: publication },
      ],
    });
    const path = `/admin/releases/${'a'.repeat(24)}/publications`;
    await harness.request('post', path, {}).expect(401);
    await harness
      .request('post', path, {}, harness.signInAs('viewer'))
      .expect(403);
    const token = harness.signInAs('release_manager');
    harness.identities.get(token)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 600;
    const stale = await harness.request('post', path, {}, token).expect(403);
    expect(stale.body.code).toBe('ADMIN_REAUTH_REQUIRED');
    expect(publication.mutate).not.toHaveBeenCalled();
    await harness
      .request('post', '/admin/update-policy/previews', {}, token)
      .expect(201);
    harness.identities.get(token)!.authTimeSec = Math.floor(Date.now() / 1000);
    await harness.request('post', path, {}, token).expect(201);
    expect(publication.mutate).toHaveBeenCalledOnce();
  });
});
