import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { adminError } from '../admin/admin-errors.js';
import { AccountRestriction } from './account-restriction.schema.js';
import type {
  RestrictedOperation,
  RestrictionReasonCode,
} from './abuse-protection.types.js';
import { AbuseEventsService } from './abuse-events.service.js';

function objectId(value: string | Types.ObjectId): Types.ObjectId {
  if (value instanceof Types.ObjectId) return value;
  if (!/^[a-f0-9]{24}$/i.test(value) || !Types.ObjectId.isValid(value))
    throw adminError('INVALID_REQUEST');
  return new Types.ObjectId(value);
}

@Injectable()
export class AccountRestrictionsService implements OnModuleInit {
  constructor(
    @InjectModel(AccountRestriction.name)
    private readonly restrictions: Model<AccountRestriction>,
    private readonly events: AbuseEventsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.restrictions.init();
  }

  async current(accountId: string | Types.ObjectId, session?: ClientSession) {
    const id = objectId(accountId);
    const now = new Date();
    await this.restrictions.updateOne(
      { accountId: id, status: 'active', expiresAt: { $lte: now } },
      {
        $set: { status: 'expired', updatedAt: now },
        $inc: { revision: 1 },
      },
      { session },
    );
    return this.restrictions
      .findOne({
        accountId: id,
        status: 'active',
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
      .session(session ?? null)
      .lean();
  }

  async assertAllowed(
    accountId: string | Types.ObjectId,
    operation: RestrictedOperation,
  ): Promise<void> {
    const restriction = await this.current(accountId);
    if (!restriction) return;
    void this.events
      .record({
        accountId: objectId(accountId).toHexString(),
        type: 'restriction_bypass_attempt',
        severity: 'medium',
        operationClass: operation,
        restrictionId: restriction._id.toString(),
      })
      .catch(() => undefined);
    throw authError('ACCOUNT_RESTRICTED');
  }

  async apply(
    input: {
      accountId: string;
      expectedRevision: number;
      reasonCode: RestrictionReasonCode;
      note: string;
      expiresAt: Date | null;
      actorUid: string;
    },
    session: ClientSession,
  ) {
    const accountId = objectId(input.accountId);
    const now = new Date();
    const existing = await this.restrictions
      .findOne({ accountId })
      .session(session)
      .lean();
    if ((existing?.revision ?? 0) !== input.expectedRevision)
      throw adminError('REVISION_CONFLICT');
    const nextRevision = input.expectedRevision + 1;
    let restriction;
    try {
      restriction = await this.restrictions
        .findOneAndUpdate(
          existing
            ? { _id: existing._id, revision: input.expectedRevision }
            : { accountId, revision: { $exists: false } },
          {
            $set: {
              accountId,
              status: 'active',
              reasonCode: input.reasonCode,
              note: input.note,
              startsAt: now,
              expiresAt: input.expiresAt,
              updatedBy: input.actorUid,
              updatedAt: now,
              revision: nextRevision,
            },
            $setOnInsert: { createdBy: input.actorUid },
          },
          {
            upsert: !existing,
            session,
            runValidators: true,
            returnDocument: 'after',
          },
        )
        .lean();
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw adminError('REVISION_CONFLICT');
      throw error;
    }
    if (!restriction) throw adminError('REVISION_CONFLICT');
    return restriction;
  }

  async remove(
    input: {
      accountId: string;
      expectedRevision: number;
      actorUid: string;
    },
    session: ClientSession,
  ) {
    const now = new Date();
    const restriction = await this.restrictions
      .findOneAndUpdate(
        {
          accountId: objectId(input.accountId),
          status: 'active',
          revision: input.expectedRevision,
        },
        {
          $set: {
            status: 'removed',
            updatedBy: input.actorUid,
            updatedAt: now,
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: true, returnDocument: 'after' },
      )
      .lean();
    if (!restriction) throw adminError('REVISION_CONFLICT');
    return restriction;
  }

  present(restriction: AccountRestriction & { _id: Types.ObjectId }) {
    const active =
      restriction.status === 'active' &&
      (!restriction.expiresAt || restriction.expiresAt > new Date());
    return {
      id: restriction._id.toString(),
      accountId: restriction.accountId.toString(),
      status: active
        ? 'active'
        : restriction.status === 'active'
          ? 'expired'
          : restriction.status,
      reasonCode: restriction.reasonCode,
      note: restriction.note,
      startsAt: restriction.startsAt.toISOString(),
      expiresAt: restriction.expiresAt?.toISOString() ?? null,
      createdBy: restriction.createdBy,
      updatedBy: restriction.updatedBy,
      updatedAt: restriction.updatedAt.toISOString(),
      revision: restriction.revision,
    };
  }
}
