import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { WorkerAuthGuard } from './worker-auth.guard.js';
import { WORKER_ONLY_ROUTE } from './worker-routes.js';

describe('fleet authentication boundary', () => {
  it('resolves a registered machine without the legacy environment key', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata(WORKER_ONLY_ROUTE, true, handler);
    const req = {
      headers: { authorization: 'Bearer fixture-machine-two-secret' },
      rawHeaders: [],
    };
    const context = {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const identities = {
      authenticateDigest: async (keySha256: string) => ({
        workerId: 'machine-two',
        keySha256,
        mode: 'fleet',
      }),
    };
    const guard = new WorkerAuthGuard(
      new Reflector(),
      new ConfigService({
        AUDIO_PROCESSING_ENABLED: true,
        PROCESSING_WORKER_AUTH_MODE: 'fleet',
      }),
      identities as never,
    );
    expect(await guard.canActivate(context)).toBe(true);
    expect(req).toMatchObject({
      workerId: 'machine-two',
      workerIdentity: { workerId: 'machine-two', mode: 'fleet' },
    });
  });
});
