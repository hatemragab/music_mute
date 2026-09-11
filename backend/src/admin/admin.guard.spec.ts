import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AdminGuard } from './admin.guard.js';
import {
  ADMIN_FRESH_AUTH,
  ADMIN_PERMISSION,
  ADMIN_ROUTE,
} from './admin.decorators.js';

describe('AdminGuard', () => {
  function setup() {
    const handler = () => undefined;
    Reflect.defineMetadata(ADMIN_ROUTE, true, handler);
    const req = {
      method: 'GET',
      headers: { 'x-request-id': '31da98a4-c7c9-43af-bca8-8e38c8ac78e2' },
      identity: {
        uid: 'owner-uid',
        authTimeSec: 1_700_000_000,
        provider: 'google.com',
        tokenEmailVerified: true,
      },
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
    const firebase = {
      getProfile: vi.fn(async () => ({
        uid: 'owner-uid',
        email: ' Owner@Example.com ',
        emailVerified: true,
        disabled: false,
        providerData: [
          { providerId: 'google.com', email: 'owner@example.com' },
        ],
      })),
    };
    const record = {
      uid: 'owner-uid',
      verifiedEmail: 'owner@example.com',
      role: 'owner',
      active: true,
      revision: 4,
    };
    const model = {
      findOne: vi.fn(() => ({
        lean: () => ({ exec: vi.fn(async () => record) }),
      })),
    };
    const rateLimits = { assertAllowed: vi.fn(async () => undefined) };
    const guard = new AdminGuard(
      new Reflector(),
      firebase as never,
      model as never,
      rateLimits as never,
      new ConfigService({ ADMIN_REAUTH_MAX_AGE_SECONDS: 300 }),
    );
    return {
      handler,
      req,
      response,
      context,
      firebase,
      record,
      model,
      rateLimits,
      guard,
    };
  }

  it('admits an active registered Google identity and derives the actor server-side', async () => {
    const f = setup();
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.req).toMatchObject({
      adminActor: {
        uid: 'owner-uid',
        verifiedEmail: 'owner@example.com',
        role: 'owner',
        accessRevision: 4,
        authTimeSec: 1_700_000_000,
      },
    });
    expect(f.response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
  });

  it('admits a matched Google profile when Firebase leaves its profile flag false', async () => {
    const f = setup();
    f.firebase.getProfile.mockResolvedValue({
      uid: 'owner-uid',
      email: 'owner@example.com',
      emailVerified: false,
      disabled: false,
      providerData: [{ providerId: 'google.com', email: 'owner@example.com' }],
    });

    await expect(f.guard.canActivate(f.context)).resolves.toBe(true);
  });

  it.each([
    ['password provider', { provider: 'password' }],
    ['unverified token email', { tokenEmailVerified: false }],
  ])('denies a %s before access lookup', async (_label, identity) => {
    const f = setup();
    Object.assign(f.req.identity, identity);
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 403,
    });
    expect(f.model.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled Firebase identity', { disabled: true }],
    ['missing Google profile', { providerData: [] }],
  ])('denies a %s', async (_label, profile) => {
    const f = setup();
    f.firebase.getProfile.mockResolvedValue({
      uid: 'owner-uid',
      email: 'owner@example.com',
      emailVerified: true,
      disabled: false,
      providerData: [{ providerId: 'google.com', email: 'owner@example.com' }],
      ...profile,
    });
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 403,
    });
  });

  it.each([
    ['missing access', null],
    ['inactive access', { active: false }],
    ['mismatched email', { verifiedEmail: 'other@example.com' }],
    ['unknown role', { role: 'root' }],
  ])('denies %s with a bounded admin error', async (_label, change) => {
    const f = setup();
    const value = change === null ? null : { ...f.record, ...change };
    f.model.findOne.mockReturnValue({
      lean: () => ({ exec: async () => value }),
    } as never);
    try {
      await f.guard.canActivate(f.context);
      throw new Error('expected denial');
    } catch (error) {
      expect(error).toMatchObject({ status: 403 });
      expect((error as { response: unknown }).response).toEqual({
        code: 'ADMIN_ACCESS_DENIED',
        message: 'Administrator access denied',
        requestId: '31da98a4-c7c9-43af-bca8-8e38c8ac78e2',
      });
    }
  });

  it('checks the current access record again on every request', async () => {
    const f = setup();
    expect(await f.guard.canActivate(f.context)).toBe(true);
    f.model.findOne.mockReturnValue({
      lean: () => ({ exec: async () => null }),
    } as never);
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('enforces permission metadata and fresh authentication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_301_000));
    const f = setup();
    f.record.role = 'viewer';
    Reflect.defineMetadata(ADMIN_PERMISSION, ['users.read'], f.handler);
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      response: { code: 'PERMISSION_DENIED' },
    });
    f.record.role = 'owner';
    Reflect.defineMetadata(ADMIN_PERMISSION, ['overview.read'], f.handler);
    Reflect.defineMetadata(ADMIN_FRESH_AUTH, true, f.handler);
    await expect(f.guard.canActivate(f.context)).rejects.toMatchObject({
      response: { code: 'ADMIN_REAUTH_REQUIRED' },
    });
    vi.useRealTimers();
  });

  it('does nothing on non-admin routes', async () => {
    const f = setup();
    Reflect.deleteMetadata(ADMIN_ROUTE, f.handler);
    expect(await f.guard.canActivate(f.context)).toBe(true);
    expect(f.firebase.getProfile).not.toHaveBeenCalled();
  });
});
