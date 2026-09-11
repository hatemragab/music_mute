import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { isDuplicateKey, objectId } from '../jobs/job-request.js';
import { AccountRecoveryRequest } from './account-recovery-request.schema.js';
import type { AccountRecoveryRequestDto } from './dto/account-recovery.dto.js';
import { User } from './user.schema.js';
import { accountRecoveryDeadline } from './account-recovery-policy.js';

export function presentAccountRecoveryRequest(
  request: AccountRecoveryRequest,
  now = new Date(),
) {
  return {
    id: request._id.toString(),
    status:
      request.status === 'pending' &&
      request.recoverUntil.getTime() <= now.getTime()
        ? ('expired' as const)
        : request.status,
    reason: request.reason ?? null,
    requestedAt: request.createdAt.toISOString(),
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    reviewReason: request.reviewReason ?? null,
    revision: request.revision ?? 0,
  };
}

@Injectable()
export class AccountRecoveryService implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(AccountRecoveryRequest.name)
    private readonly requests: Model<AccountRecoveryRequest>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.requests.init();
  }

  async status(userId: string, now = new Date()) {
    const user = await this.users.findById(objectId(userId)).lean();
    if (!user) throw authError('UNAUTHENTICATED');
    const request = await this.requests
      .findOne({ userId: user._id })
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    const recoverUntil =
      user.deletionRecoverUntil ??
      (user.status === 'deleting' && user.deletionRequestId
        ? accountRecoveryDeadline(user.deletionRequestedAt ?? now)
        : request?.recoverUntil);
    return {
      accountStatus: user.status,
      deletion: user.deletionRequestId
        ? {
            requestId: user.deletionRequestId,
            requestedAt: user.deletionRequestedAt?.toISOString() ?? null,
            recoverUntil: recoverUntil?.toISOString() ?? null,
            recoveryAvailable:
              user.status === 'deleting' &&
              Boolean(recoverUntil && recoverUntil.getTime() > now.getTime()),
          }
        : null,
      request: request ? presentAccountRecoveryRequest(request, now) : null,
    };
  }

  async request(
    userId: string,
    dto: AccountRecoveryRequestDto,
    now = new Date(),
  ) {
    const id = objectId(userId);
    let retryKey: { userId: typeof id; deletionRequestId: string } | undefined;
    try {
      return await this.transaction(async (session) => {
        const user = await this.users.findById(id).session(session).lean();
        if (!user) throw authError('UNAUTHENTICATED');
        if (
          user.status !== 'deleting' ||
          !user.deletionRequestId ||
          user.deletionLeaseToken
        )
          throw authError('ACCOUNT_RECOVERY_EXPIRED');
        const deletionRequestedAt = user.deletionRequestedAt ?? now;
        const recoverUntil =
          user.deletionRecoverUntil ??
          accountRecoveryDeadline(deletionRequestedAt);
        if (recoverUntil.getTime() <= now.getTime())
          throw authError('ACCOUNT_RECOVERY_EXPIRED');
        const key = {
          userId: user._id,
          deletionRequestId: user.deletionRequestId,
        };
        retryKey = key;

        // This write conflicts with cleanup acquiring the same account. A request
        // can therefore never commit after purge ownership has started.
        const fence = await this.users.updateOne(
          {
            _id: user._id,
            status: 'deleting',
            deletionRequestId: user.deletionRequestId,
            deletionLeaseToken: null,
          },
          {
            $set: {
              deletionRecoverUntil: recoverUntil,
              deletionNextAt: recoverUntil,
            },
            $inc: { accessRevision: 1 },
          },
          { session },
        );
        if (fence.modifiedCount !== 1)
          throw authError('ACCOUNT_RECOVERY_EXPIRED');
        const existing = await this.requests
          .findOne(key)
          .session(session)
          .lean();
        if (existing) return presentAccountRecoveryRequest(existing, now);
        const [created] = await this.requests.create(
          [
            {
              ...key,
              deletionRequestedAt,
              recoverUntil,
              reason: dto.reason ?? null,
            },
          ],
          { session },
        );
        return presentAccountRecoveryRequest(created, now);
      });
    } catch (error) {
      if (!retryKey || !isDuplicateKey(error)) throw error;
      const repeated = await this.requests.findOne(retryKey).lean();
      if (!repeated) throw error;
      return presentAccountRecoveryRequest(repeated, now);
    }
  }

  private async transaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.users.db.startSession();
    try {
      return await session.withTransaction(() => operation(session));
    } finally {
      await session.endSession();
    }
  }
}
