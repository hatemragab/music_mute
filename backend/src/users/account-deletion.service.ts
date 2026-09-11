import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { authError } from '../auth/auth.errors.js';
import { objectId } from '../jobs/job-request.js';
import { User } from './user.schema.js';
import { UserIdentityFenceService } from './user-identity-fence.service.js';
import { accountRecoveryDeadline } from './account-recovery-policy.js';

@Injectable()
export class AccountDeletionService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly identities: UserIdentityFenceService,
  ) {}

  async requestDeletion(userId: string, authTimeSec: number, now = new Date()) {
    const age = Math.floor(now.getTime() / 1000) - authTimeSec;
    if (
      !Number.isSafeInteger(authTimeSec) ||
      authTimeSec <= 0 ||
      age < 0 ||
      age > 300
    )
      throw authError('REAUTHENTICATION_REQUIRED');
    return this.accept(userId, undefined, false, now);
  }

  /** Operator-only entry point after independent ownership verification; never expose as a public route. */
  async requestVerifiedDeletion(
    userId: string,
    expectedFirebaseUid: string,
    now = new Date(),
  ) {
    if (!expectedFirebaseUid || expectedFirebaseUid.length > 128)
      throw authError('INVALID_INPUT');
    return this.accept(userId, expectedFirebaseUid, true, now);
  }

  private async accept(
    userId: string,
    expectedFirebaseUid: string | undefined,
    allowDisabled: boolean,
    now: Date,
  ) {
    const id = objectId(userId);
    const existing = await this.users.findById(id).exec();
    if (!existing) throw authError('UNAUTHENTICATED');
    if (
      expectedFirebaseUid !== undefined &&
      expectedFirebaseUid !== existing.firebaseUid
    )
      throw authError('INVALID_INPUT');
    if (existing.status === 'deleting' && existing.deletionRequestId)
      return {
        requestId: existing.deletionRequestId,
        status: 'accepted' as const,
        recoverUntil: (
          existing.deletionRecoverUntil ??
          accountRecoveryDeadline(existing.deletionRequestedAt ?? now)
        ).toISOString(),
      };
    if (
      existing.status !== 'active' &&
      !(allowDisabled && existing.status === 'disabled')
    )
      throw authError('ACCOUNT_DISABLED');
    const user = await this.identities.withDeletion(
      existing.firebaseUid,
      async (session) => {
        const recoverUntil = accountRecoveryDeadline(now);
        const updated = await this.users
          .findOneAndUpdate(
            {
              _id: id,
              status: existing.status,
              firebaseUid: existing.firebaseUid,
            },
            {
              $set: {
                status: 'deleting',
                deletionRequestId: randomUUID(),
                deletionRequestedAt: now,
                deletionRecoverUntil: recoverUntil,
                deletionPurgeStartedAt: null,
                deletionNextAt: recoverUntil,
                deletionLeaseUntil: null,
                deletionLeaseToken: null,
              },
            },
            { returnDocument: 'after', runValidators: true, session },
          )
          .exec();
        if (updated) return updated;
        const query = this.users.findById(id);
        if (session) query.session(session);
        const repeated = await query.exec();
        if (repeated?.status === 'deleting' && repeated.deletionRequestId)
          return repeated;
        throw authError('ACCOUNT_DISABLED');
      },
    );
    if (!user) throw authError('UNAUTHENTICATED');
    if (user.status !== 'deleting' || !user.deletionRequestId)
      throw authError('ACCOUNT_DISABLED');
    const recoverUntil =
      user.deletionRecoverUntil ??
      accountRecoveryDeadline(user.deletionRequestedAt ?? now);
    return {
      requestId: user.deletionRequestId,
      status: 'accepted' as const,
      recoverUntil: recoverUntil.toISOString(),
    };
  }
}
