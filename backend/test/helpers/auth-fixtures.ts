import 'reflect-metadata';
import { Controller, Get, Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Types } from 'mongoose';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { InfrastructureModule } from '../../src/infrastructure/infrastructure.module.js';
import { configureHttp } from '../../src/http/configure-http.js';
import { RequireProcessingAccess } from '../../src/auth/auth.decorators.js';
import { FirebaseIdentityService } from '../../src/auth/firebase-identity.service.js';
import { FirebaseMailService } from '../../src/auth/firebase-mail.service.js';
import { RateBudgetService } from '../../src/rate-limits/rate-budget.service.js';
import { SECURITY_REDIS } from '../../src/rate-limits/security-redis.provider.js';
import { RedisThrottlerStorage } from '../../src/rate-limits/redis-throttler.storage.js';
import { UsersService } from '../../src/users/users.service.js';
import { UserIdentityFence } from '../../src/users/user-identity-fence.schema.js';
import { AccountDeletionMaintenanceService } from '../../src/users/account-deletion-maintenance.service.js';
import { AccountRecoveryService } from '../../src/users/account-recovery.service.js';
import { User, type UserDocument } from '../../src/users/user.schema.js';
import { AccountRecoveryRequest } from '../../src/users/account-recovery-request.schema.js';
import { DevicesService } from '../../src/devices/devices.service.js';
import {
  Device,
  type DeviceDocument,
} from '../../src/devices/device.schema.js';
import { DeviceInstallationOwner } from '../../src/devices/device-installation-owner.schema.js';
import { AppPolicy } from '../../src/app-policy/app-policy.schema.js';
import { AppPolicyService } from '../../src/app-policy/app-policy.service.js';
import { defaultPolicy } from '../../src/app-policy/access-policy.js';
import { authError } from '../../src/auth/auth.errors.js';
import { PROCESSING_MODELS } from '../../src/processing/processing-persistence.module.js';
import { AdminAccess } from '../../src/admin/admin-access.schema.js';
import { AdminAuditEvent } from '../../src/admin/admin-audit.schema.js';
import { AdminOperation } from '../../src/admin/admin-operation.schema.js';
import { AdminOwnerFence } from '../../src/admin/admin-owner-fence.schema.js';
import { Release } from '../../src/releases/release.schema.js';
import { ReleaseUpload } from '../../src/releases/release-upload.schema.js';
import { AdminAlert } from '../../src/admin-observability/admin-alert.schema.js';
import { AdminAlertObservation } from '../../src/admin-observability/admin-alert-observation.schema.js';
import { ProcessingAdmissionFence } from '../../src/admin-settings/processing-settings.schema.js';
import {
  AccountPolicy,
  AccountPolicyOverride,
} from '../../src/admin-settings/account-policy.schema.js';
import type {
  DeviceReport,
  VerifiedIdentity,
} from '../../src/auth/auth.types.js';
import { StorageCleanupTask } from '../../src/storage/storage-cleanup-task.schema.js';
import { AbuseEventsService } from '../../src/abuse-protection/abuse-events.service.js';
import { AccountRestrictionsService } from '../../src/abuse-protection/account-restrictions.service.js';

// AppModule's infrastructure is replaced below. Prevent its eager configuration
// import from consulting any developer dotenv file before that override applies.
vi.mock('../../src/config/environment.module.js', async () => {
  const { Module } = await import('@nestjs/common');
  class EnvironmentModule {}
  Module({})(EnvironmentModule);
  return { EnvironmentModule };
});

export const deviceReport = {
  installationId: '0e47b60a-4835-4cc3-a5b9-2d64d48f8c19',
  platform: 'android' as const,
  appVersion: '0.1.0',
  buildNumber: 1,
  metadataRevision: 1,
  osVersion: '16',
  deviceModel: 'Test device',
};
@Controller('processing-probe')
class ProcessingProbeController {
  @Get() @RequireProcessingAccess() run() {
    return { allowed: true };
  }
}

