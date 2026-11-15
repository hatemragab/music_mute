import { Injectable, HttpException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, ClientSession } from 'mongoose';
import { AppPolicy } from '../app-policy/app-policy.schema.js';
import { defaultPolicy, validatePolicy } from '../app-policy/access-policy.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import { adminError } from '../admin/admin-errors.js';
import {
  parseDesktopUpdatePolicyPatch,
  presentDesktopUpdatePolicy,
} from './desktop-policy.types.js';

/** Independent desktop gate edits share the original AppPolicy revision and transactional admin authority. */
@Injectable()
export class DesktopUpdatePolicyService {
  constructor(
    @InjectModel(AppPolicy.name) private readonly policies: Model<AppPolicy>,
    private readonly operations: AdminOperationsService,
  ) {}
  private async read(session?: ClientSession): Promise<AppPolicy> {
    try {
      const query = this.policies.findById('global').maxTimeMS(5000);
      if (session) query.session(session);
      const policy = (await query.lean()) ?? defaultPolicy();
      validatePolicy(policy);
      return policy;
    } catch {
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
  }
  async current() {
    return presentDesktopUpdatePolicy(await this.read());
  }
  async update(actor: AdminActor, input: unknown) {
    const body = parseDesktopUpdatePolicyPatch(input);
    const result = await this.operations.run(
      actor,
      {
        operationId: body.operationId,
        route: 'PATCH /admin/update-policy/desktop',
        request: { ...body },
        action: 'releases.desktop_policy.update',
        resourceType: 'desktop_policy',
        reason: body.reason,
      },
      async (session) => {
        const current = await this.read(session);
        if (current.revision !== body.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const next: AppPolicy = {
          ...current,
          platforms: { ...current.platforms, ...body.platforms },
          revision: current.revision + 1,
          updatedAt: new Date(),
        };
        validatePolicy(next);
        try {
          const updated = await this.policies.updateOne(
            { _id: 'global', revision: current.revision },
            {
              $set: {
                ...Object.fromEntries(
                  Object.entries(body.platforms).map(([key, value]) => [
                    `platforms.${key}`,
                    value,
                  ]),
                ),
                revision: next.revision,
                updatedAt: next.updatedAt,
              },
              $setOnInsert: {
                requireVerifiedEmail: current.requireVerifiedEmail,
                'platforms.android': current.platforms.android,
                'platforms.ios': current.platforms.ios,
              },
            },
            { session, upsert: current.revision === 0, runValidators: true },
          );
          if (!updated.modifiedCount && !updated.upsertedCount)
            throw adminError('REVISION_CONFLICT');
        } catch (error) {
          if ((error as { code?: number }).code === 11000)
            throw adminError('REVISION_CONFLICT');
          if (error instanceof HttpException) throw error;
          throw adminError('DEPENDENCY_UNAVAILABLE');
        }
        return {
          resourceId: 'global',
          previousRevision: current.revision,
          revision: next.revision,
          value: presentDesktopUpdatePolicy(next),
        };
      },
    );
    if (
      !Number.isSafeInteger(result.receipt.revision) ||
      Number(result.receipt.revision) < 1
    )
      throw adminError('DEPENDENCY_UNAVAILABLE');
    return {
      policy: result.value ?? (await this.current()),
      appliedRevision: result.receipt.revision,
      operationId: body.operationId,
      replayed: result.replayed,
    };
  }
}
