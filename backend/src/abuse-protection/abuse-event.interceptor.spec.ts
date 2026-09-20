import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_OPERATION } from '../auth/auth.decorators.js';
import { AbuseEventInterceptor } from './abuse-event.interceptor.js';

describe('AbuseEventInterceptor', () => {
  it('records only a bounded typed account event and preserves the response', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const interceptor = new AbuseEventInterceptor(
      { record } as never,
      new Reflector(),
    );
    const handler = () => undefined;
    Reflect.defineMetadata(AUTH_OPERATION, 'processing-download', handler);
    const error = new HttpException(
      {
        statusCode: 429,
        code: 'DOWNLOAD_GRANT_LIMIT_REACHED',
        message: 'The account download grant limit was reached',
      },
      429,
    );
    const context = {
      getHandler: () => handler,
      getClass: () => class FixtureController {},
      switchToHttp: () => ({
        getRequest: () => ({
          user: { _id: { toHexString: () => '64b000000000000000000001' } },
        }),
      }),
    } as unknown as ExecutionContext;
    await expect(
      firstValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);
    await vi.waitFor(() =>
      expect(record).toHaveBeenCalledWith({
        accountId: '64b000000000000000000001',
        type: 'download_grant_limit',
        severity: 'medium',
        operationClass: 'download_grant',
      }),
    );
  });

  it('does not persist arbitrary errors or unauthenticated identifiers', async () => {
    const record = vi.fn();
    const interceptor = new AbuseEventInterceptor(
      { record } as never,
      new Reflector(),
    );
    const context = {
      getHandler: () => () => undefined,
      getClass: () => class FixtureController {},
      switchToHttp: () => ({ getRequest: () => ({ ip: '203.0.113.7' }) }),
    } as unknown as ExecutionContext;
    await expect(
      firstValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new Error('raw private failure')),
        }),
      ),
    ).rejects.toThrow('raw private failure');
    expect(record).not.toHaveBeenCalled();
  });
});
