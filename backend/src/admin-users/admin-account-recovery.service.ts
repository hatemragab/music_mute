import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, Types, type ClientSession, type Model } from 'mongoose';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import { adminError } from '../admin/admin-errors.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import {
  AccountRecoveryRequest,
  type AccountRecoveryRequestStatus,
} from '../users/account-recovery-request.schema.js';
import { presentAccountRecoveryRequest } from '../users/account-recovery.service.js';
import { UserIdentityFenceService } from '../users/user-identity-fence.service.js';
import { User } from '../users/user.schema.js';
import type { AdminAccountRecoveryDecisionDto } from './dto/admin-account-recovery.dto.js';

const STATUSES: readonly AccountRecoveryRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
  'expired',
];

@Injectable()
export class AdminAccountRecoveryService implements OnModuleInit {
  constructor(
    @InjectModel(AccountRecoveryRequest.name)
    private readonly requests: Model<AccountRecoveryRequest>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly identities: UserIdentityFenceService,
    private readonly operations: AdminOperationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.requests.init();
  }

  async list(raw: Record<string, unknown>, now = new Date()) {
    const allowed = ['status', 'limit', 'cursor'];
    if (Object.keys(raw).some((key) => !allowed.includes(key)))
      throw adminError('INVALID_REQUEST');
    const limit = raw.limit === undefined ? 25 : Number(raw.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (raw.limit !== undefined && !/^\d{1,3}$/.test(String(raw.limit)))
    )
      throw adminError('INVALID_REQUEST');
    const rawStatus = raw.status === undefined ? 'pending' : String(raw.status);
    if (rawStatus !== 'all' && !STATUSES.includes(rawStatus as never))
      throw adminError('INVALID_REQUEST');
    const status = rawStatus as AccountRecoveryRequestStatus | 'all';
    const scope = operationFingerprint({ status });
    const after = this.decodeCursor(raw.cursor, scope);
    const statusFilter =
      status === 'all'
        ? {}
        : status === 'pending'
          ? {
              status: 'pending' as const,
              recoverUntil: trusted({ $gt: now }),
            }
          : status === 'expired'
            ? {
                $or: [
                  { status: 'expired' as const },
                  {
                    status: 'pending' as const,
                    recoverUntil: trusted({ $lte: now }),
                  },
                ],
              }
            : { status };
    const records = await this.requests
      .find({
        ...statusFilter,
        ...(after ? { _id: trusted({ $gt: after }) } : {}),
      })
      .sort({ _id: 1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();
    const page = records.slice(0, limit);
    const users = await this.users
      .find({ _id: trusted({ $in: page.map((request) => request.userId) }) })
      .select({ email: 1, displayName: 1, status: 1 })
      .maxTimeMS(5000)
      .lean();
    const byId = new Map(users.map((user) => [user._id.toString(), user]));
    return {
      items: page.map((request) =>
        this.present(request, byId.get(request.userId.toString()) ?? null, now),
      ),
      nextCursor:
        records.length > limit
          ? this.encodeCursor(page.at(-1)!._id, scope)
          : null,
      asOf: now.toISOString(),
    };
  }

  async summary(now = new Date()) {
    const active = {
      status: 'pending' as const,
      recoverUntil: trusted({ $gt: now }),
    };
    const [pendingCount, oldest] = await Promise.all([
      this.requests.countDocuments(active).maxTimeMS(5000),
      this.requests
        .findOne(active)
        .sort({ createdAt: 1, _id: 1 })
        .select({ createdAt: 1 })
        .maxTimeMS(5000)
        .lean(),
    ]);
    return {
      pendingCount,
      oldestRequestedAt: oldest?.createdAt.toISOString() ?? null,
      highPriority: pendingCount > 0,
      asOf: now.toISOString(),
    };
  }

  async detail(id: string, now = new Date()) {
    const request = await this.requests
      .findById(this.objectId(id))
      .maxTimeMS(5000)
      .lean();
    if (!request) throw adminError('RESOURCE_NOT_FOUND');
    const user = await this.users.findById(request.userId).lean();
    return this.present(request, user, now);
  }

  async decide(
    actor: AdminActor,
    id: string,
    dto: AdminAccountRecoveryDecisionDto,
    approve: boolean,
  ) {
    const requestId = this.objectId(id);
    const action = approve ? 'approve' : 'reject';
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: `POST /admin/account-recovery-requests/:id/${action}`,
        request: { id, expectedRevision: dto.expectedRevision },
        action: `users.account-recovery.${action}`,
        resourceType: 'account_recovery_request',
        reason: dto.reason,
      },
      (session) =>
        this.decideInTransaction(actor, requestId, dto, approve, session),
    );
    return result.value ?? this.detail(id);
  }

