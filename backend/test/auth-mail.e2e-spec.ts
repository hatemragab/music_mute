import request from 'supertest';
import { authFixture } from './helpers/auth-fixtures.js';

describe('voluntary verification and generic recovery HTTP', () => {
  let f: Awaited<ReturnType<typeof authFixture>>;
  beforeEach(async () => {
    f = await authFixture();
  });
  afterEach(async () => {
    await f?.app.close();
  });
  const token = 'Bearer fixture-owner-token';
  it('sends verification on request, short circuits verified users, and rejects target overrides', async () => {
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/verification-email')
      .set('Authorization', token)
      .send({})
      .expect(202, { status: 'accepted' });
    expect(f.mail.sendVerification).toHaveBeenCalledWith('fixture-owner-token');
    f.state.emailVerified = true;
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/verification-email')
      .set('Authorization', token)
      .send({})
      .expect(200, { status: 'already_verified' });
    expect(f.mail.sendVerification).toHaveBeenCalledTimes(1);
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/verification-email')
      .set('Authorization', token)
      .send({
        email: 'other@fixture.invalid',
        continueUrl: 'https://evil.invalid',
      })
      .expect(400);
  });
  it('keeps recovery public and generic, and strictly bounds its input', async () => {
    for (const email of [
      'fixture-owner@fixture.invalid',
      'unknown@fixture.invalid',
    ])
      await request(f.app.getHttpServer())
        .post('/api/v1/auth/password-reset')
        .send({ email })
        .expect(202, { status: 'accepted' });
    expect(f.firebase.getProfile).not.toHaveBeenCalled();
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/password-reset')
      .send({ email: 'bad' })
      .expect(400);
    await request(f.app.getHttpServer())
      .post('/api/v1/auth/password-reset')
      .send({ email: 'a@fixture.invalid', uid: 'forged' })
      .expect(400);
  });
  it('returns a retry header when mail reservation is refused and sanitizes storage failure', async () => {
    f.state.uidDenied = true;
    const limited = await request(f.app.getHttpServer())
      .post('/api/v1/auth/password-reset')
      .send({ email: 'owner@fixture.invalid' })
      .expect(429);
    expect(limited.headers['retry-after']).toBe('12');
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(f.mail.sendPasswordReset).not.toHaveBeenCalled();
    f.state.uidDenied = false;
    f.budgets.isPaused.mockRejectedValue(new Error('private redis URL'));
    const unavailable = await request(f.app.getHttpServer())
      .post('/api/v1/auth/password-reset')
      .send({ email: 'owner@fixture.invalid' })
      .expect(503);
    expect(unavailable.body).toEqual({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
    });
    expect(unavailable.text).not.toContain('private');
  });
});
