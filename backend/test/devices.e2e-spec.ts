import request from 'supertest';
import { authFixture, deviceReport } from './helpers/auth-fixtures.js';

describe('owned installation HTTP boundaries', () => {
  let f: Awaited<ReturnType<typeof authFixture>>;
  beforeEach(async () => {
    f = await authFixture();
  });
  afterEach(async () => {
    await f?.app.close();
  });
  const token = 'Bearer fixture-owner-token';
  it('scopes reports and lists to the verified user and hides internal IDs', async () => {
    const { installationId, ...metadata } = deviceReport;
    const path = `/api/v1/users/me/devices/${installationId}`;
    const result = await request(f.app.getHttpServer())
      .put(path)
      .set('Authorization', token)
      .send(metadata)
      .expect(200);
    expect(result.body.userId).toBeUndefined();
    expect(result.body.lastAuthenticatedAtSec).toBeUndefined();
    expect(f.devices.sync).toHaveBeenCalledWith(
      f.ownerId.toString(),
      100,
      deviceReport,
    );
    const own = await request(f.app.getHttpServer())
      .get('/api/v1/users/me/devices?limit=1')
      .set('Authorization', token)
      .expect(200);
    expect(own.body.items).toHaveLength(1);
    expect(own.body.items[0].sessionStatus).toBe('unknown');
    expect(own.body.items[0].historyHiddenAt).toBeUndefined();
    const other = await request(f.app.getHttpServer())
      .get('/api/v1/users/me/devices')
      .set('Authorization', 'Bearer fixture-other-token')
      .expect(200);
    expect(other.body.items).toEqual([]);
  });
  it('validates and authenticates history removal and always uses the verified owner', async () => {
    const path = `/api/v1/users/me/devices/${deviceReport.installationId}`;
    await request(f.app.getHttpServer()).delete(path).expect(401);
    await request(f.app.getHttpServer())
      .delete('/api/v1/users/me/devices/invalid')
      .set('Authorization', token)
      .expect(400);
    await request(f.app.getHttpServer())
      .delete(path)
      .set('Authorization', token)
      .send({ userId: f.otherId.toString() })
      .expect(400);
    expect(f.devices.hideFromHistory).not.toHaveBeenCalled();
    await request(f.app.getHttpServer())
      .delete(path)
      .set('Authorization', token)
      .expect(204);
    expect(f.devices.hideFromHistory).toHaveBeenCalledWith(
      f.ownerId.toString(),
      deviceReport.installationId,
    );
  });
  it('rejects cursor, bounds, path/body disagreement and forged owners before writes', async () => {
    const { installationId, ...metadata } = deviceReport;
    for (const query of [
      'limit=51',
      'limit=0',
      'limit=1.5',
      'before=invalid',
      'cursor=012345678901234567890123',
    ])
      await request(f.app.getHttpServer())
        .get(`/api/v1/users/me/devices?${query}`)
        .set('Authorization', token)
        .expect(400);
    await request(f.app.getHttpServer())
      .get('/api/v1/users/me/devices?before=012345678901234567890123&limit=50')
      .set('Authorization', token)
      .expect(200);
    await request(f.app.getHttpServer())
      .put(`/api/v1/users/me/devices/${installationId}`)
      .set('Authorization', token)
      .send(deviceReport)
      .expect(400);
    await request(f.app.getHttpServer())
      .put('/api/v1/users/me/devices/not-a-uuid')
      .set('Authorization', token)
      .send(metadata)
      .expect(400);
    await request(f.app.getHttpServer())
      .put(`/api/v1/users/me/devices/${installationId}`)
      .set('Authorization', token)
      .send({ ...metadata, userId: f.otherId.toString() })
      .expect(400);
    expect(f.devices.sync).not.toHaveBeenCalled();
  });
});
