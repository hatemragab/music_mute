import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AdminAuditService } from '../admin/admin-audit.service.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import { JobActionsService } from '../jobs/job-actions.service.js';
import { adminError } from '../admin/admin-errors.js';
import { jobError, type JobHttpErrorCode } from '../jobs/job-errors.js';
import { adminJobId } from './admin-jobs-query.js';
import type { AdminJobActionDto } from './dto/admin-job-action.dto.js';

const safeDomainCodes: readonly JobHttpErrorCode[] = [
  'JOB_STATE_CONFLICT',
  'WORKER_RECOVERY_REQUIRED',
  'NEW_INPUT_REQUIRED',
  'PROCESSING_UNAVAILABLE',
  'PROCESSING_LIMIT_REACHED',
  'IDEMPOTENCY_CONFLICT',
];

@Injectable()
export class AdminJobActionsService {
  constructor(
    private readonly actions: JobActionsService,
    private readonly operations: AdminOperationsService,
    private readonly audit: AdminAuditService,
  ) {}

  async cancel(actor: AdminActor, id: string, dto: AdminJobActionDto) {
    this.validate(actor, id);
    return this.withAdministrativeErrors(async () => {
      const result = await this.operations.run(
        actor,
        {
          operationId: dto.operationId,
          route: 'POST /admin/jobs/:id/cancel',
          request: { jobId: id, expectedRevision: dto.expectedRevision },
          action: 'jobs.cancel',
          resourceType: 'job',
          reason: dto.reason,
        },
        async (session) => {
          const value = await this.actions.cancelAsAdmin(
            actor,
            id,
            dto.expectedRevision,
            session,
          );
          return {
            resourceId: id,
            previousRevision: dto.expectedRevision,
            revision: value.revision,
            value,
          };
        },
      );
      return result.value ?? this.actions.administrativeState(actor, id);
    });
  }

  async retry(actor: AdminActor, id: string, dto: AdminJobActionDto) {
    this.validate(actor, id);
    return this.withAdministrativeErrors(async () => {
      await this.actions.prepareRetry();
      const requestId = randomUUID();
      const result = await this.operations.run(
        actor,
        {
          operationId: dto.operationId,
          route: 'POST /admin/jobs/:id/retry',
          request: { jobId: id, expectedRevision: dto.expectedRevision },
          action: 'jobs.retry',
          resourceType: 'job',
          reason: dto.reason,
        },
        async (session) => {
          const retried = await this.actions.retryAsAdmin(
            actor,
            id,
            dto.expectedRevision,
            requestId,
            session,
          );
          await this.audit.record(
            {
              actorUid: actor.uid,
              action: 'jobs.retry.source',
              resourceType: 'job',
              resourceId: id,
              operationId: dto.operationId,
              reason: dto.reason,
              previousRevision: dto.expectedRevision,
              nextRevision: retried.sourceRevision,
              outcome: 'succeeded',
            },
            session,
          );
          return {
            resourceId: retried.newJobId,
            previousRevision: null,
            revision: retried.revision,
            value: {
              sourceJobId: id,
              newJobId: retried.newJobId,
              status: 'queued' as const,
            },
          };
        },
      );
      if (result.value) return result.value;
      if (!result.receipt.resourceId)
        throw adminError('DEPENDENCY_UNAVAILABLE');
      adminJobId(result.receipt.resourceId);
      return {
        sourceJobId: id,
        newJobId: result.receipt.resourceId,
        status: 'queued' as const,
      };
    });
  }

  private validate(actor: AdminActor, id: string): void {
    if (!actor.permissions.includes('jobs.manage'))
      throw adminError('PERMISSION_DENIED');
    adminJobId(id);
  }

  private async withAdministrativeErrors<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse();
        if (body && typeof body === 'object' && 'code' in body) {
          if (body.code === 'JOB_NOT_FOUND')
            throw adminError('RESOURCE_NOT_FOUND');
          const domainCode =
            body.code === 'ACCOUNT_DISABLED'
              ? 'PROCESSING_UNAVAILABLE'
              : body.code;
          if (safeDomainCodes.includes(domainCode as JobHttpErrorCode)) {
            const safe = jobError(domainCode as JobHttpErrorCode);
            const { code, message } = safe.getResponse() as {
              code: string;
              message: string;
            };
            throw new HttpException(
              { code, message, requestId: randomUUID() },
              code === 'NEW_INPUT_REQUIRED' ? 422 : safe.getStatus(),
            );
          }
        }
      }
      throw error;
    }
  }
}
