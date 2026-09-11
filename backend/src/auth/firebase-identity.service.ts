import { Inject, Injectable } from '@nestjs/common';
import type { Auth, DecodedIdToken, UserRecord } from 'firebase-admin/auth';
import { authError, type AuthErrorCode } from './auth.errors.js';
import { isEmailVerifiedForSignInProvider } from './email-verification.js';
import type { SupportedProvider, VerifiedIdentity } from './auth.types.js';

export const FIREBASE_AUTH = Symbol('FIREBASE_AUTH');
export const FIREBASE_OPERATION_TIMEOUT_MS = 5000;

const supportedProviders: readonly SupportedProvider[] = [
  'password',
  'google.com',
  'apple.com',
];

const firebaseErrorCodes: Readonly<Record<string, AuthErrorCode>> = {
  'auth/argument-error': 'UNAUTHENTICATED',
  'auth/id-token-expired': 'UNAUTHENTICATED',
  'auth/id-token-revoked': 'UNAUTHENTICATED',
  'auth/invalid-argument': 'UNAUTHENTICATED',
  'auth/invalid-id-token': 'UNAUTHENTICATED',
  'auth/invalid-uid': 'UNAUTHENTICATED',
  'auth/user-not-found': 'UNAUTHENTICATED',
  'auth/user-disabled': 'ACCOUNT_DISABLED',
  'app/network-error': 'SERVICE_UNAVAILABLE',
  'auth/certificate-fetch-failed': 'SERVICE_UNAVAILABLE',
  'auth/internal-error': 'SERVICE_UNAVAILABLE',
  'auth/network-request-failed': 'SERVICE_UNAVAILABLE',
};

@Injectable()
export class FirebaseIdentityService {
  constructor(@Inject(FIREBASE_AUTH) private readonly auth: Auth) {}

  verifySignature(token: string): Promise<DecodedIdToken> {
    return this.callFirebase(() => this.auth.verifyIdToken(token, false));
  }

  async verifySession(token: string): Promise<VerifiedIdentity> {
    const decoded = await this.callFirebase(() =>
      this.auth.verifyIdToken(token, true),
    );
    const provider = decoded.firebase.sign_in_provider;
    if (!supportedProviders.includes(provider as SupportedProvider))
      throw authError('UNAUTHENTICATED');
    return {
      uid: decoded.uid,
      authTimeSec: decoded.auth_time,
      provider: provider as SupportedProvider,
      tokenEmailVerified: isEmailVerifiedForSignInProvider(
        decoded.email_verified === true,
        provider as SupportedProvider,
      ),
    };
  }

  getProfile(uid: string): Promise<UserRecord> {
    return this.callFirebase(() => this.auth.getUser(uid));
  }

  getProfileByEmail(email: string): Promise<UserRecord> {
    return this.callFirebase(() => this.auth.getUserByEmail(email));
  }

  revokeSessions(uid: string): Promise<void> {
    return this.callFirebase(() => this.auth.revokeRefreshTokens(uid));
  }

  private async callFirebase<T>(operation: () => Promise<T>): Promise<T> {
    let deadline: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(authError('SERVICE_UNAVAILABLE')),
          FIREBASE_OPERATION_TIMEOUT_MS,
        );
      });
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : '';
      throw authError(firebaseErrorCodes[code] ?? 'SERVICE_UNAVAILABLE');
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}
