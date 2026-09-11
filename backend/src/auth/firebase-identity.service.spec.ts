import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import type { Auth, DecodedIdToken, UserRecord } from 'firebase-admin/auth';
import { generateKeyPairSync } from 'node:crypto';
import { FirebaseIdentityService } from './firebase-identity.service.js';
import { FirebaseModule } from './firebase.module.js';

const decodedToken = (
  overrides: Partial<DecodedIdToken> = {},
): DecodedIdToken => ({
  aud: 'demo-musicmute',
  auth_time: 1_700_000_000,
  exp: 1_700_003_600,
  firebase: {
    identities: {},
    sign_in_provider: 'password',
  },
  iat: 1_700_000_000,
  iss: 'https://securetoken.google.com/demo-musicmute',
  sub: 'fixture-user',
  uid: 'fixture-user',
  ...overrides,
});

const firebaseError = (code: string): Error & { code: string } =>
  Object.assign(new Error('sensitive upstream detail'), { code });

async function expectPublicError(
  operation: Promise<unknown>,
  expected: { statusCode: number; code: string; message: string },
): Promise<void> {
  try {
    await operation;
    throw new Error('Expected operation to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(expected.statusCode);
    expect(exception.getResponse()).toEqual(expected);
    expect(JSON.stringify(exception.getResponse())).not.toContain(
      'sensitive upstream detail',
    );
  }
}

describe('FirebaseIdentityService', () => {
  const verifyIdToken = vi.fn<Auth['verifyIdToken']>();
  const getUser = vi.fn<Auth['getUser']>();
  const revokeRefreshTokens = vi.fn<Auth['revokeRefreshTokens']>();
  const sdk = {
    verifyIdToken,
    getUser,
    revokeRefreshTokens,
  } as Pick<Auth, 'verifyIdToken' | 'getUser' | 'revokeRefreshTokens'>;
  const service = new FirebaseIdentityService(sdk as Auth);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies a token signature without a revocation lookup', async () => {
    const decoded = decodedToken();
    verifyIdToken.mockResolvedValue(decoded);

    await expect(service.verifySignature('fixture-token')).resolves.toBe(
      decoded,
    );
    expect(verifyIdToken).toHaveBeenCalledWith('fixture-token', false);
  });

  it('checks revocation and returns only verified identity fields', async () => {
    verifyIdToken.mockResolvedValue(
      decodedToken({
        email_verified: false,
        firebase: { sign_in_provider: 'password', identities: {} },
      }),
    );

    await expect(service.verifySession('fixture-token')).resolves.toEqual({
      uid: 'fixture-user',
      authTimeSec: 1_700_000_000,
      provider: 'password',
      tokenEmailVerified: false,
    });
    expect(verifyIdToken).toHaveBeenCalledWith('fixture-token', true);
  });

  it.each(['google.com', 'apple.com'] as const)(
    'treats a %s session as email verified even when the Firebase claim is false',
    async (provider) => {
      verifyIdToken.mockResolvedValue(
        decodedToken({
          email_verified: false,
          firebase: { sign_in_provider: provider, identities: {} },
        }),
      );

      await expect(service.verifySession('fixture-token')).resolves.toEqual({
        uid: 'fixture-user',
        authTimeSec: 1_700_000_000,
        provider,
        tokenEmailVerified: true,
      });
    },
  );

  it.each([
    ['expired', 'auth/id-token-expired'],
    ['revoked', 'auth/id-token-revoked'],
    ['malformed', 'auth/invalid-id-token'],
    ['wrong-project', 'auth/argument-error'],
  ])('maps a %s token to the generic authentication error', async (_, code) => {
    verifyIdToken.mockRejectedValue(firebaseError(code));

    await expectPublicError(service.verifySession('fixture-token'), {
      statusCode: HttpStatus.UNAUTHORIZED,
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });

  it('maps a disabled Firebase user to the public account-disabled error', async () => {
    verifyIdToken.mockRejectedValue(firebaseError('auth/user-disabled'));

    await expectPublicError(service.verifySession('fixture-token'), {
      statusCode: HttpStatus.FORBIDDEN,
      code: 'ACCOUNT_DISABLED',
      message: 'Account disabled',
    });
  });

  it('rejects unsupported sign-in providers', async () => {
    verifyIdToken.mockResolvedValue(
      decodedToken({
        firebase: { sign_in_provider: 'anonymous', identities: {} },
      }),
    );

    await expectPublicError(service.verifySession('fixture-token'), {
      statusCode: HttpStatus.UNAUTHORIZED,
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });

  it('maps Firebase certificate-fetch failures to service unavailable', async () => {
    verifyIdToken.mockRejectedValue(
      firebaseError('auth/certificate-fetch-failed'),
    );

    await expectPublicError(service.verifySession('fixture-token'), {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
    });
  });

  it('treats unknown SDK failures as unavailable rather than invalid identity', async () => {
    verifyIdToken.mockRejectedValue(firebaseError('auth/internal-error'));

    await expectPublicError(service.verifySession('fixture-token'), {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
    });
  });

  it('returns the Firebase profile for an already verified UID', async () => {
    const profile = { uid: 'fixture-user' } as UserRecord;
    getUser.mockResolvedValue(profile);

    await expect(service.getProfile('fixture-user')).resolves.toBe(profile);
  });

  it('revokes all Firebase sessions for the verified UID', async () => {
    revokeRefreshTokens.mockResolvedValue(undefined);

    await expect(
      service.revokeSessions('fixture-user'),
    ).resolves.toBeUndefined();
    expect(revokeRefreshTokens).toHaveBeenCalledWith('fixture-user');
  });

  it('fails a never-settling Firebase operation after five seconds', async () => {
    vi.useFakeTimers();
    verifyIdToken.mockReturnValue(new Promise(() => undefined));
    const outcome = expectPublicError(service.verifySession('fixture-token'), {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
    });

    await vi.advanceTimersByTimeAsync(5000);

    await outcome;
    expect(verifyIdToken).toHaveBeenCalledOnce();
    expect(verifyIdToken).toHaveBeenCalledWith('fixture-token', true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline when a delayed operation completes', async () => {
    vi.useFakeTimers();
    verifyIdToken.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(decodedToken()), 1000),
        ),
    );
    const outcome = service.verifySession('fixture-token');

    await vi.advanceTimersByTimeAsync(1000);

    await expect(outcome).resolves.toMatchObject({ uid: 'fixture-user' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry or leak a late rejection after revocation times out', async () => {
    vi.useFakeTimers();
    let rejectOperation!: (error: Error) => void;
    revokeRefreshTokens.mockReturnValue(
      new Promise((_, reject) => {
        rejectOperation = reject;
      }),
    );
    const outcome = expectPublicError(service.revokeSessions('fixture-user'), {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
    });

    await vi.advanceTimersByTimeAsync(5000);
    await outcome;
    rejectOperation(firebaseError('auth/internal-error'));
    await Promise.resolve();

    expect(revokeRefreshTokens).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('FirebaseModule lifecycle', () => {
  const appName = 'musicmute-auth';

  async function removeFixtureApp(): Promise<void> {
    await Promise.all(
      getApps()
        .filter((app) => app.name === appName)
        .map((app) => deleteApp(app)),
    );
  }

  beforeEach(removeFixtureApp);
  afterEach(removeFixtureApp);

  it('rejects a cached named app configured for another project', async () => {
    initializeApp({ projectId: 'demo-other' }, appName);

    await expect(
      Test.createTestingModule({ imports: [FirebaseModule] })
        .overrideProvider(ConfigService)
        .useValue({
          get: () => undefined,
          getOrThrow: () => 'demo-musicmute',
        })
        .compile(),
    ).rejects.toThrow(
      'Existing Firebase Admin app project does not match FIREBASE_PROJECT_ID',
    );
  });

  it('deletes the Firebase Admin app it owns when the Nest context closes', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FirebaseModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: () => undefined,
        getOrThrow: () => 'demo-musicmute',
      })
      .compile();

    expect(getApps().filter((app) => app.name === appName)).toHaveLength(1);
    await moduleRef.close();
    expect(getApps().filter((app) => app.name === appName)).toHaveLength(0);
  });

  it('initializes Firebase Admin from a CapRover base64 service account', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const encodedServiceAccount = Buffer.from(
      JSON.stringify({
        project_id: 'demo-musicmute',
        client_email: 'firebase-admin@example.iam.gserviceaccount.com',
        private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      }),
      'utf8',
    ).toString('base64');
    const moduleRef = await Test.createTestingModule({
      imports: [FirebaseModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string) =>
          key === 'FIREBASE_SERVICE_ACCOUNT_BASE64'
            ? encodedServiceAccount
            : undefined,
        getOrThrow: () => 'demo-musicmute',
      })
      .compile();

    expect(getApps().filter((app) => app.name === appName)).toHaveLength(1);
    await moduleRef.close();
  });
});
