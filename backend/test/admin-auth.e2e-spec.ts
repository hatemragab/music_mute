import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

describe('administrator HTTP admission', () => {
  let f: AdminHarness;
  beforeAll(async () => {
    f = await createAdminHarness();
  });
  afterAll(async () => {
    await f.close();
  });

  it('admits an allowlisted Google owner without a mobile profile', async () => {
    const token = f.signInAs('owner');
    const response = await f
      .request('get', '/admin/session', undefined, token)
      .expect(200);
    expect(response.body).toMatchObject({
      uid: 'owner-uid',
      verifiedEmail: 'owner@example.com',
      role: 'owner',
      accessRevision: 0,
    });
    expect(response.body.permissions).toContain('admin.access.manage');
    expect(response.body.serverTime).toMatch(/Z$/);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['anonymous', undefined, 401],
    ['ordinary Google user', 'ordinary-google-token', 403],
    ['worker credential', 'fixture-worker-secret-with-at-least-32-bytes', 401],
    ['password provider', 'password-token', 403],
    ['disabled Google identity', 'disabled-token', 403],
    ['revoked Google identity', 'revoked-token', 401],
  ])('rejects %s without protected data', async (_label, token, status) => {
    const response = await f
      .request('get', '/admin/session', undefined, token)
      .expect(status);
    expect(response.body).not.toHaveProperty('permissions');
    expect(JSON.stringify(response.body)).not.toContain('owner@example.com');
  });

  it('uses the bounded admin error envelope when authentication fails early', async () => {
    const requestId = '4ebdccd5-79e0-4f41-94d8-11fc6c4070cb';
    const response = await f
      .request('get', '/admin/session')
      .set('X-Request-Id', requestId)
      .expect(401);
    expect(response.body).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
      requestId,
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('sanitizes malformed and oversized JSON before an admin controller runs', async () => {
    const malformed = await f
      .request('post', '/admin/test/fresh')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
    expect(malformed.body).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Invalid request',
      requestId: expect.any(String),
    });

    const oversized = await f
      .request('post', '/admin/test/fresh')
      .send({ payload: 'x'.repeat(110_000) })
      .expect(413);
    expect(oversized.body).toMatchObject({
      code: 'UPLOAD_TOO_LARGE',
      message: 'Upload too large',
      requestId: expect.any(String),
    });
  });

  it('reads current access on every request', async () => {
    const token = f.signInAs('viewer');
    await f
      .request('get', '/admin/test/protected', undefined, token)
      .expect(200);
    f.access.delete('owner-uid');
    const denied = await f
      .request('get', '/admin/test/protected', undefined, token)
      .expect(403);
    expect(denied.body.code).toBe('ADMIN_ACCESS_DENIED');
  });

  it('requires authentication no older than 300 seconds on fresh routes', async () => {
    const token = f.signInAs('owner');
    f.identities.get(token)!.authTimeSec = Math.floor(Date.now() / 1000) - 301;
    const denied = await f
      .request('post', '/admin/test/fresh', {}, token)
      .expect(403);
    expect(denied.body.code).toBe('ADMIN_REAUTH_REQUIRED');
  });
});
