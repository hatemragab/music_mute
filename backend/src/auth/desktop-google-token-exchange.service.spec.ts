import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopGoogleTokenExchangeService } from './desktop-google-token-exchange.service.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';

const clientId = '123456-fixture.apps.googleusercontent.com';
const clientSecret = 'fixture-only-desktop-secret';
const jwt = ['fixture-header', 'fixture-payload', 'fixture-signature']
  .map((value) => Buffer.from(value).toString('base64url'))
  .join('.');
const request = {
  authorizationCode: 'fixture-code/with+safe=form',
  codeVerifier: 'v'.repeat(43),
  redirectUri: 'http://127.0.0.1:49153/oauth2callback',
};
function response(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
function fixture(configOverrides: Record<string, unknown> = {}) {
  const config = new ConfigService({
    GOOGLE_DESKTOP_CLIENT_ID: clientId,
    GOOGLE_DESKTOP_CLIENT_SECRET: clientSecret,
    FIREBASE_PROJECT_ID: 'demo-musicmute',
    RATE_LIMIT_HASH_SECRET: 'fixture-only-rate-limit-secret',
    ...configOverrides,
  });
  const reserve = vi
    .fn()
    .mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  const service = new DesktopGoogleTokenExchangeService(
    config,
    { reserve } as unknown as RateBudgetService,
    new RateLimitKeys(config),
  );
  const fetch = vi.fn().mockResolvedValue(response({ id_token: jwt }));
  vi.stubGlobal('fetch', fetch);
  return { service, reserve, fetch, config };
}
async function failure(
  operation: Promise<unknown>,
  status = 503,
  code = 'SERVICE_UNAVAILABLE',
) {
  try {
    await operation;
    throw new Error('Expected exchange failure');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toMatchObject({ code });
    expect(JSON.stringify(exception.getResponse())).not.toContain(clientSecret);
    expect(JSON.stringify(exception.getResponse())).not.toContain(
      request.authorizationCode,
    );
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeEach(() =>
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
);
describe('fixed Desktop Google code exchange', () => {
  it('reserves both pre-auth budgets before one fixed HTTPS form POST and returns only the identity token', async () => {
    const e = fixture();
    e.fetch.mockImplementation(async () => {
      expect(e.reserve).toHaveBeenCalledOnce();
      return response({
        id_token: jwt,
        access_token: 'private-access',
        refresh_token: 'private-refresh',
      });
    });
    expect(await e.service.exchange(request, '192.0.2.10')).toEqual({
      googleIdToken: jwt,
    });
    const [url, options] = e.fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({
      client_id: clientId,
      client_secret: clientSecret,
      code: request.authorizationCode,
      code_verifier: request.codeVerifier,
      redirect_uri: request.redirectUri,
      grant_type: 'authorization_code',
    });
    expect(e.fetch).toHaveBeenCalledOnce();
    const [buckets] = e.reserve.mock.calls[0];
    expect(buckets).toMatchObject([
      { limit: 10, windowMs: 60_000 },
      { limit: 300, windowMs: 60_000 },
    ]);
    expect(buckets[0].key).not.toContain('192.0.2.10');
    expect(buckets[0].key).not.toContain(request.authorizationCode);
    expect(buckets[0].key).not.toBe(buckets[1].key);
  });
  it.each([1, 65535])(
    'allows an exact dynamic loopback callback port %s without fetching it',
    async (port) => {
      const e = fixture();
      await e.service.exchange(
        { ...request, redirectUri: `http://127.0.0.1:${port}/oauth2callback` },
        'fixture-ip',
      );
      expect(e.fetch.mock.calls[0][0]).toBe(
        'https://oauth2.googleapis.com/token',
      );
    },
  );
  it.each([
    'http://127.0.0.1:0/oauth2callback',
    'http://127.0.0.1:65536/oauth2callback',
    'http://127.0.0.1:049153/oauth2callback',
    'http://localhost:49153/oauth2callback',
    'http://[::1]:49153/oauth2callback',
    'https://127.0.0.1:49153/oauth2callback',
    'http://user@127.0.0.1:49153/oauth2callback',
    'http://127.0.0.1:49153/oauth2callback?x=1',
    'http://127.0.0.1:49153/oauth2callback#x',
    'http://127.0.0.1:49153/%6fauth2callback',
    'http://2130706433:49153/oauth2callback',
    'http://127.0.0.1:49153/oauth2callback/',
    'http://127.0.0.1:49153/oauth2callback\n',
    'http://127.0.0.1:49153/oauth2callback\u2028',
  ])(
    'refuses a noncanonical callback before admission or exchange: %s',
    async (redirectUri) => {
      const e = fixture();
      await failure(
        e.service.exchange({ ...request, redirectUri }, 'fixture-ip'),
        400,
        'INVALID_INPUT',
      );
      expect(e.reserve).not.toHaveBeenCalled();
      expect(e.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { codeVerifier: 'v'.repeat(42) },
    { codeVerifier: 'v'.repeat(129) },
    { codeVerifier: ' '.repeat(43) },
    { authorizationCode: '' },
    { authorizationCode: 'private\ncode' },
    { authorizationCode: 'private-code\n' },
    { authorizationCode: 'private-code\u2028' },
    { codeVerifier: `${'v'.repeat(43)}\n` },
    { codeVerifier: `${'v'.repeat(43)}\u2028` },
    { authorizationCode: 'c'.repeat(4097) },
    { clientId: 'attacker-client' },
    { tokenEndpoint: 'https://evil.invalid' },
  ])(
    'refuses malformed or overridden credentials without upstream work',
    async (invalid) => {
      const e = fixture();
      await failure(
        e.service.exchange({ ...request, ...invalid }, 'fixture-ip'),
        400,
        'INVALID_INPUT',
      );
      expect(e.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      GOOGLE_DESKTOP_CLIENT_ID: undefined,
      GOOGLE_DESKTOP_CLIENT_SECRET: undefined,
    },
    { GOOGLE_DESKTOP_CLIENT_ID: undefined },
    { GOOGLE_DESKTOP_CLIENT_SECRET: undefined },
  ])(
    'fails safely when optional fixed-client configuration is absent',
    async (config) => {
      const e = fixture(config);
      await failure(e.service.exchange(request, 'fixture-ip'));
      expect(e.reserve).toHaveBeenCalledOnce();
      expect(e.fetch).not.toHaveBeenCalled();
    },
  );
  it('rejects admission with Retry-After metadata and never contacts Google', async () => {
    const e = fixture();
    e.reserve.mockResolvedValue({ allowed: false, retryAfterSeconds: 21 });
    await expect(
      e.service.exchange(request, 'fixture-ip'),
    ).rejects.toMatchObject({
      retryAfterSeconds: 21,
      status: 429,
    });
    expect(e.fetch).not.toHaveBeenCalled();
  });
  it('does not exchange when the security store is unavailable', async () => {
    const e = fixture();
    e.reserve.mockRejectedValue(
      new HttpException(
        { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' },
        503,
      ),
    );
    await failure(e.service.exchange(request, 'fixture-ip'));
    expect(e.fetch).not.toHaveBeenCalled();
  });
  it('maps only an actual Google400 invalid_grant to a safe restart code', async () => {
    const e = fixture();
    e.fetch.mockResolvedValue(
      response(
        { error: 'invalid_grant', error_description: clientSecret },
        400,
      ),
    );
    await failure(
      e.service.exchange(request, 'fixture-ip'),
      400,
      'GOOGLE_TOKEN_INVALID_GRANT',
    );
    expect(e.fetch).toHaveBeenCalledOnce();
  });
  it.each([302, 401, 429, 500, 503])(
    'sanitizes upstream status%s without retry',
    async (status) => {
      const e = fixture();
      e.fetch.mockResolvedValue(
        response(
          { error: 'invalid_grant', error_description: clientSecret },
          status,
        ),
      );
      await failure(e.service.exchange(request, 'fixture-ip'));
      expect(e.fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([
    'invalid_client',
    'invalid_request',
    'redirect_uri_mismatch',
    'unknown-private-error',
  ])('does not expose upstream error %s', async (error) => {
    const e = fixture();
    e.fetch.mockResolvedValue(
      response({ error, error_description: clientSecret }, 400),
    );
    await failure(e.service.exchange(request, 'fixture-ip'));
  });
  it('sanitizes an ambiguous transport failure and never replays the one-time code', async () => {
    const e = fixture();
    e.fetch.mockRejectedValue(
      new Error(`${clientSecret} ${request.authorizationCode}`),
    );
    await failure(e.service.exchange(request, 'fixture-ip'));
    expect(e.fetch).toHaveBeenCalledOnce();
    expect(Logger.prototype.warn).toHaveBeenCalledWith({
      event: 'desktop_google_exchange_failed',
      reason: 'upstream_unavailable',
    });
    const diagnostics = JSON.stringify(
      vi.mocked(Logger.prototype.warn).mock.calls,
    );
    for (const sensitive of [
      clientSecret,
      request.authorizationCode,
      request.codeVerifier,
      'fixture-ip',
    ])
      expect(diagnostics).not.toContain(sensitive);
  });
  it('records only a fixed client-config diagnosis and status from an upstream error', async () => {
    const e = fixture();
    e.fetch.mockResolvedValue(
      response(
        {
          error: 'invalid_client',
          error_description: `${clientSecret} ${request.authorizationCode}`,
        },
        400,
      ),
    );
    await failure(e.service.exchange(request, 'fixture-ip'));
    expect(Logger.prototype.warn).toHaveBeenCalledWith({
      event: 'desktop_google_exchange_failed',
      reason: 'upstream_client_invalid',
      http_status: 400,
    });
    const diagnostics = JSON.stringify(
      vi.mocked(Logger.prototype.warn).mock.calls,
    );
    expect(diagnostics).not.toContain(clientSecret);
    expect(diagnostics).not.toContain(request.authorizationCode);
  });
  it('does not trust an exception-shaped transport failure as a public response', async () => {
    const e = fixture();
    e.fetch.mockRejectedValue(
      new HttpException(
        { code: 'GOOGLE_TOKEN_INVALID_GRANT', message: clientSecret },
        400,
      ),
    );
    await failure(e.service.exchange(request, 'fixture-ip'));
    expect(e.fetch).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls),
    ).not.toContain(clientSecret);
  });
  it.each([
    { GOOGLE_DESKTOP_CLIENT_ID: 'attacker-client' },
    { GOOGLE_DESKTOP_CLIENT_SECRET: 'private secret' },
    { GOOGLE_DESKTOP_CLIENT_ID: `${clientId}\n` },
    { GOOGLE_DESKTOP_CLIENT_SECRET: `${clientSecret}\n` },
  ])(
    'fails closed on invalid fixed-client configuration without printing values',
    async (config) => {
      const e = fixture(config);
      await failure(e.service.exchange(request, 'fixture-ip'));
      expect(e.fetch).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledWith({
        event: 'desktop_google_exchange_failed',
        reason: 'config_invalid',
      });
    },
  );
  it('refuses redirected responses even if a transport ignored redirect:error', async () => {
    const e = fixture();
    const redirected = response({ id_token: jwt });
    Object.defineProperty(redirected, 'redirected', { value: true });
    e.fetch.mockResolvedValue(redirected);
    await failure(e.service.exchange(request, 'fixture-ip'));
    expect(e.fetch).toHaveBeenCalledOnce();
  });
  it.each([
    null,
    [],
    {},
    { id_token: '' },
    { id_token: 'not-a-jwt' },
    { id_token: `${'a'.repeat(16384)}.b.c` },
    { id_token: 12 },
    { id_token: `${jwt}\n` },
    { id_token: `${jwt}\u2028` },
  ])(
    'refuses malformed identity responses without forwarding any credential',
    async (payload) => {
      const e = fixture();
      e.fetch.mockResolvedValue(response(payload));
      await failure(e.service.exchange(request, 'fixture-ip'));
    },
  );
  it.each([
    { 'Content-Length': '32769' },
    { 'Content-Length': '-1' },
    { 'Content-Length': '1' },
    { 'Content-Type': 'text/html' },
    { 'Content-Encoding': 'gzip' },
  ] as Record<string, string>[])(
    'refuses oversized, inconsistent or non-JSON response declarations',
    async (headers) => {
      const e = fixture();
      e.fetch.mockResolvedValue(response({ id_token: jwt }, 200, headers));
      await failure(e.service.exchange(request, 'fixture-ip'));
    },
  );
  it('counts actual streamed bytes before parsing and cancels an oversized response', async () => {
    const e = fixture(),
      cancel = vi.fn();
    e.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(32769));
          },
          cancel,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await failure(e.service.exchange(request, 'fixture-ip'));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('refuses truncated JSON and stream failures without leaking raw response data', async () => {
    const e = fixture();
    e.fetch.mockResolvedValueOnce(
      new Response('{"id_token":', {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await failure(e.service.exchange(request, 'fixture-ip'));
    e.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(clientSecret));
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await failure(e.service.exchange(request, 'fixture-ip'));
  });
  it.each(['headers', 'body'])(
    'bounds a stalled%s phase to the total five-second deadline',
    async (phase) => {
      vi.useFakeTimers();
      const e = fixture();
      e.fetch.mockImplementation(() =>
        phase === 'headers'
          ? new Promise(() => undefined)
          : Promise.resolve(
              new Response(new ReadableStream(), {
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
      );
      const checked = failure(e.service.exchange(request, 'fixture-ip'));
      await vi.advanceTimersByTimeAsync(5000);
      await checked;
      expect(e.fetch).toHaveBeenCalledOnce();
      expect(e.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    },
  );
});
