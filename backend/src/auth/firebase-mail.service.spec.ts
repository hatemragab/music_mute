import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FirebaseMailService,
  FirebaseMailQuotaError,
} from './firebase-mail.service.js';

describe('Firebase hosted email adapter', () => {
  const service = () =>
    new FirebaseMailService(
      new ConfigService({
        FIREBASE_WEB_API_KEY: 'fixture-key',
        APP_ENV: 'test',
        FIREBASE_PROJECT_ID: 'demo-musicmute',
      }),
    );
  afterEach(() => vi.unstubAllGlobals());
  it('posts verification only to the fixed endpoint with bounded lifetime and no redirect', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await service().sendVerification('fixture-token');
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(
      'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fixture-key',
    );
    expect(JSON.parse(options.body)).toEqual({
      requestType: 'VERIFY_EMAIL',
      idToken: 'fixture-token',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe('error');
  });
  it('accepts unknown password reset addresses without an account lookup', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'EMAIL_NOT_FOUND' } }),
          { status: 400 },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    await service().sendPasswordReset('unknown@fixture.invalid');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['QUOTA_EXCEEDED', 'TOO_MANY_ATTEMPTS_TRY_LATER'])(
    'identifies upstream quota %s',
    async (message) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { message } }), {
            status: 400,
          }),
        ),
      );
      await expect(
        service().sendVerification('fixture-token'),
      ).rejects.toBeInstanceOf(FirebaseMailQuotaError);
    },
  );
  it('never retries an ambiguous transport failure or exposes details', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('private token or key'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      service().sendVerification('fixture-token'),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('maps invalid token and unknown upstream HTTP failures explicitly', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'INVALID_ID_TOKEN' } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response('private upstream', { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      service().sendVerification('fixture-token'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service().sendPasswordReset('any@fixture.invalid'),
    ).rejects.toMatchObject({ status: 503 });
  });
});