  private async decideInTransaction(
    actor: AdminActor,
    id: Types.ObjectId,
    dto: AdminAccountRecoveryDecisionDto,
    approve: boolean,
    session: ClientSession,
  ) {
    const request = await this.requests.findById(id).session(session).lean();
    if (!request) throw adminError('RESOURCE_NOT_FOUND');
    if (request.status !== 'pending') throw adminError('INVALID_REQUEST');
    if ((request.revision ?? 0) !== dto.expectedRevision)
      throw adminError('REVISION_CONFLICT');
    const user = await this.users
      .findById(request.userId)
      .session(session)
      .lean();
    if (!user) throw adminError('RESOURCE_NOT_FOUND');

    let updatedUser = user;
    if (approve) {
      if (
        user.status !== 'deleting' ||
        user.deletionRequestId !== request.deletionRequestId ||
        !user.deletionRecoverUntil ||
        user.deletionRecoverUntil.getTime() <= Date.now() ||
        user.deletionLeaseToken
      )
        throw adminError('INVALID_REQUEST');
      await this.identities.unblock(user.firebaseUid, session);
      const recovered = await this.users
        .findOneAndUpdate(
          {
            _id: user._id,
            status: 'deleting',
            deletionRequestId: request.deletionRequestId,
            deletionLeaseToken: null,
          },
          {
            $set: {
              status: 'active',
              deletionRequestId: null,
              deletionRequestedAt: null,
              deletionRecoverUntil: null,
              deletionPurgeStartedAt: null,
              deletionNextAt: null,
              deletionLeaseUntil: null,
              deletionLeaseToken: null,
            },
            $inc: { adminRevision: 1 },
          },
          { returnDocument: 'after', runValidators: true, session },
        )
        .lean();
      if (!recovered) throw adminError('REVISION_CONFLICT');
      updatedUser = recovered;
    }

    const updated = await this.requests
      .findOneAndUpdate(
        { _id: id, status: 'pending', revision: dto.expectedRevision },
        {
          $set: {
            status: approve ? 'approved' : 'rejected',
            reviewedBy: actor.uid,
            reviewedAt: new Date(),
            reviewReason: dto.reason,
          },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after', runValidators: true, session },
      )
      .lean();
    if (!updated) throw adminError('REVISION_CONFLICT');
    return {
      resourceId: id.toHexString(),
      revision: dto.expectedRevision + 1,
      previousRevision: dto.expectedRevision,
      value: this.present(updated, updatedUser),
    };
  }

  private present(
    request: AccountRecoveryRequest,
    user: User | null,
    now = new Date(),
  ) {
    return {
      ...presentAccountRecoveryRequest(request, now),
      deletionRequestId: request.deletionRequestId,
      deletionRequestedAt: request.deletionRequestedAt.toISOString(),
      recoverUntil: request.recoverUntil.toISOString(),
      user: {
        id: request.userId.toString(),
        email: user?.email ?? null,
        displayName: user?.displayName ?? null,
        status: user?.status ?? null,
      },
    };
  }

  private objectId(value: string) {
    if (!/^[a-f0-9]{24}$/.test(value) || !Types.ObjectId.isValid(value))
      throw adminError('RESOURCE_NOT_FOUND');
    return new Types.ObjectId(value);
  }

  private encodeCursor(id: Types.ObjectId, scope: string) {
    return Buffer.from(
      JSON.stringify({ id: id.toHexString(), scope }),
    ).toString('base64url');
  }

  private decodeCursor(
    raw: unknown,
    scope: string,
  ): Types.ObjectId | undefined {
    if (raw === undefined) return undefined;
    try {
      if (
        typeof raw !== 'string' ||
        raw.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(raw)
      )
        throw new Error();
      const text = Buffer.from(raw, 'base64url').toString('utf8');
      if (Buffer.from(text).toString('base64url') !== raw) throw new Error();
      const decoded = JSON.parse(text) as Record<string, unknown>;
      if (
        !decoded ||
        Array.isArray(decoded) ||
        Object.keys(decoded).sort().join(',') !== 'id,scope' ||
        decoded.scope !== scope ||
        typeof decoded.id !== 'string' ||
        !/^[a-f0-9]{24}$/.test(decoded.id)
      )
        throw new Error();
      return new Types.ObjectId(decoded.id);
    } catch {
      throw adminError('INVALID_CURSOR');
    }
  }
}
