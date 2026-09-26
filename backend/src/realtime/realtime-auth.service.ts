import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Model } from 'mongoose';
import { AdminAccess } from '../admin/admin-access.schema.js';
import { isAdminRole, permissionsForRole } from '../admin/admin-permissions.js';
import type { AdminActor } from '../admin/admin.types.js';
import { authError } from '../auth/auth.errors.js';
import type { AuthRequest } from '../auth/auth-request.js';
import type { VerifiedIdentity } from '../auth/auth.types.js';
import { FirebaseIdentityService } from '../auth/firebase-identity.service.js';
import { SECURITY_REDIS } from '../rate-limits/security-redis.provider.js';
import { User } from '../users/user.schema.js';

export const REALTIME_PATH = '/realtime/socket';
export const REALTIME_PROTOCOL = 'musicmute.realtime.v1';
const TICKET_PREFIX = 'musicmute:realtime-ticket:v1:';

export interface RealtimePrincipal {
  audience: 'owner' | 'admin';
  identity: VerifiedIdentity;
  userId: string | null;
  admin: AdminActor | null;
  origin: string | null;
  expiresAt: number;
}

@Injectable()
export class RealtimeAuthService {
  constructor(
    @Inject(SECURITY_REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly firebase: FirebaseIdentityService,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(AdminAccess.name) private readonly admins: Model<AdminAccess>,
  ) {}

  async mint(req: AuthRequest, audience: RealtimePrincipal['audience']) {
    const origin = req.headers.origin ?? null;
    this.assertOrigin(origin);
    if (!req.identity || (audience === 'owner' ? !req.user : !req.adminActor))
      throw authError('UNAUTHENTICATED');
    const signed = await this.firebase.verifySignature(req.bearer);
    if (signed.uid !== req.identity.uid || !Number.isFinite(signed.exp))
      throw authError('UNAUTHENTICATED');
    const principal: RealtimePrincipal = {
      audience,
      identity: req.identity,
      userId: audience === 'owner' ? req.user!._id.toHexString() : null,
      admin: audience === 'admin' ? req.adminActor! : null,
      origin,
      expiresAt: Math.min(signed.exp * 1000, Date.now() + 15 * 60_000),
    };
    if (principal.expiresAt <= Date.now()) throw authError('UNAUTHENTICATED');
    const ticket = randomBytes(32).toString('base64url');
    const result = await this.redis.set(
      ticketKey(ticket),
      JSON.stringify(principal),
      'EX',
      30,
      'NX',
    );
    if (result !== 'OK') throw authError('SERVICE_UNAVAILABLE');
    return {
      ticket,
      path: REALTIME_PATH,
      protocol: REALTIME_PROTOCOL,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }

  async consume(
    ticket: string,
    origin: string | undefined,
  ): Promise<RealtimePrincipal> {
    this.assertOrigin(origin ?? null);
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw authError('UNAUTHENTICATED');
    const stored = await this.redis.getdel(ticketKey(ticket));
    if (!stored) throw authError('UNAUTHENTICATED');
    let principal: RealtimePrincipal;
    try {
      principal = JSON.parse(stored) as RealtimePrincipal;
      if (
        !principal ||
        !['owner', 'admin'].includes(principal.audience) ||
        typeof principal.identity?.uid !== 'string' ||
        !Number.isFinite(principal.identity.authTimeSec) ||
        !Number.isFinite(principal.expiresAt) ||
        principal.origin !== (origin ?? null)
      )
        throw new Error();
    } catch {
      throw authError('UNAUTHENTICATED');
    }
    await this.validate(principal, true);
    return principal;
  }

  /** Recheck before snapshots; refresh Firebase on connect and the session heartbeat. */
  async validate(
    principal: RealtimePrincipal,
    refreshFirebase = false,
  ): Promise<void> {
    if (Date.now() >= principal.expiresAt) throw authError('UNAUTHENTICATED');
    if (refreshFirebase) {
      const profile = await this.firebase.getProfile(principal.identity.uid);
      const revokedAt = profile.tokensValidAfterTime
        ? Date.parse(profile.tokensValidAfterTime) / 1000
        : 0;
      if (
        profile.disabled ||
        profile.uid !== principal.identity.uid ||
        !Number.isFinite(revokedAt) ||
        principal.identity.authTimeSec < revokedAt
      )
        throw authError('UNAUTHENTICATED');
      if (
        principal.audience === 'admin' &&
        (principal.identity.provider !== 'google.com' ||
          !principal.identity.tokenEmailVerified ||
          !principal.admin ||
          profile.email?.trim().toLowerCase() !==
            principal.admin.verifiedEmail ||
          !profile.providerData.some(
            (provider) =>
              provider.providerId === 'google.com' &&
              provider.email?.trim().toLowerCase() ===
                principal.admin!.verifiedEmail,
          ))
      )
        throw authError('UNAUTHENTICATED');
    }
    if (principal.audience === 'owner') {
      if (!principal.userId || !/^[a-f0-9]{24}$/.test(principal.userId))
        throw authError('UNAUTHENTICATED');
      const user = await this.users
        .findOne({
          _id: principal.userId,
          firebaseUid: principal.identity.uid,
        })
        .select('status sessionsRevokedAfterSec')
        .maxTimeMS(2000)
        .lean();
      if (
        !user ||
        user.status !== 'active' ||
        principal.identity.authTimeSec <= user.sessionsRevokedAfterSec
      )
        throw authError('UNAUTHENTICATED');
    } else {
      const access = await this.admins
        .findOne({ uid: principal.identity.uid })
        .maxTimeMS(2000)
        .lean();
      if (
        !principal.admin ||
        !access?.active ||
        !isAdminRole(access.role) ||
        access.revision !== principal.admin.accessRevision ||
        access.role !== principal.admin.role ||
        access.verifiedEmail.trim().toLowerCase() !==
          principal.admin.verifiedEmail
      )
        throw authError('UNAUTHENTICATED');
      principal.admin.permissions = permissionsForRole(access.role);
    }
  }

  private assertOrigin(origin: string | null): void {
    if (origin === null) return;
    const allowed = this.config
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .filter(Boolean);
    if (origin === 'null' || !allowed.includes(origin))
      throw authError('UNAUTHENTICATED');
  }
}

function ticketKey(ticket: string): string {
  return `${TICKET_PREFIX}${createHash('sha256').update(ticket).digest('hex')}`;
}
