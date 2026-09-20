import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type Model } from 'mongoose';
import type { AdminActor } from '../admin/admin.types.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import type {
  DeleteAccountRestrictionDto,
  PutAccountRestrictionDto,
} from './dto/account-restriction.dto.js';
import { AccountRestrictionsService } from './account-restrictions.service.js';
import { AbuseEventsService } from './abuse-events.service.js';
import { RestrictionJobsService } from './restriction-jobs.service.js';
import { User } from '../users/user.schema.js';

@Injectable()
export class AdminAbuseProtectionService {
  constructor(
    private readonly events: AbuseEventsService,
    private readonly restrictions: AccountRestrictionsService,
    private readonly jobs: RestrictionJobsService,
    private readonly operations: AdminOperationsService,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  listEvents(query: Record<string, unknown>) {
    return this.events.list(query);
  }

  async currentRestriction(accountId: string) {
    await this.assertAccountExists(accountId);
    const restriction = await this.restrictions.current(accountId);
    return restriction ? this.restrictions.present(restriction) : null;
  }

  async putRestriction(
    actor: AdminActor,
    accountId: string,
    dto: PutAccountRestrictionDto,
  ) {
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date())
      throw adminError('INVALID_REQUEST');
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'PUT /admin/users/:id/restriction',
        request: {
          accountId,
          expectedRevision: dto.expectedRevision,
          reasonCode: dto.reasonCode,
          expiresAt: dto.expiresAt ?? null,
        },
        action: 'users.restriction.apply',
        resourceType: 'account_restriction',
        reason: dto.note,
      },
      async (session) => {
        await this.assertAccountExists(accountId, session);
        const restriction = await this.restrictions.apply(
          {
            accountId,
            expectedRevision: dto.expectedRevision,
            reasonCode: dto.reasonCode,
            note: dto.note,
            expiresAt,
            actorUid: actor.uid,
          },
          session,
        );
        const cancelledJobs = await this.jobs.cancelNotFinalized(
          restriction.accountId,
          session,
        );
        return {
          resourceId: restriction._id.toString(),
          previousRevision: dto.expectedRevision,
          revision: restriction.revision,
          value: {
            ...this.restrictions.present(restriction),
            cancelledJobs,
          },
        };
      },
    );
    return result.value ?? this.currentRestriction(accountId);
  }

  async deleteRestriction(
    actor: AdminActor,
    accountId: string,
    dto: DeleteAccountRestrictionDto,
  ) {
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'DELETE /admin/users/:id/restriction',
        request: { accountId, expectedRevision: dto.expectedRevision },
        action: 'users.restriction.remove',
        resourceType: 'account_restriction',
        reason: dto.reason,
      },
      async (session) => {
        await this.assertAccountExists(accountId, session);
        const restriction = await this.restrictions.remove(
          {
            accountId,
            expectedRevision: dto.expectedRevision,
            actorUid: actor.uid,
          },
          session,
        );
        return {
          resourceId: restriction._id.toString(),
          previousRevision: dto.expectedRevision,
          revision: restriction.revision,
          value: this.restrictions.present(restriction),
        };
      },
    );
    return result.value ?? this.currentRestriction(accountId);
  }

  private async assertAccountExists(
    accountId: string,
    session?: ClientSession,
  ): Promise<void> {
    if (
      !/^[a-f0-9]{24}$/i.test(accountId) ||
      !Types.ObjectId.isValid(accountId)
    )
      throw adminError('RESOURCE_NOT_FOUND');
    const query = this.users.exists({ _id: new Types.ObjectId(accountId) });
    if (session) query.session(session);
    if (!(await query)) throw adminError('RESOURCE_NOT_FOUND');
  }
}
