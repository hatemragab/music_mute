import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllowRevokedMachine,
  WorkerRoute,
  WORKER_ROUTE,
} from './worker-auth.decorators.js';
import { WorkerAuthGuard } from './worker-auth.guard.js';

describe('worker authorization boundary', () => {
  const reserve = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
  const budgets = { reserve };
  const keys = { bucket: (scope: string, id: string) => `${scope}:${id}` };
  const config = { get: (_key: string, fallback: number) => fallback };
  const guard = (
    reflector: Reflector,
    invitations: unknown,
    installations: unknown,
    machines: unknown,
  ) =>
    new WorkerAuthGuard(
      reflector,
      invitations as never,
      installations as never,
      machines as never,
      budgets as never,
      keys as never,
      config as never,
    );

  beforeEach(() => {
    reserve.mockReset();
    reserve.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  });

  const query = (value: unknown) => ({
    maxTimeMS: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(value),
    }),
  });

  it('binds worker routes to the dedicated fail-closed guard', () => {
    class Controller {
      @WorkerRoute('machine')
      endpoint() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Controller.prototype,
      'endpoint',
    );
    const handler = descriptor?.value as () => void;
    expect(Reflect.getMetadata(WORKER_ROUTE, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      WorkerAuthGuard,
    );
  });

  it('rejects a worker route without exactly one bounded bearer credential', async () => {
    const reflector = new Reflector();
    const model = { findOne: vi.fn() };
    const auth = guard(reflector, model, model, model);
    class Controller {
      @WorkerRoute('machine')
      endpoint() {}
    }
    const handler = Controller.prototype.endpoint;
    const context = {
      getHandler: () => handler,
      getClass: () => Controller,
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, rawHeaders: [] }),
      }),
    };
    await expect(auth.canActivate(context as never)).rejects.toThrow(
      'Worker authentication is required',
    );
    expect(reserve).toHaveBeenCalledWith([
      { key: 'worker-preauth-ip:unknown', limit: 300, windowMs: 60_000 },
      {
        key: 'worker-preauth-service:global',
        limit: 3_000,
        windowMs: 60_000,
      },
    ]);
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('authenticates an active enrollment credential by digest', async () => {
    const reflector = new Reflector();
    const credential = Buffer.alloc(32, 7).toString('base64url');
    const invitations = {
      findOne: vi.fn().mockReturnValue(
        query({
          _id: 'f9d8df9d-1111-4111-8111-111111111111',
          state: 'active',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    };
    const auth = guard(
      reflector,
      invitations,
      { findOne: vi.fn() },
      { findOne: vi.fn() },
    );
    class Controller {
      @WorkerRoute('enrollment')
      endpoint() {}
    }
    const request = {
      headers: { authorization: `Bearer ${credential}` },
      rawHeaders: ['Authorization', `Bearer ${credential}`],
    };
    const context = {
      getHandler: () => Controller.prototype.endpoint,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => request }),
    };
    await expect(auth.canActivate(context as never)).resolves.toBe(true);
    expect(invitations.findOne).toHaveBeenCalledWith({
      codeDigest: createHash('sha256').update(credential).digest('hex'),
    });
    expect(request).toMatchObject({
      workerPrincipal: {
        kind: 'enrollment',
        subjectId: 'f9d8df9d-1111-4111-8111-111111111111',
      },
    });
    expect(reserve).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'worker-enrollment:f9d8df9d-1111-4111-8111-111111111111',
          limit: 20,
        }),
      ]),
    );
  });

  it('rejects duplicate authorization headers before a database lookup', async () => {
    const reflector = new Reflector();
    const model = { findOne: vi.fn() };
    const auth = guard(reflector, model, model, model);
    class Controller {
      @WorkerRoute('machine')
      endpoint() {}
    }
    const credential = Buffer.alloc(32, 9).toString('base64url');
    const context = {
      getHandler: () => Controller.prototype.endpoint,
      getClass: () => Controller,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: `Bearer ${credential}` },
          rawHeaders: [
            'Authorization',
            `Bearer ${credential}`,
            'authorization',
            `Bearer ${credential}`,
          ],
        }),
      }),
    };
    await expect(auth.canActivate(context as never)).rejects.toThrow(
      'Worker authentication is required',
    );
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('allows a revoked credential only on the explicit unpair replay route', async () => {
    const reflector = new Reflector();
    const credential = Buffer.alloc(32, 5).toString('base64url');
    const machines = {
      findOne: vi.fn().mockReturnValue(
        query({
          _id: '32410a14-e85a-4a1d-bb99-61fa54b07eaa',
          status: 'revoked',
        }),
      ),
    };
    const auth = guard(
      reflector,
      { findOne: vi.fn() },
      { findOne: vi.fn() },
      machines,
    );
    class Controller {
      @WorkerRoute('machine')
      ordinary() {}

      @WorkerRoute('machine')
      @AllowRevokedMachine()
      unpair() {}
    }
    const request = () => ({
      headers: { authorization: `Bearer ${credential}` },
      rawHeaders: ['Authorization', `Bearer ${credential}`],
    });
    const context = (handler: () => void, value: object) => ({
      getHandler: () => handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => value }),
    });
    await expect(
      auth.canActivate(
        context(Controller.prototype.ordinary, request()) as never,
      ),
    ).rejects.toThrow('Worker authentication is required');
    const replayRequest = request();
    await expect(
      auth.canActivate(
        context(Controller.prototype.unpair, replayRequest) as never,
      ),
    ).resolves.toBe(true);
    expect(replayRequest).toMatchObject({
      workerPrincipal: { kind: 'machine', machineStatus: 'revoked' },
    });
  });

  it('rejects a machine over its shared budget with a retry header', async () => {
    reserve
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 });
    const credential = Buffer.alloc(32, 4).toString('base64url');
    const machines = {
      findOne: vi
        .fn()
        .mockReturnValue(query({ _id: 'machine-1', status: 'active' })),
    };
    class Controller {
      @WorkerRoute('machine')
      endpoint() {}
    }
    const setHeader = vi.fn();
    const context = {
      getHandler: () => Controller.prototype.endpoint,
      getClass: () => Controller,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: `Bearer ${credential}` },
          rawHeaders: ['Authorization', `Bearer ${credential}`],
        }),
        getResponse: () => ({ setHeader }),
      }),
    };
    await expect(
      guard(new Reflector(), {}, {}, machines).canActivate(context as never),
    ).rejects.toMatchObject({ status: 429 });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', 17);
    expect(reserve).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'worker-machine:machine-1' }),
      ]),
    );
  });

  it('blocks credential lookup when the preauth service ceiling is exhausted', async () => {
    reserve.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 11 });
    const model = { findOne: vi.fn() };
    class Controller {
      @WorkerRoute('machine')
      endpoint() {}
    }
    const setHeader = vi.fn();
    const context = {
      getHandler: () => Controller.prototype.endpoint,
      getClass: () => Controller,
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, rawHeaders: [], ip: '192.0.2.9' }),
        getResponse: () => ({ setHeader }),
      }),
    };
    await expect(
      guard(new Reflector(), model, model, model).canActivate(context as never),
    ).rejects.toMatchObject({ status: 429 });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', 11);
    expect(model.findOne).not.toHaveBeenCalled();
  });
});
