import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { authError } from './auth.errors.js';
import { AuthRateLimitException } from './rate-limit.exception.js';
import {
  isDesktopGoogleRedirect,
  type DesktopGoogleTokenExchangeDto,
} from './dto/desktop-google-token-exchange.dto.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_ID_TOKEN_LENGTH = 16 * 1024;
const EXCHANGE_DEADLINE_MS = 5000;
type ExchangeFailureReason =
  | 'config_missing'
  | 'config_invalid'
  | 'security_store_unavailable'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'upstream_client_invalid'
  | 'upstream_request_invalid'
  | 'response_invalid';

class GoogleCodeRejectedError extends Error {}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(authError('SERVICE_UNAVAILABLE'));
    if (signal.aborted) {
      // Observe an in-flight rejection even when admission was already aborted.
      void operation.catch(() => undefined);
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', aborted);
    });
  });
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (
    !response.body ||
    (response.headers.get('content-encoding') !== null &&
      response.headers.get('content-encoding') !== 'identity') ||
    !/^application\/json(?:\s*;|\s*$)/i.test(
      response.headers.get('content-type') ?? '',
    ) ||
    (length !== null &&
      (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw authError('SERVICE_UNAVAILABLE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw authError('SERVICE_UNAVAILABLE');
      chunks.push(item.value);
    }
    if (!bytes || (length !== null && Number(length) !== bytes))
      throw authError('SERVICE_UNAVAILABLE');
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } finally {
    // No provider body is retained beyond this exchange or forwarded to a logger.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

@Injectable()
export class DesktopGoogleTokenExchangeService {
  private readonly logger = new Logger(DesktopGoogleTokenExchangeService.name);
  constructor(
    private readonly config: ConfigService,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
  ) {}

  async exchange(
    dto: DesktopGoogleTokenExchangeDto,
    ip: string,
  ): Promise<{ googleIdToken: string }> {
    if (
      !dto ||
      Object.keys(dto).some(
        (key) =>
          !['authorizationCode', 'codeVerifier', 'redirectUri'].includes(key),
      ) ||
      typeof dto.authorizationCode !== 'string' ||
      !/^[\x21-\x7e]{1,4096}(?![\s\S])/.test(dto.authorizationCode) ||
      typeof dto.codeVerifier !== 'string' ||
      !/^[A-Za-z0-9._~-]{43,128}(?![\s\S])/.test(dto.codeVerifier) ||
      !isDesktopGoogleRedirect(dto.redirectUri)
    )
      throw authError('INVALID_INPUT');

    // @Public() bypasses account budgets. Reserve both shared pre-auth budgets
    // before configuration lookup or the only upstream attempt.
    const decision = await this.budgets
      .reserve([
        {
          key: this.keys.bucket('desktop-google-exchange-ip', ip || 'unknown'),
          limit: this.config.get<number>(
            'DESKTOP_GOOGLE_EXCHANGE_IP_PER_MINUTE',
            10,
          ),
          windowMs: 60_000,
        },
        {
          key: this.keys.bucket('desktop-google-exchange-service', 'global'),
          limit: this.config.get<number>(
            'DESKTOP_GOOGLE_EXCHANGE_SERVICE_PER_MINUTE',
            300,
          ),
          windowMs: 60_000,
        },
      ])
      .catch(() => {
        this.failure('security_store_unavailable');
        throw authError('SERVICE_UNAVAILABLE');
      });
    if (!decision.allowed)
      throw new AuthRateLimitException(decision.retryAfterSeconds);

    const clientId = this.config.get<string>('GOOGLE_DESKTOP_CLIENT_ID');
    const clientSecret = this.config.get<string>(
      'GOOGLE_DESKTOP_CLIENT_SECRET',
    );
    if (!clientId || !clientSecret) {
      this.failure(
        clientId || clientSecret ? 'config_invalid' : 'config_missing',
      );
      throw authError('SERVICE_UNAVAILABLE');
    }
    if (
      clientId.length > 256 ||
      !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com(?![\s\S])/.test(
        clientId,
      ) ||
      !/^[\x21-\x7e]{1,256}(?![\s\S])/.test(clientSecret)
    ) {
      this.failure('config_invalid');
      throw authError('SERVICE_UNAVAILABLE');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXCHANGE_DEADLINE_MS);
    timer.unref?.();
    let failureReason: ExchangeFailureReason = 'upstream_unavailable';
    let httpStatus: number | undefined;
    try {
      const response = await abortable(
        fetch(GOOGLE_TOKEN_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code: dto.authorizationCode,
            code_verifier: dto.codeVerifier,
            redirect_uri: dto.redirectUri,
            grant_type: 'authorization_code',
          }).toString(),
          signal: controller.signal,
        }),
        controller.signal,
      );
      httpStatus = response.status;
      failureReason = 'response_invalid';
      if (response.redirected) {
        void response.body?.cancel().catch(() => undefined);
        throw authError('SERVICE_UNAVAILABLE');
      }
      const value = await boundedJson(response, controller.signal);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw authError('SERVICE_UNAVAILABLE');
      const payload = value as Record<string, unknown>;
      if (response.status === 400 && payload.error === 'invalid_grant')
        throw new GoogleCodeRejectedError();
      if (response.status !== 200) {
        failureReason =
          payload.error === 'invalid_client'
            ? 'upstream_client_invalid'
            : payload.error === 'invalid_request' ||
                payload.error === 'redirect_uri_mismatch'
              ? 'upstream_request_invalid'
              : 'upstream_unavailable';
        throw authError('SERVICE_UNAVAILABLE');
      }
      if (
        typeof payload.id_token !== 'string' ||
        payload.id_token.length < 20 ||
        payload.id_token.length > MAX_ID_TOKEN_LENGTH ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\s\S])/.test(
          payload.id_token,
        )
      )
        throw authError('SERVICE_UNAVAILABLE');
      // This token comes directly from the fixed TLS Google endpoint. Firebase
      // independently verifies the IdP credential in the existing native flow.
      return { googleIdToken: payload.id_token };
    } catch (error) {
      if (error instanceof GoogleCodeRejectedError)
        throw authError('GOOGLE_TOKEN_INVALID_GRANT');
      this.failure(
        controller.signal.aborted ? 'upstream_timeout' : failureReason,
        httpStatus,
      );
      throw authError('SERVICE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private failure(reason: ExchangeFailureReason, httpStatus?: number): void {
    // Only fixed operator reasons and a numeric status leave this boundary.
    this.logger.warn({
      event: 'desktop_google_exchange_failed',
      reason,
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    });
  }
}
