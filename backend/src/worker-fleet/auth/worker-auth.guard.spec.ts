import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AllowRevokedMachine,
  WorkerRoute,
  WORKER_ROUTE,
} from './worker-auth.decorators.js';
import { WorkerAuthGuard } from './worker-auth.guard.js';

describe('worker authorization boundary', () => {
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
    const guard = new WorkerAuthGuard(
      reflector,
      model as never,
      model as never,
      model as never,
    );
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
    await expect(guard.canActivate(context as never)).rejects.toThrow(
      'Worker authentication is required',
    );
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
    const guard = new WorkerAuthGuard(
      reflector,
      invitations as never,
      { findOne: vi.fn() } as never,
      { findOne: vi.fn() } as never,
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
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(invitations.findOne).toHaveBeenCalledWith({
      codeDigest: createHash('sha256').update(credential).digest('hex'),
    });
    expect(request).toMatchObject({
      workerPrincipal: {
        kind: 'enrollment',
        subjectId: 'f9d8df9d-1111-4111-8111-111111111111',
      },
    });
  });

  it('rejects duplicate authorization headers before a database lookup', async () => {
    const reflector = new Reflector();
    const model = { findOne: vi.fn() };
    const guard = new WorkerAuthGuard(
      reflector,
      model as never,
      model as never,
      model as never,
    );
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
    await expect(guard.canActivate(context as never)).rejects.toThrow(
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
    const guard = new WorkerAuthGuard(
      reflector,
      { findOne: vi.fn() } as never,
      { findOne: vi.fn() } as never,
      machines as never,
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
      guard.canActivate(
        context(Controller.prototype.ordinary, request()) as never,
      ),
    ).rejects.toThrow('Worker authentication is required');
    const replayRequest = request();
    await expect(
      guard.canActivate(
        context(Controller.prototype.unpair, replayRequest) as never,
      ),
    ).resolves.toBe(true);
    expect(replayRequest).toMatchObject({
      workerPrincipal: { kind: 'machine', machineStatus: 'revoked' },
    });
  });
});
