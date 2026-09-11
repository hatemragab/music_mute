import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, Types, type ClientSession, type Model } from 'mongoose';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import { adminError } from '../admin/admin-errors.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import { ProcessingAdmissionFence } from '../admin-settings/processing-settings.schema.js';
import { Job } from '../jobs/job.schema.js';
import { UserIdentityFenceService } from '../users/user-identity-fence.service.js';
import { User } from '../users/user.schema.js';
import type { AdminUserProcessingDto } from './dto/admin-user.dto.js';
import {
  presentAdminUser,
  presentAdminUserDetail,
  type AdminUserView,
} from './admin-users.presenter.js';

const USER_STATUSES = ['active', 'disabled', 'deleting', 'purging'] as const;
const esc = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class AdminUsersService implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(ProcessingAdmissionFence.name)
    private readonly admissionFences: Model<ProcessingAdmissionFence>,
    private readonly identityFences: UserIdentityFenceService,
    private readonly operations: AdminOperationsService,
  ) {}

  async onModuleInit() {
    await this.users.init();
  }

  async list(raw: Record<string, unknown>) {
    const allowed = [
      'query',
      'status',
      'processingSuspended',
      'limit',
      'cursor',
    ];
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
    const search =
      raw.query === undefined
        ? null
        : typeof raw.query === 'string'
          ? raw.query.trim()
          : '';
    if (search !== null && (search.length < 2 || search.length > 100))
      throw adminError('INVALID_REQUEST');
    const status = raw.status === undefined ? null : String(raw.status);
    if (status !== null && !USER_STATUSES.includes(status as never))
      throw adminError('INVALID_REQUEST');
    let suspended: boolean | null = null;
    if (raw.processingSuspended !== undefined) {
      if (
        raw.processingSuspended !== 'true' &&
        raw.processingSuspended !== 'false'
      )
        throw adminError('INVALID_REQUEST');
      suspended = raw.processingSuspended === 'true';
    }
    const scope = operationFingerprint({
      query: search,
      status,
      processingSuspended: suspended,
    });
    const after = this.decodeCursor(raw.cursor, scope);
    const filter: Record<string, unknown> = {
      ...(status ? { status } : {}),
      ...(suspended === null
        ? {}
        : {
            processingSuspended: suspended ? true : trusted({ $ne: true }),
          }),
      ...(after ? { _id: trusted({ $gt: after }) } : {}),
      ...(search
        ? {
            $or: [
              { firebaseUid: search },
              { email: new RegExp(`^${esc(search)}$`, 'i') },
              { displayName: new RegExp(`^${esc(search)}`, 'i') },
            ],
          }
        : {}),
    };
    const records = await this.users
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();
    const items = records.slice(0, limit) as unknown as AdminUserView[];
    return {
      items: items.map(presentAdminUser),
      nextCursor:
        records.length > limit
          ? this.encodeCursor(items.at(-1)!._id, scope)
          : null,
      asOf: new Date().toISOString(),
    };
  }

  async detail(id: string) {
    const objectId = this.objectId(id);
    const user = await this.users
      .findOne({ _id: objectId })
      .maxTimeMS(5000)
      .lean();
    if (!user) throw adminError('RESOURCE_NOT_FOUND');
    const [counts, recent] = await Promise.all([
      this.jobs
        .aggregate<{ _id: string; count: number }>([
          { $match: { userId: objectId, deletedAt: null } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
        .option({ maxTimeMS: 5000 }),
      this.jobs
        .find({ userId: objectId, deletedAt: null })
        .sort({ createdAt: -1, _id: -1 })
        .limit(10)
        .select({ _id: 1 })
        .maxTimeMS(5000)
        .lean(),
    ]);
    return presentAdminUserDetail(
      user as unknown as AdminUserView,
      Object.fromEntries(counts.map((row) => [row._id, row.count])),
      recent.map((job) => job._id.toString()),
    );
  }

  suspend(actor: AdminActor, id: string, dto: AdminUserProcessingDto) {
    return this.change(actor, id, dto, true);
  }
  resume(actor: AdminActor, id: string, dto: AdminUserProcessingDto) {
    return this.change(actor, id, dto, false);
  }

  private async change(
    actor: AdminActor,
    id: string,
    dto: AdminUserProcessingDto,
    suspended: boolean,
  ) {
    const objectId = this.objectId(id);
    const route = suspended
      ? 'POST /admin/users/:id/suspend-processing'
      : 'POST /admin/users/:id/resume-processing';
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route,
        request: { id, expectedRevision: dto.expectedRevision },
        action: suspended
          ? 'users.processing.suspend'
          : 'users.processing.resume',
        resourceType: 'user',
        reason: dto.reason,
      },
      (session) =>
        this.changeInTransaction(actor, objectId, dto, suspended, session),
    );
    return result.value ?? this.summary(id);
  }

  private async changeInTransaction(
    actor: AdminActor,
    id: Types.ObjectId,
    dto: AdminUserProcessingDto,
    suspended: boolean,
    session: ClientSession,
  ) {
    const current = await this.users
      .findOne({ _id: id })
      .session(session)
      .lean();
    if (!current) throw adminError('RESOURCE_NOT_FOUND');
    if ((current.adminRevision ?? 0) !== dto.expectedRevision)
      throw adminError('REVISION_CONFLICT');
    if ((current.processingSuspended === true) === suspended)
      throw adminError('INVALID_REQUEST');
    await this.identityFences.touch(current.firebaseUid, session);
    const fence = await this.admissionFences.updateOne(
      { _id: `user:${id.toHexString()}` },
      { $inc: { revision: 1 } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
    if (!fence.acknowledged) throw adminError('DEPENDENCY_UNAVAILABLE');
    const updated = await this.users
      .findOneAndUpdate(
        {
          _id: id,
          adminRevision:
            dto.expectedRevision === 0
              ? trusted({ $in: [0, null] })
              : dto.expectedRevision,
          firebaseUid: current.firebaseUid,
          status: current.status,
        },
        {
          $set: {
            processingSuspended: suspended,
            processingSuspensionReason: suspended ? dto.reason : null,
            processingSuspendedBy: suspended ? actor.uid : null,
            processingSuspendedAt: suspended ? new Date() : null,
          },
          $inc: { adminRevision: 1 },
        },
        { returnDocument: 'after', runValidators: true, session },
      )
      .lean();
    if (!updated) throw adminError('REVISION_CONFLICT');
    return {
      resourceId: id.toHexString(),
      revision: dto.expectedRevision + 1,
      previousRevision: dto.expectedRevision,
      value: presentAdminUser(updated as unknown as AdminUserView),
    };
  }

  private async summary(id: string) {
    const user = await this.users
      .findOne({ _id: this.objectId(id) })
      .maxTimeMS(5000)
      .lean();
    if (!user) throw adminError('RESOURCE_NOT_FOUND');
    return presentAdminUser(user as unknown as AdminUserView);
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
