import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { LocalMediaSyncsService } from '../src/local-media-syncs/local-media-syncs.service.js';
import {
  LOCAL_MEDIA_PROFILE_ID,
  type LocalMediaSyncView,
} from '../src/local-media-syncs/local-media-sync.dto.js';
import { authFixture } from './helpers/auth-fixtures.js';
const id = '012345678901234567890123';
const artifact = {
  extension: 'mp3',
  content_type: 'audio/mpeg',
  bytes: 1234,
  duration_seconds: 1,
  sha256: createHash('sha256').update('synthetic').digest('base64'),
};
const wire = () => ({
  request_id: randomUUID(),
  profile_id: LOCAL_MEDIA_PROFILE_ID,
  source_kind: 'file',
  original: artifact,
  vocals: artifact,
});
const receipt: LocalMediaSyncView = {
  syncId: id,
  jobId: id,
  requestId: randomUUID(),
  status: 'awaiting_upload' as const,
  profileId: LOCAL_MEDIA_PROFILE_ID,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  committed: false,
  revision: 0,
  uploadGrants: {
    original: {
      method: 'PUT' as const,
      url: 'https://fixture.invalid/original',
      headers: { 'If-None-Match': '*', 'Content-Type': 'audio/mpeg' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    vocals: {
      method: 'PUT' as const,
      url: 'https://fixture.invalid/vocals',
      headers: { 'If-None-Match': '*', 'Content-Type': 'audio/mpeg' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  },
};
it('requires an active authenticated owner, converts snake_case and preserves signed header names while cloud processing is paused', async () => {
  const fixture = await authFixture();
  try {
    const create = vi
      .spyOn(fixture.app.get(LocalMediaSyncsService), 'create')
      .mockResolvedValue(receipt);
    await request(fixture.app.getHttpServer())
      .post('/local-media-syncs')
      .send(wire())
      .expect(401);
    expect(create).not.toHaveBeenCalled();
    const response = await request(fixture.app.getHttpServer())
      .post('/local-media-syncs')
      .set('Authorization', 'Bearer fixture-owner-token')
      .send(wire())
      .expect(201);
    expect(create).toHaveBeenCalledWith(
      String(fixture.ownerId),
      expect.objectContaining({
        sourceKind: 'file',
        original: expect.objectContaining({ contentType: 'audio/mpeg' }),
      }),
      100,
    );
    expect(response.body).toMatchObject({
      sync_id: id,
      job_id: id,
      committed: false,
      profile_id: LOCAL_MEDIA_PROFILE_ID,
      upload_grants: {
        original: {
          headers: { 'If-None-Match': '*', 'Content-Type': 'audio/mpeg' },
        },
      },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    await request(fixture.app.getHttpServer())
      .post('/local-media-syncs')
      .set('Authorization', 'Bearer fixture-owner-token')
      .send({ ...wire(), user_id: id })
      .expect(400);
    fixture.records.get('fixture-owner')!.status = 'deleting';
    await request(fixture.app.getHttpServer())
      .post('/local-media-syncs')
      .set('Authorization', 'Bearer fixture-owner-token')
      .send(wire())
      .expect(403);
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    await fixture.app.close();
  }
});
it('completion accepts only an empty body and re-verifies the Firebase session after validation', async () => {
  const fixture = await authFixture();
  try {
    const complete = vi
      .spyOn(fixture.app.get(LocalMediaSyncsService), 'complete')
      .mockImplementation(async (_owner, _id, _authTime, authorize) => {
        await authorize();
        return {
          ...receipt,
          status: 'ready',
          committed: true,
          uploadGrants: null,
        };
      });
    await request(fixture.app.getHttpServer())
      .post(`/local-media-syncs/${id}/completions`)
      .set('Authorization', 'Bearer fixture-owner-token')
      .send({ etag: 'client-cannot-choose-objects' })
      .expect(400);
    expect(complete).not.toHaveBeenCalled();
    fixture.firebase.verifySession.mockClear();
    const response = await request(fixture.app.getHttpServer())
      .post(`/local-media-syncs/${id}/completions`)
      .set('Authorization', 'Bearer fixture-owner-token')
      .send({})
      .expect(200);
    expect(fixture.firebase.verifySession).toHaveBeenCalledTimes(2);
    expect(response.body).toMatchObject({
      committed: true,
      status: 'ready',
      upload_grants: null,
    });
  } finally {
    await fixture.app.close();
  }
});
