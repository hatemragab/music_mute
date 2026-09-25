import request from 'supertest';
import {
  authFixture,
  deviceReport,
  wireDeviceReport,
} from './helpers/auth-fixtures.js';

describe('URL import HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof authFixture>>;
  const id = '507f1f77bcf86cd799439011';
  const token = 'Bearer fixture-owner-token';
  const body = {
    url: 'https://youtu.be/abcdefghijk',
    request_id: 'f4331b35-4d8b-40a9-a101-1d2bd1bd76e9',
  };
  beforeEach(async () => {
    f = await authFixture();
  });
  afterEach(async () => {
    await f.app.close();
  });
  async function sync() {
    f.state.emailVerified = true;
    await request(f.app.getHttpServer())
      .post('/auth/sessions')
      .set('Authorization', token)
      .send(wireDeviceReport)
      .expect(200);
  }
  it('requires authentication and existing processing access', async () => {
    await request(f.app.getHttpServer())
      .post('/media-imports')
      .send(body)
      .expect(401);
    await request(f.app.getHttpServer())
      .post('/media-imports')
      .set('Authorization', token)
      .send(body)
      .expect(409);
    expect(f.urlImports.create).not.toHaveBeenCalled();
  });
  it('returns an asynchronous owner-scoped snake_case response and Location', async () => {
    await sync();
    f.urlImports.create.mockResolvedValue({
      importId: id,
      status: 'queued',
      jobId: null,
      error: null,
    });
    const response = await request(f.app.getHttpServer())
      .post('/media-imports')
      .set('Authorization', token)
      .set('X-Installation-Id', deviceReport.installationId)
      .send(body)
      .expect(202);
    expect(response.body).toMatchObject({
      import_id: id,
      status: 'queued',
      job_id: null,
    });
    expect(response.headers.location).toBe(`/media-imports/${id}`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.urlImports.create).toHaveBeenCalledWith(
      f.ownerId.toHexString(),
      body.url,
      body.request_id,
      undefined,
    );
  });
  it('passes the explicit no-trim choice through admission', async () => {
    await sync();
    f.urlImports.create.mockResolvedValue({ importId: id, status: 'queued' });
    await request(f.app.getHttpServer())
      .post('/media-imports')
      .set('Authorization', token)
      .set('X-Installation-Id', deviceReport.installationId)
      .send({ ...body, trim_enabled: false })
      .expect(202);
    expect(f.urlImports.create).toHaveBeenCalledWith(
      f.ownerId.toHexString(),
      body.url,
      body.request_id,
      false,
    );
  });
  it('rejects caller-selected ownership, keys and invalid request IDs before admission', async () => {
    await sync();
    for (const invalid of [
      { ...body, user_id: id },
      { ...body, s3_key: 'chosen-key' },
      { ...body, request_id: 'invalid' },
      { ...body, trim_enabled: 'false' },
      { ...body, trim_enabled: null },
    ]) {
      await request(f.app.getHttpServer())
        .post('/media-imports')
        .set('Authorization', token)
        .set('X-Installation-Id', deviceReport.installationId)
        .send(invalid)
        .expect(400);
    }
    expect(f.urlImports.create).not.toHaveBeenCalled();
  });
  it('status uses authenticated ownership and requires no media download', async () => {
    f.urlImports.get.mockResolvedValue({
      importId: id,
      status: 'submitted',
      jobId: id,
      error: null,
    });
    await request(f.app.getHttpServer())
      .get(`/media-imports/${id}`)
      .expect(401);
    const response = await request(f.app.getHttpServer())
      .get(`/media-imports/${id}`)
      .set('Authorization', token)
      .expect(200);
    expect(response.body.job_id).toBe(id);
    expect(f.urlImports.get).toHaveBeenCalledWith(f.ownerId.toHexString(), id);
  });
});
