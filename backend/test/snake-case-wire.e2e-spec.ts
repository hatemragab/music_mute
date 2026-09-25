import request from 'supertest';
import {
  authFixture,
  deviceReport,
  wireDeviceReport,
} from './helpers/auth-fixtures.js';

describe('snake_case public HTTP contract', () => {
  it('accepts snake_case request data and returns snake_case response data', async () => {
    const fixture = await authFixture();
    try {
      const response = await request(fixture.app.getHttpServer())
        .post('/auth/sessions')
        .set('Authorization', 'Bearer fixture-new-token')
        .send(wireDeviceReport)
        .expect(200);

      expect(fixture.devices.sync).toHaveBeenCalledWith(
        expect.any(String),
        100,
        deviceReport,
      );
      expect(response.body.device).toMatchObject({
        installation_id: deviceReport.installationId,
        app_version: deviceReport.appVersion,
      });
      expect(response.body.device).not.toHaveProperty('installationId');
      expect(response.body.policy).not.toHaveProperty('schemaVersion');
    } finally {
      await fixture.app.close();
    }
  });

  it('rejects legacy body and query spellings', async () => {
    const fixture = await authFixture();
    try {
      await request(fixture.app.getHttpServer())
        .post('/auth/sessions')
        .set('Authorization', 'Bearer fixture-new-token')
        .send(deviceReport)
        .expect(400);
      expect(fixture.devices.sync).not.toHaveBeenCalled();

      await request(fixture.app.getHttpServer())
        .get('/users/me/devices?metadataRevision=1')
        .set('Authorization', 'Bearer fixture-owner-token')
        .expect(400);
    } finally {
      await fixture.app.close();
    }
  });
});
