import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { WorkerRoute, WORKER_ROUTE } from './worker-auth.decorators.js';
import { WorkerAuthGuard } from './worker-auth.guard.js';

describe('worker authorization boundary', () => {
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

  it('rejects worker routes until a scoped authenticator is implemented', () => {
    const reflector = new Reflector();
    const guard = new WorkerAuthGuard(reflector);
    const handler = () => undefined;
    Reflect.defineMetadata(WORKER_ROUTE, true, handler);
    const context = {
      getHandler: () => handler,
      getClass: () => class Controller {},
    };
    expect(() => guard.canActivate(context as never)).toThrow(
      'Worker authentication is required',
    );
  });
});
