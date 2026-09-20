import request from 'supertest';
import { request as nativeRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authFixture, deviceReport } from './helpers/auth-fixtures.js';

describe('Firebase account API composition', () => {
  let f: Awaited<ReturnType<typeof authFixture>>;
  beforeEach(async () => {
    f = await authFixture();
  });
  afterEach(async () => {
    await f?.app.close();
  });
  const token = 'Bearer fixture-owner-token';
  it('rejects real duplicate Authorization headers before checking the token', async () => {
    await f.app.listen(0, '127.0.0.1');
    const address = f.app.getHttpServer().address() as AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = nativeRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/api/v1/users/me',
          headers: [
            'Host',
            `127.0.0.1:${address.port}`,
            'Authorization',
            token,
            'Authorization',
            'Bearer fixture-other-token',
          ],
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(401);
    expect(f.firebase.verifySignature).not.toHaveBeenCalled();
  });
  it('orders real APP_GUARD execution and blocks IP abuse before Firebase', async () => {
    await request(f.app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', token)
      .expect(200);
    expect(f.events.slice(0, 6)).toEqual([
      'ip-limit',
      'ip-limit',
      'signature',
      'uid-budget',
      'revocation',
      'local-user',
    ]);
    f.events.length = 0;
    f.state.ipDenied = true;
    await request(f.app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', token)
      .expect(429);
    expect(f.events).toEqual(['ip-limit']);
  });
  it('returns stable unauthenticated and unprovisioned errors', async () => {
    const missing = await request(f.app.getHttpServer())
      .get('/api/v1/users/me')
      .expect(401);
    expect(missing.body.code).toBe('UNAUTHENTICATED');
    const fresh = await request(f.app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer fixture-new-token')
      .expect(409);
    expect(fresh.body.code).toBe('PROFILE_SYNC_REQUIRED');
  });
  it('rejects mass assignment before provisioning and safely retries a bootstrap', async () => {
    const bad = await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', token)
      .send({ ...deviceReport, userId: 'other', emailVerified: true })
      .expect(400);
    expect(bad.body.code).toBe('INVALID_INPUT');
    expect(f.users.provision).not.toHaveBeenCalled();
    const first = await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer fixture-new-token')
      .send(deviceReport)
      .expect(200);
    const second = await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer fixture-new-token')
      .send(deviceReport)
      .expect(200);
    expect(first.body.user.id).toBe(second.body.user.id);
    expect(first.body.user.firebaseUid).toBeUndefined();
    expect(first.body.access).toEqual({ allowed: true });
    expect(f.mail.sendVerification).not.toHaveBeenCalled();
  });
  it('returns failure on device write failure and completes safely on retry', async () => {
    f.devices.sync.mockRejectedValueOnce(new Error('fixture DB failure'));
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer fixture-new-token')
      .send(deviceReport)
      .expect(500);
    const id = f.records.get('fixture-new')!._id.toString();
    const response = await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer fixture-new-token')
      .send(deviceReport)
      .expect(200);
    expect(response.body.user.id).toBe(id);
  });
  it('uses owned stored devices and current token verification for processing, while recovery stays available', async () => {
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', token)
      .send(deviceReport)
      .expect(200);
    f.state.policy.requireVerifiedEmail = true;
    const blocked = await request(f.app.getHttpServer())
      .get('/api/v1/processing-probe')
      .set('Authorization', token)
      .set('X-Installation-Id', deviceReport.installationId)
      .expect(403);
    expect(blocked.body.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    await request(f.app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', token)
      .expect(200);
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/profile-sync')
      .set('Authorization', token)
      .send({})
      .expect(200);
    await request(f.app.getHttpServer()).get('/api/v1/app-policy').expect(200);
    f.state.emailVerified = true;
    await request(f.app.getHttpServer())
      .get('/api/v1/processing-probe')
      .set('Authorization', token)
      .set('X-Installation-Id', deviceReport.installationId)
      .expect(200);
    f.state.policy.platforms.android = {
      minimumBuild: 2,
      latestBuild: 2,
      downloadUrl: 'https://example.invalid/app',
    };
    const outdated = await request(f.app.getHttpServer())
      .get('/api/v1/processing-probe')
      .set('Authorization', token)
      .set('X-Installation-Id', deviceReport.installationId)
      .expect(403);
    expect(outdated.body.code).toBe('APP_UPDATE_REQUIRED');
    await request(f.app.getHttpServer())
      .get('/api/v1/users/me/devices')
      .set('Authorization', token)
      .expect(200);
    const { installationId, ...metadata } = deviceReport;
    await request(f.app.getHttpServer())
      .put(`/api/v1/users/me/devices/${installationId}`)
      .set('Authorization', token)
      .send({ ...metadata, metadataRevision: 2 })
      .expect(200);
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/profile-sync')
      .set('Authorization', token)
      .send({})
      .expect(200);
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/verification-email')
      .set('Authorization', token)
      .send({})
      .expect(200);
    await request(f.app.getHttpServer())
      .get('/api/v1/processing-probe')
      .set('Authorization', 'Bearer fixture-other-token')
      .set('X-Installation-Id', deviceReport.installationId)
      .expect(409);
    await request(f.app.getHttpServer())
      .get('/api/v1/processing-probe')
      .set('Authorization', token)
      .expect(409);
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/logout-all')
      .set('Authorization', token)
      .send({})
      .expect(204);
  });
  it('rejects body additions on account actions and disabled accounts', async () => {
    for (const action of ['profile-sync', 'verification-email', 'logout-all'])
      await request(f.app.getHttpServer())
        .post(`/api/v1/auth/${action}`)
        .set('Authorization', token)
        .send({ targetEmail: 'other@fixture.invalid' })
        .expect(400);
    expect(f.mail.sendVerification).not.toHaveBeenCalled();
    expect(f.firebase.revokeSessions).not.toHaveBeenCalled();
    f.records.get('fixture-owner')!.status = 'disabled';
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', token)
      .send(deviceReport)
      .expect(403);
  });
  it('admits only the dedicated recovery routes for a deleting account', async () => {
    const owner = f.records.get('fixture-owner')!;
    owner.status = 'deleting';
    owner.deletionRequestId = 'fixture-deletion-request';
    owner.deletionRequestedAt = new Date('2026-09-11T00:00:00.000Z');
    owner.deletionRecoverUntil = new Date('2026-09-26T00:00:00.000Z');

    const blocked = await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', token)
      .send(deviceReport)
      .expect(403);
    expect(blocked.body.code).toBe('ACCOUNT_DELETION_PENDING');
    await request(f.app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', token)
      .expect(403);

    const status = await request(f.app.getHttpServer())
      .get('/api/v1/users/me/account-recovery')
      .set('Authorization', token)
      .expect(200);
    expect(status.body.deletion.recoveryAvailable).toBe(true);
    const submitted = await request(f.app.getHttpServer())
      .post('/api/v1/users/me/account-recovery')
      .set('Authorization', token)
      .send({ reason: '  I changed my mind  ' })
      .expect(202);
    expect(submitted.body).toMatchObject({
      id: 'fixture-recovery-request',
      status: 'pending',
      reason: 'I changed my mind',
    });
    expect(f.recovery.request).toHaveBeenCalledWith(owner._id.toHexString(), {
      reason: 'I changed my mind',
    });

    await request(f.app.getHttpServer())
      .post('/api/v1/users/me/account-recovery')
      .set('Authorization', token)
      .send({ reason: 'valid', targetUid: 'fixture-other' })
      .expect(400);
    expect(f.recovery.request).toHaveBeenCalledTimes(1);
  });
  it('revokes sessions, rejects old auth_time, accepts a later sign-in, and preserves devices', async () => {
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/session')
      .set('Authorization', token)
      .send(deviceReport)
      .expect(200);
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/logout-all')
      .set('Authorization', token)
      .send({})
      .expect(204);
    expect(f.firebase.revokeSessions).toHaveBeenCalledWith('fixture-owner');
    expect(f.installations.size).toBe(1);
    await request(f.app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', token)
      .expect(401);
    f.state.authTimeSec = Math.floor(Date.now() / 1000) + 1;
    await request(f.app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', token)
      .expect(200);
  });
  it('keeps health public and liveness exempt from the shared IP limit', async () => {
    f.state.ipDenied = true;
    await request(f.app.getHttpServer()).get('/api/v1/health/live').expect(200);
    await request(f.app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(429);
  });
});