export async function authFixture() {
  const events: string[] = [];
  const ownerId = new Types.ObjectId();
  const otherId = new Types.ObjectId();
  const makeUser = (uid: string, id: Types.ObjectId) =>
    ({
      _id: id,
      firebaseUid: uid,
      displayName: uid,
      email: `${uid}@fixture.invalid`,
      emailVerified: false,
      providerIds: ['password'],
      status: 'active',
      sessionsRevokedAfterSec: 0,
    }) as unknown as UserDocument;
  const records = new Map<string, UserDocument>([
    ['fixture-owner', makeUser('fixture-owner', ownerId)],
    ['fixture-other', makeUser('fixture-other', otherId)],
  ]);
  const installations = new Map<string, DeviceDocument>();
  const state = {
    policy: defaultPolicy(),
    emailVerified: false,
    upstreamDisabled: false,
    authTimeSec: 100,
    ipDenied: false,
    uidDenied: false,
  };
  const identityFor = (token: string): VerifiedIdentity => {
    if (
      ![
        'fixture-owner-token',
        'fixture-other-token',
        'fixture-new-token',
      ].includes(token) ||
      state.upstreamDisabled
    )
      throw authError(
        state.upstreamDisabled ? 'ACCOUNT_DISABLED' : 'UNAUTHENTICATED',
      );
    return {
      uid: token.slice(0, -6),
      authTimeSec: state.authTimeSec,
      provider: 'password',
      tokenEmailVerified: state.emailVerified,
    };
  };
  const firebase = {
    verifySignature: vi.fn(async (token: string) => {
      events.push('signature');
      return { uid: identityFor(token).uid };
    }),
    verifySession: vi.fn(async (token: string) => {
      events.push('revocation');
      return identityFor(token);
    }),
    getProfile: vi.fn(async (uid: string) => ({
      uid,
      email: `${uid}@fixture.invalid`,
      emailVerified: state.emailVerified,
      disabled: state.upstreamDisabled,
      providerData: [{ providerId: 'password' }],
    })),
    revokeSessions: vi.fn().mockResolvedValue(undefined),
  };
  const users = {
    findByFirebaseUid: vi.fn(async (uid: string) => {
      events.push('local-user');
      return records.get(uid) ?? null;
    }),
    provision: vi.fn(async (identity: VerifiedIdentity) => {
      const found =
        records.get(identity.uid) ??
        makeUser(identity.uid, new Types.ObjectId());
      records.set(identity.uid, found);
      return found;
    }),
    syncProfile: vi.fn(async (id: string) => {
      const found = [...records.values()].find(
        (user) => user._id.toString() === id,
      )!;
      found.emailVerified = state.emailVerified;
      return found;
    }),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    setLogoutCutoff: vi.fn(async (id: string, cutoff: number) => {
      const found = [...records.values()].find(
        (user) => user._id.toString() === id,
      )!;
      found.sessionsRevokedAfterSec = Math.max(
        found.sessionsRevokedAfterSec,
        cutoff,
      );
    }),
  };
  const devices = {
    sessionStatuses: vi.fn(async (_userId: string, items: DeviceDocument[]) =>
      items.map(() => 'unknown' as const),
    ),
    hideFromHistory: vi.fn(async () => {}),
    sync: vi.fn(
      async (userId: string, authTimeSec: number, report: DeviceReport) => {
        const key = `${userId}:${report.installationId}`;
        const device = {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(userId),
          ...report,
          lastAuthenticatedAtSec: authTimeSec,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          versionHistory: [],
        } as unknown as DeviceDocument;
        installations.set(key, device);
        return device;
      },
    ),
    findOwned: vi.fn(
      async (userId: string, id: string) =>
        installations.get(`${userId}:${id.toLowerCase()}`) ?? null,
    ),
    listOwned: vi.fn(async (userId: string) => ({
      items: [...installations.values()].filter(
        (device) => device.userId.toString() === userId,
      ),
      nextCursor: null,
    })),
  };
  const budgets = {
    reserve: vi.fn(async () => {
      events.push('uid-budget');
      return {
        allowed: !state.uidDenied,
        retryAfterSeconds: state.uidDenied ? 12 : 0,
      };
    }),
    isPaused: vi.fn().mockResolvedValue(false),
    pause: vi.fn().mockResolvedValue(undefined),
  };
  const mail = {
    sendVerification: vi.fn().mockResolvedValue(undefined),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
  };
  const storage = {
    increment: vi.fn(async () => {
      events.push('ip-limit');
      return {
        totalHits: state.ipDenied ? 1000 : 1,
        timeToExpire: 60,
        isBlocked: state.ipDenied,
        timeToBlockExpire: state.ipDenied ? 60 : 0,
      };
    }),
  };
  const recovery = {
    status: vi.fn(async () => ({
      accountStatus: 'deleting',
      deletion: {
        requestId: 'fixture-deletion-request',
        requestedAt: '2026-09-11T00:00:00.000Z',
        recoverUntil: '2026-09-26T00:00:00.000Z',
        recoveryAvailable: true,
      },
      request: null,
    })),
    request: vi.fn(async (_userId: string, body: { reason?: string }) => ({
      id: 'fixture-recovery-request',
      status: 'pending',
      reason: body.reason ?? null,
      requestedAt: '2026-09-11T01:00:00.000Z',
      reviewedAt: null,
      reviewReason: null,
      revision: 0,
    })),
  };
  @Global()
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [
          () => ({
            APP_ENV: 'test',
            NODE_ENV: 'test',
            FIREBASE_PROJECT_ID: 'demo-musicmute',
            FIREBASE_WEB_API_KEY: 'fixture-key',
            RATE_LIMIT_HASH_SECRET: 'fixture-private-hmac-key-0000000000001',
            RATE_LIMIT: 60,
            RATE_TTL_MS: 60000,
            BODY_LIMIT_BYTES: 65536,
            CORS_ORIGINS: '',
            TRUST_PROXY: 'false',
            REDIS_URL: 'redis://127.0.0.1:1/0',
            AWS_REGION: 'us-east-1',
            S3_BUCKET: 'fixture-bucket',
            AUDIO_PROCESSING_ENABLED: false,
            PROCESSING_URL_SECONDS: 600,
            PROCESSING_OUTPUT_MAX_BYTES: 30_000_000,
          }),
        ],
      }),
    ],
    providers: [
      {
        provide: getConnectionToken(),
        useValue: {
          readyState: 1,
          db: { command: async () => ({ ok: 1 }) },
          models: {},
          model: vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined) })),
        },
      },
    ],
    exports: [getConnectionToken()],
  })
  class FixtureInfrastructure {}
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProcessingProbeController],
  })
    .overrideModule(InfrastructureModule)
    .useModule(FixtureInfrastructure)
    .overrideProvider(FirebaseIdentityService)
    .useValue(firebase)
    .overrideProvider(FirebaseMailService)
    .useValue(mail)
    .overrideProvider(UsersService)
    .useValue(users)
    .overrideProvider(AccountDeletionMaintenanceService)
    .useValue({})
    .overrideProvider(AccountRecoveryService)
    .useValue(recovery)
    .overrideProvider(DevicesService)
    .useValue(devices)
    .overrideProvider(AppPolicyService)
    .useValue({
      current: async () => state.policy,
      assertProcessingTargetAvailable: async () => undefined,
    })
    .overrideProvider(RateBudgetService)
    .useValue(budgets)
    .overrideProvider(AbuseEventsService)
    .useValue({ record: vi.fn().mockResolvedValue(undefined) })
    .overrideProvider(AccountRestrictionsService)
    .useValue({ assertAllowed: vi.fn().mockResolvedValue(undefined) })
    .overrideProvider(RedisThrottlerStorage)
    .useValue(storage)
    .overrideProvider(SECURITY_REDIS)
    .useValue({
      ping: async () => 'PONG',
      disconnect: () => undefined,
      quit: async () => undefined,
    });
  for (const name of [
    User.name,
    UserIdentityFence.name,
    AccountRecoveryRequest.name,
    Device.name,
    DeviceInstallationOwner.name,
    AppPolicy.name,
    AdminAccess.name,
    AdminAuditEvent.name,
    AdminOperation.name,
    AdminOwnerFence.name,
    Release.name,
    ReleaseUpload.name,
    AdminAlert.name,
    AdminAlertObservation.name,
    AccountPolicy.name,
    AccountPolicyOverride.name,
    ProcessingAdmissionFence.name,
    StorageCleanupTask.name,
    ...PROCESSING_MODELS.map(({ name }) => name),
  ])
    builder.overrideProvider(getModelToken(name)).useValue({
      init: vi.fn().mockResolvedValue(undefined),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    });
  const module = await builder.compile();
  const app = module.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureHttp(app);
  await app.init();
  return {
    app,
    events,
    state,
    firebase,
    users,
    devices,
    budgets,
    mail,
    storage,
    recovery,
    records,
    installations,
    ownerId,
    otherId,
  };
}
