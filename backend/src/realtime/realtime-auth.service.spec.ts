import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { AuthRequest } from '../auth/auth-request.js';
import { RealtimeAuthService } from './realtime-auth.service.js';

function fixture() {
  const entries = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      entries.set(key, value);
      return 'OK';
    }),
    getdel: vi.fn(async (key: string) => {
      const value = entries.get(key) ?? null;
      entries.delete(key);
      return value;
    }),
  };
  const uid = 'owner-fixture';
  const user = { status: 'active', sessionsRevokedAfterSec: 0 };
  const admin = {
    active: true,
    role: 'viewer',
    revision: 3,
    verifiedEmail: 'admin@example.test',
  };
  const query = (value: unknown) => ({
    select() {
      return this;
    },
    maxTimeMS() {
      return this;
    },
    lean: vi.fn(async () => value),
  });
  const firebase = {
    verifySignature: vi.fn(async () => ({
      uid,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })),
    getProfile: vi.fn(async () => ({
      uid,
      disabled: false,
      providerData: [],
      tokensValidAfterTime: undefined as string | undefined,
    })),
  };
  const service = new RealtimeAuthService(
    redis as never,
    {
      getOrThrow: () => 'https://app.example.test,https://admin.example.test',
    } as never,
    firebase as never,
    { findOne: () => query(user) } as never,
    { findOne: () => query(admin) } as never,
  );
  const req = {
    headers: { origin: 'https://app.example.test' },
    bearer: 'synthetic-token',
    identity: {
      uid,
      authTimeSec: 1000,
      provider: 'password',
      tokenEmailVerified: true,
    },
    user: { _id: new Types.ObjectId() },
  } as unknown as AuthRequest;
  return { service, redis, entries, firebase, req, user, admin };
}

describe('realtime tickets', () => {
  it('stores a digest and scoped identity, never the Firebase bearer; consumes once', async () => {
    const f = fixture();
    const grant = await f.service.mint(f.req, 'owner');
    expect(grant.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [key, value, expiry, seconds, mode] = f.redis.set.mock
      .calls[0] as unknown as unknown[];
    expect(key).not.toContain(grant.ticket);
    expect(value).not.toContain('synthetic-token');
    expect([expiry, seconds, mode]).toEqual(['EX', 30, 'NX']);
    const principal = await f.service.consume(
      grant.ticket,
      f.req.headers.origin,
    );
    expect(principal.userId).toBe(f.req.user!._id.toHexString());
    expect(principal.audience).toBe('owner');
    await expect(
      f.service.consume(grant.ticket, f.req.headers.origin),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('binds a browser ticket to its exact origin, including absence of Origin', async () => {
    const f = fixture();
    const grant = await f.service.mint(f.req, 'owner');
    await expect(
      f.service.consume(grant.ticket, undefined),
    ).rejects.toMatchObject({ status: 401 });
    for (const origin of ['null', 'https://attacker.example']) {
      f.req.headers.origin = origin;
      await expect(f.service.mint(f.req, 'owner')).rejects.toMatchObject({
        status: 401,
      });
    }
  });

  it('allows native tickets without an Origin but never promotes an owner to admin', async () => {
    const f = fixture();
    delete f.req.headers.origin;
    const grant = await f.service.mint(f.req, 'owner');
    expect((await f.service.consume(grant.ticket, undefined)).audience).toBe(
      'owner',
    );
    await expect(f.service.mint(f.req, 'admin')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rechecks account status and session revocation after a ticket has been issued', async () => {
    const f = fixture();
    const grant = await f.service.mint(f.req, 'owner');
    const principal = await f.service.consume(
      grant.ticket,
      f.req.headers.origin,
    );
    f.user.status = 'deleting';
    await expect(f.service.validate(principal)).rejects.toMatchObject({
      status: 401,
    });
    f.user.status = 'active';
    f.user.sessionsRevokedAfterSec = 1000;
    await expect(f.service.validate(principal)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects expired sessions and Firebase revocation without persisting a token', async () => {
    const f = fixture();
    const grant = await f.service.mint(f.req, 'owner');
    const principal = await f.service.consume(
      grant.ticket,
      f.req.headers.origin,
    );
    f.firebase.getProfile.mockResolvedValue({
      uid: f.req.identity.uid,
      disabled: false,
      providerData: [],
      tokensValidAfterTime: new Date(1001_000).toUTCString(),
    });
    await expect(f.service.validate(principal, true)).rejects.toMatchObject({
      status: 401,
    });
    principal.expiresAt = Date.now() - 1;
    await expect(f.service.validate(principal)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('fences admin role/revision changes even when a socket already exists', async () => {
    const f = fixture();
    await expect(
      f.service.validate({
        audience: 'admin',
        identity: f.req.identity,
        userId: null,
        origin: null,
        expiresAt: Date.now() + 10000,
        admin: {
          uid: f.req.identity.uid,
          role: 'viewer',
          accessRevision: 2,
          verifiedEmail: 'admin@example.test',
          permissions: [],
          authTimeSec: 1000,
        },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
