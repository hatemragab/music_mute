import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, Types, type Model } from 'mongoose';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { AccountPolicyService } from '../admin-settings/account-policy.service.js';
import { Job } from '../jobs/job.schema.js';
import { User } from '../users/user.schema.js';
import type {
  DeleteAccountPolicyOverrideDto,
  PutAccountPolicyOverrideDto,
} from '../admin-settings/dto/account-policy.dto.js';
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
    private readonly usage: ProcessingUsageService,
    private readonly policies: AccountPolicyService,
  ) {}

  async onModuleInit() {
    await this.users.init();
  }

  async list(raw: Record<string, unknown>) {
    const allowed = ['query', 'status', 'limit', 'cursor'];
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
    const scope = operationFingerprint({
      query: search,
      status,
    });
    const after = this.decodeCursor(raw.cursor, scope);
    const filter: Record<string, unknown> = {
      ...(status ? { status } : {}),
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

  async accountUsage(id: string) {
    const owner = this.objectId(id);
    if (!(await this.users.exists({ _id: owner })))
      throw adminError('RESOURCE_NOT_FOUND');
    return {
      ...(await this.usage.readUsage(owner)),
      policyOverride: await this.policies.currentOverride(owner),
    };
  }

  async putPolicyOverride(
    actor: AdminActor,
    id: string,
    dto: PutAccountPolicyOverrideDto,
  ) {
    await this.policies.putOverride(actor, this.objectId(id), dto);
    return this.accountUsage(id);
  }

  async deletePolicyOverride(
    actor: AdminActor,
    id: string,
    dto: DeleteAccountPolicyOverrideDto,
  ) {
    await this.policies.deleteOverride(actor, this.objectId(id), dto);
    return this.accountUsage(id);
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
