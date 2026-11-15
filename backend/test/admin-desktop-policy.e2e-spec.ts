import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';
import { AdminUpdatePolicyController } from '../src/releases/admin-update-policy.controller.js';
import { ReleasePublicationService } from '../src/releases/release-publication.service.js';
import { DesktopUpdatePolicyService } from '../src/releases/desktop-policy.service.js';
import { parseDesktopUpdatePolicyPatch } from '../src/releases/desktop-policy.types.js';
describe('independent desktop gate HTTP authority and wire', () => {
  let h: AdminHarness;
  afterEach(async () => {
    await h?.close();
  });
  it('protects read/write/freshness and keeps normalized snake-case desktop fields separate from publishers', async () => {
    const desktop = {
      current: vi.fn(async () => ({
        revision: 2,
        windows: { minimumBuild: null },
        macos: { minimumBuild: 4 },
      })),
      update: vi.fn(async (_actor: unknown, raw: unknown) => {
        const b = parseDesktopUpdatePolicyPatch(raw);
        return {
          policy: {
            revision: 3,
            windows: b.platforms.windows,
            macos: { minimumBuild: 4 },
          },
          appliedRevision: 3,
          operationId: b.operationId,
          replayed: false,
        };
      }),
    };
    h = await createAdminHarness({
      controllers: [AdminUpdatePolicyController],
      providers: [
        { provide: ReleasePublicationService, useValue: {} },
        { provide: DesktopUpdatePolicyService, useValue: desktop },
      ],
    });
    const path = '/admin/update-policy/desktop',
      body = {
        expected_revision: 2,
        operation_id: randomUUID(),
        reason: 'Reviewed Windows build',
        platforms: { windows: { minimum_build: 8 } },
      };
    await h.request('get', path).expect(401);
    const read = await h
      .request('get', path, undefined, h.signInAs('viewer'))
      .expect(200);
    expect(read.body).toEqual({
      revision: 2,
      windows: { minimum_build: null },
      macos: { minimum_build: 4 },
    });
    expect(read.headers['cache-control']).toBe('no-store');
    await h.request('patch', path, body).expect(401);
    await h.request('patch', path, body, h.signInAs('viewer')).expect(403);
    const token = h.signInAs('release_manager');
    h.identities.get(token)!.authTimeSec = Math.floor(Date.now() / 1000) - 600;
    const stale = await h.request('patch', path, body, token).expect(403);
    expect(stale.body.code).toBe('ADMIN_REAUTH_REQUIRED');
    expect(desktop.update).not.toHaveBeenCalled();
    h.identities.get(token)!.authTimeSec = Math.floor(Date.now() / 1000);
    const response = await h.request('patch', path, body, token).expect(200);
    expect(response.body).toMatchObject({
      policy: { windows: { minimum_build: 8 }, macos: { minimum_build: 4 } },
      applied_revision: 3,
      operation_id: body.operation_id,
      replayed: false,
    });
    expect(desktop.update.mock.calls[0]![1]).toEqual({
      expectedRevision: 2,
      operationId: body.operation_id,
      reason: body.reason,
      platforms: { windows: { minimumBuild: 8 } },
    });
    await h
      .request(
        'patch',
        path,
        {
          ...body,
          platforms: {
            windows: { minimum_build: 8, url: 'https://untrusted.invalid' },
          },
        },
        token,
      )
      .expect(400);
  });
});
