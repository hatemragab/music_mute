import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from './auth.guard.js';
import type { FirebaseIdentityService } from './firebase-identity.service.js';
import type { UsersService } from '../users/users.service.js';
import type { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import type { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import {
  ACCOUNT_DELETION,
  ACCOUNT_RECOVERY,
  PUBLIC_ROUTE,
} from './auth.decorators.js';
import { WORKER_ONLY_ROUTE } from '../worker/worker-routes.js';
import { ADMIN_ROUTE } from '../admin/admin.decorators.js';

describe('private request trust order', () => {
  function setup(header: unknown = 'Bearer fixture-token') {
    const events: string[] = [];
    const identity = {
      uid: 'fixture-owner',
      authTimeSec: 100,
      provider: 'password',
      tokenEmailVerified: false,
    };
    const firebase = {
      verifySignature: vi.fn(async () => {
        events.push('signature');
        return { uid: identity.uid };
      }),
      verifySession: vi.fn(async () => {
        events.push('revocation');
        return identity;
      }),
    };
    const users = {
      findByFirebaseUid: vi.fn(async () => {
        events.push('local-user');
        return { status: 'active', sessionsRevokedAfterSec: 0 };
      }),
      recordActivity: vi.fn().mockResolvedValue(undefined),
    };
    const budgets = {
      reserve: vi.fn(async () => {
        events.push('uid-budget');
        return { allowed: true, retryAfterSeconds: 0 };
      }),
    };
    const keys = { bucket: (scope: string, id: string) => `${scope}:${id}` };
    const handler = () => undefined;
    const req: any = {
      headers: { authorization: header },
      rawHeaders: ['Authorization', header],
      ip: '127.0.0.1',
      method: 'GET',
    };
    const response = { setHeader: vi.fn() };
    const context = {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    const guard = new AuthGuard(
      new Reflector(),
      firebase as unknown as FirebaseIdentityService,
      users as unknown as UsersService,
      budgets as unknown as RateBudgetService,
      keys as unknown as RateLimitKeys,
      new ConfigService(),
    );
    return {
      events,
      firebase,
      users,
      budgets,
      req,
      response,
      context,
      guard,
      handler,
    };
  }
  it('checks signature before shared UID budgets, then current Firebase revocation and local state', async () => {
    const f = setup();
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.events).toEqual([
      'signature',
      'uid-budget',
      'revocation',
      'local-user',
    ]);
  });
  it.each([
    undefined,
    'Basic fixture',
    'Bearer first second',
    'Bearer ',
    ['Bearer a', 'Bearer b'],
    `Bearer ${'a'.repeat(8193)}`,
  ])('rejects malformed bearer %j before SDK access', async (value) => {
    const f = setup(null);
    f.req.headers.authorization = value;
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 401,
    });
    expect(f.firebase.verifySignature).not.toHaveBeenCalled();
  });
  it('does not create UID counters from an invalid signature', async () => {
    const f = setup();
    f.firebase.verifySignature.mockRejectedValue(
      new Error('invalid signature'),
    );
    await expect(f.guard.canActivate(f.context)).rejects.toBeDefined();
    expect(f.budgets.reserve).not.toHaveBeenCalled();
  });
  it('rejects exhausted UID before upstream revocation lookup and provides retry-after', async () => {
    const f = setup();
    f.budgets.reserve.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 12,
    });
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 429,
    });
    expect(f.firebase.verifySession).not.toHaveBeenCalled();
    expect(f.response.setHeader).toHaveBeenCalledWith('Retry-After', 12);
  });
  it('rejects both old auth sessions at the cutoff and allows a later sign-in', async () => {
    const f = setup();
    f.users.findByFirebaseUid.mockResolvedValue({
      status: 'active',
      sessionsRevokedAfterSec: 100,
    });
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 401,
    });
    f.firebase.verifySession.mockResolvedValue({
      uid: 'fixture-owner',
      authTimeSec: 99,
      provider: 'password',
      tokenEmailVerified: false,
    });
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 401,
    });
    f.firebase.verifySession.mockResolvedValue({
      uid: 'fixture-owner',
      authTimeSec: 101,
      provider: 'password',
      tokenEmailVerified: false,
    });
    expect(await f.guard.canActivate(f.context)).toBe(true);
  });
  it('rejects duplicate authorization headers and disabled local users', async () => {
    const f = setup();
    f.req.rawHeaders.push('authorization', 'Bearer another');
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 401,
    });
    const disabled = setup();
    disabled.users.findByFirebaseUid.mockResolvedValue({
      status: 'disabled',
      sessionsRevokedAfterSec: 0,
    });
    await expect(
      disabled.guard.canActivate(disabled.context),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('leaves worker-only routes to the worker guard without consulting Firebase', async () => {
    const f = setup(undefined);
    Reflect.defineMetadata(WORKER_ONLY_ROUTE, true, f.handler);
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.firebase.verifySignature).not.toHaveBeenCalled();
    expect(f.budgets.reserve).not.toHaveBeenCalled();
  });
  it('verifies admin identity without requiring a mobile profile', async () => {
    const f = setup();
    Reflect.defineMetadata(ADMIN_ROUTE, true, f.handler);
    f.users.findByFirebaseUid.mockResolvedValue(null as never);
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.req.identity).toMatchObject({ uid: 'fixture-owner' });
    expect(f.req.user).toBeNull();
  });
  it('fences a deleting account except the explicitly marked idempotent deletion route', async () => {
    const f = setup();
    f.users.findByFirebaseUid.mockResolvedValue({
      status: 'deleting',
      sessionsRevokedAfterSec: 0,
    });
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 403,
      response: { code: 'ACCOUNT_DELETION_PENDING' },
    });
    Reflect.defineMetadata(ACCOUNT_RECOVERY, true, f.handler);
    expect(await f.guard.canActivate(f.context)).toBe(true);
    Reflect.deleteMetadata(ACCOUNT_RECOVERY, f.handler);
    Reflect.defineMetadata(ACCOUNT_DELETION, true, f.handler);
    expect(await f.guard.canActivate(f.context)).toBe(true);
    f.firebase.verifySession.mockRejectedValue(new Error('revoked'));
    await expect(f.guard.canActivate(f.context)).rejects.toThrow('revoked');
  });
  it('keeps public routes public but rejects contradictory public and worker metadata', async () => {
    const publicRoute = setup(undefined);
    Reflect.defineMetadata(PUBLIC_ROUTE, true, publicRoute.handler);
    expect(await publicRoute.guard.canActivate(publicRoute.context)).toBe(true);
    expect(publicRoute.firebase.verifySignature).not.toHaveBeenCalled();

    const contradictory = setup(undefined);
    Reflect.defineMetadata(PUBLIC_ROUTE, true, contradictory.handler);
    Reflect.defineMetadata(WORKER_ONLY_ROUTE, true, contradictory.handler);
    await expect(
      contradictory.guard.canActivate(contradictory.context),
    ).rejects.toMatchObject({ status: 401 });
    expect(contradictory.firebase.verifySignature).not.toHaveBeenCalled();

    const publicAdmin = setup(undefined);
    Reflect.defineMetadata(PUBLIC_ROUTE, true, publicAdmin.handler);
    Reflect.defineMetadata(ADMIN_ROUTE, true, publicAdmin.handler);
    await expect(
      publicAdmin.guard.canActivate(publicAdmin.context),
    ).rejects.toMatchObject({
      status: 401,
    });
  });
});
