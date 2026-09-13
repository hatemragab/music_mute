import type { Types } from 'mongoose';
import type { User } from '../users/user.schema.js';

export type AdminUserView = Pick<
  User,
  | 'email'
  | 'displayName'
  | 'status'
  | 'processingSuspended'
  | 'processingSuspensionReason'
  | 'processingSuspendedBy'
  | 'processingSuspendedAt'
  | 'adminRevision'
  | 'deletionRequestId'
  | 'deletionRequestedAt'
  | 'deletionRecoverUntil'
  | 'deletionPurgeStartedAt'
  | 'createdAt'
  | 'updatedAt'
> &
  Partial<Pick<User, 'processingSuspensionExpiresAt'>> & {
    _id: Types.ObjectId;
  };

export function presentAdminUser(user: AdminUserView) {
  return {
    id: user._id.toString(),
    email: user.email ?? null,
    displayName: user.displayName,
    status: user.status,
    processingSuspended:
      user.processingSuspended === true &&
      (!user.processingSuspensionExpiresAt ||
        user.processingSuspensionExpiresAt.getTime() > Date.now()),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    revision: user.adminRevision ?? 0,
  };
}

export function presentAdminUserDetail(
  user: AdminUserView,
  processingCounts: Record<string, number>,
  recentJobIds: string[],
) {
  return {
    ...presentAdminUser(user),
    processingCounts,
    recentJobIds,
    suspension: {
      expiresAt: user.processingSuspensionExpiresAt?.toISOString() ?? null,
      reason: user.processingSuspensionReason ?? null,
      actorUid: user.processingSuspendedBy ?? null,
      at: user.processingSuspendedAt?.toISOString() ?? null,
    },
    deletion: user.deletionRequestId
      ? {
          requestId: user.deletionRequestId,
          requestedAt: user.deletionRequestedAt?.toISOString() ?? null,
          recoverUntil: user.deletionRecoverUntil?.toISOString() ?? null,
          purgeStartedAt: user.deletionPurgeStartedAt?.toISOString() ?? null,
          recoveryAvailable:
            user.status === 'deleting' &&
            Boolean(
              user.deletionRecoverUntil &&
              user.deletionRecoverUntil.getTime() > Date.now(),
            ),
        }
      : null,
  };
}
