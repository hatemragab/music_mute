import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import { JobActionsService } from '../jobs/job-actions.service.js';
import { adminError } from '../admin/admin-errors.js';
import { jobError, type JobHttpErrorCode } from '../jobs/job-errors.js';
import { adminJobId } from './admin-jobs-query.js';
import type { AdminJobActionDto } from './dto/admin-job-action.dto.js';
import { ProcessingUnavailableService } from '../processing/processing-unavailable.service.js';

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
    private readonly unavailable: ProcessingUnavailableService,
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
    void dto;
    return this.unavailable.reject();
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
