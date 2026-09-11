import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseIdentityService } from './firebase-identity.service.js';
import {
  FirebaseMailService,
  FirebaseMailQuotaError,
} from './firebase-mail.service.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { AuthRateLimitException } from './rate-limit.exception.js';
import { authError } from './auth.errors.js';
import type { RateBucket, VerifiedIdentity } from './auth.types.js';

@Injectable()
export class AuthMailService {
  constructor(
    private readonly firebase: FirebaseIdentityService,
    private readonly mail: FirebaseMailService,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
  ) {}

  async requestVerification(context: {
    identity: VerifiedIdentity;
    bearer: string;
    ip: string;
  }): Promise<{ alreadyVerified: boolean }> {
    const profile = await this.firebase.getProfile(context.identity.uid);
    if (profile.uid !== context.identity.uid)
      throw authError('UNAUTHENTICATED');
    if (profile.disabled) throw authError('ACCOUNT_DISABLED');
    if (context.identity.tokenEmailVerified || profile.emailVerified === true)
      return { alreadyVerified: true };
    if (!profile.email) throw authError('INVALID_INPUT');
    const emailKey = profile.email.trim().toLowerCase();
    const bucket = (
      scope: string,
      identifier: string,
      limit: number,
      windowMs: number,
    ): RateBucket => ({
      key: this.keys.bucket(scope, identifier),
      limit,
      windowMs,
    });
    await this.attempt(
      [
        bucket(
          'verify-uid-cooldown',
          context.identity.uid,
          1,
          this.config.get<number>('VERIFY_COOLDOWN_SECONDS', 60) * 1000,
        ),
        bucket(
          'verify-uid-day',
          context.identity.uid,
          this.config.get<number>('VERIFY_UID_PER_DAY', 3),
          86400000,
        ),
        bucket(
          'verify-email-day',
          emailKey,
          this.config.get<number>('VERIFY_EMAIL_PER_DAY', 3),
          86400000,
        ),
        bucket(
          'verify-ip-hour',
          context.ip,
          this.config.get<number>('VERIFY_IP_PER_HOUR', 10),
          3600000,
        ),
        bucket(
          'verify-project-day',
          'project',
          this.config.get<number>('VERIFY_PROJECT_PER_DAY', 200),
          86400000,
        ),
      ],
      () => this.mail.sendVerification(context.bearer),
    );
    return { alreadyVerified: false };
  }

  async requestPasswordReset(email: string, ip: string): Promise<void> {
    const emailKey = email.trim().toLowerCase();
    const bucket = (
      scope: string,
      identifier: string,
      limit: number,
      windowMs: number,
    ): RateBucket => ({
      key: this.keys.bucket(scope, identifier),
      limit,
      windowMs,
    });
    await this.attempt(
      [
        bucket(
          'reset-email-cooldown',
          emailKey,
          1,
          this.config.get<number>('RESET_COOLDOWN_SECONDS', 60) * 1000,
        ),
        bucket(
          'reset-email-day',
          emailKey,
          this.config.get<number>('RESET_EMAIL_PER_DAY', 3),
          86400000,
        ),
        bucket(
          'reset-ip-hour',
          ip,
          this.config.get<number>('RESET_IP_PER_HOUR', 5),
          3600000,
        ),
        bucket(
          'reset-project-day',
          'project',
          this.config.get<number>('RESET_PROJECT_PER_DAY', 50),
          86400000,
        ),
      ],
      () => this.mail.sendPasswordReset(email),
    );
  }

  private async attempt(
    buckets: RateBucket[],
    send: () => Promise<void>,
  ): Promise<void> {
    const pauseKey = this.keys.bucket('mail-pause', 'project');
    try {
      if (await this.budgets.isPaused(pauseKey))
        throw authError('SERVICE_UNAVAILABLE');
      const decision = await this.budgets.reserve(buckets);
      if (!decision.allowed)
        throw new AuthRateLimitException(decision.retryAfterSeconds);
      await send();
    } catch (error) {
      if (error instanceof FirebaseMailQuotaError) {
        try {
          await this.budgets.pause(pauseKey, 900000);
        } catch {
          /* Storage failure remains fail-closed. */
        }
      }
      if (error instanceof HttpException) throw error;
      throw authError('SERVICE_UNAVAILABLE');
    }
  }
}
