import { authError } from '../auth/auth.errors.js';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTE } from '../auth/auth.decorators.js';
import { WorkerAuthGuard } from './worker-auth.guard.js';
import {
  WORKER_ONLY_ROUTE,
  WORKER_CLEANUP_ROUTE,
  type WorkerAuthenticatedRequest,
} from './worker-routes.js';

const workerSecret = 'fixture-worker-secret-with-at-least-32-bytes';
const workerDigest = createHash('sha256').update(workerSecret).digest('hex');

describe('worker-only authentication', () => {
  function setup(
    options: {
      header?: unknown;
      enabled?: boolean;
      digest?: string;
      workerOnly?: boolean;
      publicRoute?: boolean;
    } = {},
  ) {
    const header = Object.hasOwn(options, 'header')
      ? options.header
      : `Bearer ${workerSecret}`;
    const enabled = options.enabled ?? true;
    const digest = options.digest ?? workerDigest;
    const workerOnly = options.workerOnly ?? true;
    const publicRoute = options.publicRoute ?? false;
    const handler = () => undefined;
    if (workerOnly) Reflect.defineMetadata(WORKER_ONLY_ROUTE, true, handler);
    if (publicRoute) Reflect.defineMetadata(PUBLIC_ROUTE, true, handler);
    const req = {
      headers: { authorization: header },
      rawHeaders: header === undefined ? [] : ['Authorization', String(header)],
    } as unknown as WorkerAuthenticatedRequest;
    const context = {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const guard = new WorkerAuthGuard(
      new Reflector(),
      new ConfigService({
        AUDIO_PROCESSING_ENABLED: enabled,
      }),
      {
        authenticateDigest: async (actual: string) => {
          if (actual !== digest) throw authError('UNAUTHENTICATED');
          return {
            workerId: 'fixture-worker',
            keySha256: actual,
            installationId: '11111111-1111-4111-8111-111111111111',
          };
        },
      } as never,
    );
    return { context, guard, handler, req };
  }

  it('is inert on ordinary routes', async () => {
    const f = setup({ header: undefined, enabled: false, workerOnly: false });
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.req.workerId).toBeUndefined();
  });

  it('accepts the registered bearer secret and attaches the server-owned identity', async () => {
    const f = setup();
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.req.workerId).toBe('fixture-worker');
  });

  it.each([
    undefined,
    'Basic fixture',
    'Bearer first second',
    'Bearer ',
    ['Bearer first', 'Bearer second'],
    `Bearer ${'a'.repeat(8193)}`,
  ])('rejects malformed bearer %j without attaching identity', (header) => {
    const f = setup({ header });
    expect(() => f.guard.canActivate(f.context)).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
    expect(f.req.workerId).toBeUndefined();
  });

  it('rejects repeated authorization headers', () => {
    const f = setup();
    f.req.rawHeaders.push('authorization', 'Bearer another');
    expect(() => f.guard.canActivate(f.context)).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
    expect(f.req.workerId).toBeUndefined();
  });

  it('rejects wrong and rotated-out secrets', async () => {
    for (const secret of ['wrong-worker-secret', 'old-worker-secret']) {
      const f = setup({ header: `Bearer ${secret}` });
      await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
        status: 401,
      });
      expect(f.req.workerId).toBeUndefined();
    }
  });

  it('refuses worker routes while audio processing is disabled', () => {
    const f = setup({ enabled: false });
    expect(() => f.guard.canActivate(f.context)).toThrowError(
      expect.objectContaining({ status: 503 }),
    );
    expect(f.req.workerId).toBeUndefined();
  });

  it('allows authenticated cleanup while processing is disabled', async () => {
    const f = setup({ enabled: false });
    Reflect.defineMetadata(WORKER_CLEANUP_ROUTE, true, f.handler);
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.req.workerId).toBe('fixture-worker');
  });

  it('rejects contradictory public and worker-only metadata', () => {
    const f = setup({ publicRoute: true });
    expect(() => f.guard.canActivate(f.context)).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
    expect(f.req.workerId).toBeUndefined();
  });
});
