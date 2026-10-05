import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { authError } from '../src/auth/auth.errors.js';
import { importError } from '../src/url-imports/import-errors.js';
import { YOUTUBE_COMMUNITY_PROFILE_ID } from '../src/youtube-community/youtube-community.types.js';
import { authFixture } from './helpers/auth-fixtures.js';

describe('YouTube guest HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof authFixture>>;
  const token = 'g'.repeat(43);
  const id = '507f1f77bcf86cd799439011';
  const guest = {
    _id: id,
    expiresAt: new Date(Date.now() + 60_000),
    ipKey: 'fixture-ip',
  };
  const declaration = {
    extension: 'mp3',
    content_type: 'audio/mpeg',
    bytes: 4096,
    duration_seconds: 2,
    sha256: createHash('sha256').update('synthetic').digest('base64'),
  };
  const wire = () => ({
    request_id: randomUUID(),
    url: 'https://youtu.be/bZxrIoCPsOc?si=fixture',
    profile_id: YOUTUBE_COMMUNITY_PROFILE_ID,
  });
  beforeEach(async () => {
    f = await authFixture();
    f.community.authenticate.mockResolvedValue(guest);
  });
  afterEach(async () => {
    await f.app.close();
  });
  it('issues a no-store guest token without Firebase authentication and rejects unexpected input', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    f.community.issueSession.mockResolvedValue({ token, expiresAt });
    const response = await request(f.app.getHttpServer())
      .post('/youtube-guest-sessions')
      .send({})
      .expect(201);
    expect(response.body).toEqual({ token, expires_at: expiresAt });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.firebase.verifySession).not.toHaveBeenCalled();
    await request(f.app.getHttpServer())
      .post('/youtube-guest-sessions')
      .send({ user_id: id })
      .expect(400);
    expect(f.community.issueSession).toHaveBeenCalledOnce();
  });
  it.each(['', 'Bearer fixture-owner-token', `Bearer ${token}?`])(
    'requires a structurally valid guest bearer: %s',
    async (authorization) => {
      await request(f.app.getHttpServer())
        .post('/youtube-contributions')
        .set('Authorization', authorization)
        .send(wire())
        .expect(401);
      expect(f.community.authenticate).not.toHaveBeenCalled();
      expect(f.community.create).not.toHaveBeenCalled();
    },
  );
  it('validates the guest session separately from account access and converts wire names', async () => {
    const body = wire();
    f.community.create.mockResolvedValue({
      contributionId: id,
      requestId: body.request_id,
      videoId: 'bZxrIoCPsOc',
      state: 'preparing',
      producer: true,
    });
    const response = await request(f.app.getHttpServer())
      .post('/youtube-contributions')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    expect(response.body).toMatchObject({
      contribution_id: id,
      video_id: 'bZxrIoCPsOc',
      producer: true,
    });
    expect(f.community.authenticate).toHaveBeenCalledWith(
      token,
      expect.any(String),
    );
    expect(f.community.create).toHaveBeenCalledWith(
      guest,
      expect.objectContaining({
        requestId: body.request_id,
        profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
        url: body.url,
      }),
    );
    expect(f.firebase.verifySession).not.toHaveBeenCalled();
    for (const extra of [
      { user_id: id },
      { source_kind: 'file' },
      { profile_id: 'unknown-model' },
    ]) {
      await request(f.app.getHttpServer())
        .post('/youtube-contributions')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body, ...extra })
        .expect(400);
    }
    expect(f.community.create).toHaveBeenCalledOnce();
  });
  it('returns cache-miss problems without invoking contribution creation', async () => {
    f.community.delivery.mockRejectedValue(importError('IMPORT_CACHE_MISS'));
    const response = await request(f.app.getHttpServer())
      .post('/youtube-cache-deliveries')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: wire().url })
      .expect(404);
    expect(response.body.code).toBe('IMPORT_CACHE_MISS');
    expect(f.community.create).not.toHaveBeenCalled();
  });
  it('preserves signed R2 header names and rejects client-selected keys', async () => {
    const upload = {
      method: 'PUT',
      url: 'https://fixture.invalid/r2',
      headers: {
        'If-None-Match': '*',
        'Content-Type': 'audio/mpeg',
        'x-amz-checksum-sha256': declaration.sha256,
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    f.community.grants.mockResolvedValue({
      contributionId: id,
      uploadGrants: { original: upload, vocals: upload },
    });
    const body = {
      request_id: randomUUID(),
      original: declaration,
      vocals: declaration,
    };
    const response = await request(f.app.getHttpServer())
      .post(`/youtube-contributions/${id}/upload-grants`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(200);
    expect(response.body.upload_grants.original.headers).toEqual(
      upload.headers,
    );
    expect(f.community.grants).toHaveBeenCalledWith(
      guest,
      id,
      expect.objectContaining({
        original: expect.objectContaining({
          contentType: 'audio/mpeg',
          durationSeconds: 2,
        }),
      }),
    );
    await request(f.app.getHttpServer())
      .post(`/youtube-contributions/${id}/upload-grants`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...body, original: { ...declaration, key: 'shared/url/forged' } })
      .expect(400);
  });
  it.each(['source-deliveries', 'lease-renewals', 'completions', 'failures'])(
    'requires an empty %s command',
    async (suffix) => {
      const method =
        suffix === 'source-deliveries'
          ? 'sourceDelivery'
          : suffix === 'lease-renewals'
            ? 'renewLease'
            : suffix === 'completions'
              ? 'complete'
              : 'fail';
      f.community[method].mockResolvedValue({
        contributionId: id,
        state: 'ready',
      });
      await request(f.app.getHttpServer())
        .post(`/youtube-contributions/${id}/${suffix}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ etag: 'not-client-selected' })
        .expect(400);
      expect(f.community[method]).not.toHaveBeenCalled();
      await request(f.app.getHttpServer())
        .post(`/youtube-contributions/${id}/${suffix}`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);
      expect(f.community[method]).toHaveBeenCalledWith(guest, id);
    },
  );
  it('rejects expired guest sessions and cannot authenticate private file or job routes', async () => {
    f.community.authenticate.mockRejectedValue(authError('UNAUTHENTICATED'));
    await request(f.app.getHttpServer())
      .get(`/youtube-contributions/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(f.community.get).not.toHaveBeenCalled();
    await request(f.app.getHttpServer())
      .post('/local-media-syncs')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(401);
    await request(f.app.getHttpServer())
      .get('/jobs')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
