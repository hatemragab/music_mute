import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type Model } from 'mongoose';
import { FirebaseIdentityService } from '../auth/firebase-identity.service.js';
import { AdminAccess } from './admin-access.schema.js';
import { operationFingerprint } from './admin-audit-query.js';
import { adminError } from './admin-errors.js';
import { AdminOperationsService } from './admin-operations.service.js';
import { AdminOwnerFence } from './admin-owner-fence.schema.js';
import type { AdminActor } from './admin.types.js';
import type {
  CreateAdminAccessDto,
  UpdateAdminAccessDto,
} from './dto/admin-access.dto.js';

type AccessView = Pick<
  AdminAccess,
  | 'uid'
  | 'verifiedEmail'
  | 'role'
  | 'active'
  | 'revision'
  | 'createdAt'
  | 'updatedAt'
>;

function present(value: AccessView) {
  return {
    uid: value.uid,
    verifiedEmail: value.verifiedEmail,
    role: value.role,
    active: value.active,
    revision: value.revision,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

function isGoogleProfile(
  profile: {
    uid: string;
    email?: string;
    emailVerified: boolean;
    disabled: boolean;
    providerData?: { providerId: string; email?: string }[];
  },
  email: string,
) {
  return (
    profile.email?.trim().toLowerCase() === email &&
    profile.disabled !== true &&
    (profile.providerData ?? []).some(
      (provider) =>
        provider.providerId === 'google.com' &&
        provider.email?.trim().toLowerCase() === email,
    )
  );
}

@Injectable()
export class AdminAccessService implements OnModuleInit {
  constructor(
    @InjectModel(AdminAccess.name)
    private readonly accesses: Model<AdminAccess>,
    @InjectModel(AdminOwnerFence.name)
    private readonly ownerFence: Model<AdminOwnerFence>,
    private readonly firebase: FirebaseIdentityService,
    private readonly operations: AdminOperationsService,
  ) {}

  async onModuleInit() {
    await Promise.all([this.accesses.init(), this.ownerFence.init()]);
  }

  async list(raw: Record<string, unknown>) {
    const allowed = ['limit', 'cursor', 'active'];
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
    let active: boolean | undefined;
    if (raw.active !== undefined) {
      if (raw.active !== 'true' && raw.active !== 'false')
        throw adminError('INVALID_REQUEST');
      active = raw.active === 'true';
    }
    const scope = operationFingerprint({ active: active ?? null });
    let after: Types.ObjectId | undefined;
    if (raw.cursor !== undefined) {
      try {
        if (
          typeof raw.cursor !== 'string' ||
          raw.cursor.length > 1024 ||
          !/^[A-Za-z0-9_-]+$/.test(raw.cursor)
        )
          throw new Error();
        const decodedText = Buffer.from(raw.cursor, 'base64url').toString(
          'utf8',
        );
        if (Buffer.from(decodedText).toString('base64url') !== raw.cursor)
          throw new Error();
        const decoded: unknown = JSON.parse(decodedText);
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
          throw new Error();
        const value = decoded as Record<string, unknown>;
        if (
          Object.keys(value).sort().join(',') !== 'id,scope' ||
          value.scope !== scope ||
          typeof value.id !== 'string' ||
          !/^[a-f0-9]{24}$/.test(value.id) ||
          !Types.ObjectId.isValid(value.id)
        )
          throw new Error();
        after = new Types.ObjectId(value.id);
      } catch {
        throw adminError('INVALID_CURSOR');
      }
    }
    const filter = {
      ...(active === undefined ? {} : { active }),
      ...(after ? { _id: { $gt: after } } : {}),
    };
    const records = await this.accesses
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();
    const items = records.slice(0, limit);
    return {
      items: items.map(present),
      nextCursor:
        records.length > limit
          ? Buffer.from(
              JSON.stringify({ id: items.at(-1)!._id.toString(), scope }),
            ).toString('base64url')
          : null,
      asOf: new Date().toISOString(),
    };
  }

  async create(actor: AdminActor, dto: CreateAdminAccessDto) {
    if (actor.role !== 'owner') throw adminError('PERMISSION_DENIED');
    const email = dto.verifiedEmail.trim().toLowerCase();
    const profile = await this.firebase.getProfileByEmail(email);
    if (!isGoogleProfile(profile, email)) throw adminError('INVALID_REQUEST');
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/access',
        request: { verifiedEmail: email, role: dto.role },
        action: 'admin.access.create',
        resourceType: 'admin_access',
        reason: dto.reason,
      },
      async (session) => {
        if (dto.role === 'owner') await this.bumpOwnerFence(session);
        let created: AdminAccess;
        try {
          [created] = await this.accesses.create(
            [
              {
                uid: profile.uid,
                verifiedEmail: email,
                role: dto.role,
                active: true,
                revision: 0,
                authorizationFence: 0,
              },
            ],
            { session },
          );
        } catch (error) {
          if ((error as { code?: number }).code === 11000)
            throw adminError('REVISION_CONFLICT');
          throw error;
        }
        return {
          resourceId: created.uid,
          revision: 0,
          previousRevision: null,
          value: present(created),
        };
      },
    );
    return result.value ?? this.detail(profile.uid);
  }

  async update(actor: AdminActor, uid: string, dto: UpdateAdminAccessDto) {
    if (actor.role !== 'owner') throw adminError('PERMISSION_DENIED');
    if (
      !uid ||
      uid.length > 128 ||
      (dto.role === undefined && dto.active === undefined)
    )
      throw adminError('INVALID_REQUEST');
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'PATCH /admin/access/:uid',
        request: {
          uid,
          role: dto.role ?? null,
          active: dto.active ?? null,
          expectedRevision: dto.expectedRevision,
        },
        action: 'admin.access.update',
        resourceType: 'admin_access',
        reason: dto.reason,
      },
      async (session) => this.updateInTransaction(uid, dto, session),
    );
    return result.value ?? this.detail(result.receipt.resourceId!);
  }

  private async detail(uid: string) {
    const record = await this.accesses.findOne({ uid }).maxTimeMS(5000).lean();
    if (!record) throw adminError('RESOURCE_NOT_FOUND');
    return present(record);
  }

  private async updateInTransaction(
    uid: string,
    dto: UpdateAdminAccessDto,
    session: ClientSession,
  ) {
    const current = await this.accesses
      .findOne({ uid })
      .session(session)
      .lean();
    if (!current) throw adminError('RESOURCE_NOT_FOUND');
    if (current.revision !== dto.expectedRevision)
      throw adminError('REVISION_CONFLICT');
    const role = dto.role ?? current.role;
    const active = dto.active ?? current.active;
    if (role === current.role && active === current.active)
      throw adminError('INVALID_REQUEST');
    const wasOwner = current.role === 'owner' && current.active;
    const isOwner = role === 'owner' && active;
    if (wasOwner !== isOwner) {
      await this.bumpOwnerFence(session);
      if (wasOwner) {
        const owners = await this.accesses
          .countDocuments({ role: 'owner', active: true })
          .session(session);
        if (owners <= 1) throw adminError('LAST_OWNER_REQUIRED');
      }
    }
    const updated = await this.accesses
      .findOneAndUpdate(
        { uid, revision: dto.expectedRevision },
        { $set: { role, active }, $inc: { revision: 1 } },
        { returnDocument: 'after', session, runValidators: true },
      )
      .lean();
    if (!updated) throw adminError('REVISION_CONFLICT');
    return {
      resourceId: uid,
      revision: updated.revision,
      previousRevision: current.revision,
      value: present(updated),
    };
  }

  private async bumpOwnerFence(session: ClientSession) {
    await this.ownerFence.updateOne(
      { _id: 'membership' },
      { $inc: { revision: 1 } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
  }
}
