import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { authFixture } from './helpers/auth-fixtures.js';

const route = '/auth/desktop-google-token-exchanges';
const payload = {
  authorization_code: 'fixture-authorization-code',
  code_verifier: 'v'.repeat(43),
  redirect_uri: 'http://127.0.0.1:49153/oauth2callback',
};
const secret = 'fixture-only-desktop-client-secret';
const jwt = ['fixture-header', 'fixture-payload', 'fixture-signature']
  .map((value) => Buffer.from(value).toString('base64url'))
  .join('.');
describe('public Desktop Google exchange HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof authFixture>>;
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    f = await authFixture();
    const config = f.app.get(ConfigService);
    config.set(
      'GOOGLE_DESKTOP_CLIENT_ID',
      '123-fixture.apps.googleusercontent.com',
    );
    config.set('GOOGLE_DESKTOP_CLIENT_SECRET', secret);
    fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id_token: jwt,
          access_token: 'fixture-private-access',
          refresh_token: 'fixture-private-refresh',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetch);
  });
  afterEach(async () => {
    await f?.app.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('is public before Firebase session creation and exposes only snake_case identity output', async () => {
    const result = await request(f.app.getHttpServer())
      .post(route)
      .send(payload)
      .expect(200, { google_id_token: jwt });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(f.firebase.verifySignature).not.toHaveBeenCalled();
    expect(f.firebase.getProfile).not.toHaveBeenCalled();
    expect(f.budgets.reserve).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    for (const privateValue of [
      secret,
      'fixture-private-access',
      'fixture-private-refresh',
      payload.authorization_code,
      payload.code_verifier,
    ])
      expect(result.text).not.toContain(privateValue);
  });
  it.each([
    {},
    { ...payload, authorization_code: '' },
    { ...payload, authorization_code: 'c'.repeat(4097) },
    { ...payload, code_verifier: 'v'.repeat(42) },
    { ...payload, code_verifier: 'v'.repeat(129) },
    { ...payload, authorization_code: `${payload.authorization_code}\n` },
    { ...payload, code_verifier: `${payload.code_verifier}\n` },
    { ...payload, redirect_uri: `${payload.redirect_uri}\n` },
    { ...payload, redirect_uri: 'http://127.0.0.1:65536/oauth2callback' },
    {
      ...payload,
      redirect_uri: 'http://127.0.0.1:49153/oauth2callback?code=private',
    },
    { ...payload, client_id: 'other-client' },
    { ...payload, client_secret: 'attacker-secret' },
    { ...payload, token_endpoint: 'https://evil.invalid' },
    {
      authorizationCode: payload.authorization_code,
      codeVerifier: payload.code_verifier,
      redirectUri: payload.redirect_uri,
    },
  ])(
    'rejects malformed or additional wire fields before upstream exchange',
    async (body) => {
      const result = await request(f.app.getHttpServer())
        .post(route)
        .send(body)
        .expect(400);
      expect(result.body.code).toBe('INVALID_INPUT');
      expect(result.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(result.headers['cache-control']).toBe('no-store');
      expect(fetch).not.toHaveBeenCalled();
      expect(result.text).not.toContain(payload.authorization_code);
    },
  );
  it('fails safely with no configured Desktop pair without requiring bearer auth', async () => {
    f.app.get(ConfigService).set('GOOGLE_DESKTOP_CLIENT_ID', undefined);
    f.app.get(ConfigService).set('GOOGLE_DESKTOP_CLIENT_SECRET', undefined);
    const result = await request(f.app.getHttpServer())
      .post(route)
      .send(payload)
      .expect(503);
    expect(result.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(fetch).not.toHaveBeenCalled();
    expect(f.firebase.verifySignature).not.toHaveBeenCalled();
  });
  it('returns dedicated shared admission Retry-After and never exchanges', async () => {
    f.state.uidDenied = true;
    const result = await request(f.app.getHttpServer())
      .post(route)
      .send(payload)
      .expect(429);
    expect(result.body.code).toBe('RATE_LIMITED');
    expect(result.headers['retry-after']).toBe('12');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sanitizes security-store failure before outbound exchange', async () => {
    f.budgets.reserve.mockRejectedValue(
      new Error(`${secret} private Redis connection`),
    );
    const result = await request(f.app.getHttpServer())
      .post(route)
      .send(payload)
      .expect(503);
    expect(result.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(fetch).not.toHaveBeenCalled();
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain('Redis');
  });
  it('preserves the global IP throttle before the dedicated reservation', async () => {
    f.state.ipDenied = true;
    await request(f.app.getHttpServer()).post(route).send(payload).expect(429);
    expect(f.budgets.reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns safe one-time-code rejection without provider descriptions', async () => {
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: `${secret} ${payload.authorization_code}`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const result = await request(f.app.getHttpServer())
      .post(route)
      .send(payload)
      .expect(400);
    expect(result.body.code).toBe('GOOGLE_TOKEN_INVALID_GRANT');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain(payload.authorization_code);
  });
  it('retains the global request size limit without forwarding oversized credentials', async () => {
    const result = await request(f.app.getHttpServer())
      .post(route)
      .send({
        ...payload,
        authorization_code: 'c'.repeat(65536),
      })
      .expect(413);
    expect(result.body.code).toBe('UPLOAD_TOO_LARGE');
    expect(fetch).not.toHaveBeenCalled();
  });
});
