import { Injectable, ValidationPipe } from '@nestjs/common';
import { QueueProjectionService } from './queue-projection.service.js';
import { Types } from 'mongoose';
import { AdminJobsQueryService } from '../admin-jobs/admin-jobs-query.service.js';
import { AdminAlertsService } from '../admin-observability/admin-alerts.service.js';
import { AdminHealthService } from '../admin-observability/admin-health.service.js';
import { AdminOverviewService } from '../admin-observability/admin-overview.service.js';
import { AccountPolicyService } from '../admin-settings/account-policy.service.js';
import { AdminAccountRecoveryService } from '../admin-users/admin-account-recovery.service.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminPermission } from '../admin/admin.types.js';
import { authError } from '../auth/auth.errors.js';
import { SnakeCaseRequestPipe } from '../http/snake-case-wire.js';
import { JobsQueryService } from '../jobs/jobs-query.service.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { ReleaseUploadService } from '../releases/release-upload.service.js';
import { ImportsService } from '../url-imports/imports.service.js';
import {
  AdminWorkerListQueryDto,
  AdminWorkerPageQueryDto,
} from '../worker-fleet/control/worker-control.dto.js';
import { WorkerControlService } from '../worker-fleet/control/worker-control.service.js';
import type { RealtimePrincipal } from './realtime-auth.service.js';
import type {
  RealtimeResource,
  RealtimeSubscription,
} from './realtime-protocol.js';

const permissions: Partial<Record<RealtimeResource, AdminPermission>> = {
  'admin.jobs': 'jobs.read',
  'admin.job': 'jobs.read',
  'admin.overview': 'overview.read',
  'admin.health': 'health.read',
  'admin.alerts': 'health.read',
  'admin.workers': 'workers.read',
  'admin.worker': 'workers.read',
  'admin.diagnostics': 'workers.logs.read',
  'admin.invitations': 'workers.enroll',
  'admin.recoveries': 'users.account-recovery.manage',
  'admin.recovery_summary': 'users.account-recovery.manage',
  'admin.release_upload': 'releases.read',
};

@Injectable()
export class RealtimeResourcesService {
  private readonly wire = new SnakeCaseRequestPipe();
  private readonly validation = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  constructor(
    private readonly jobs: JobsQueryService,
    private readonly imports: ImportsService,
    private readonly usage: ProcessingUsageService,
    private readonly policies: AccountPolicyService,
    private readonly adminJobs: AdminJobsQueryService,
    private readonly overview: AdminOverviewService,
    private readonly health: AdminHealthService,
    private readonly alerts: AdminAlertsService,
    private readonly workers: WorkerControlService,
    private readonly recoveries: AdminAccountRecoveryService,
    private readonly uploads: ReleaseUploadService,
    private readonly queues: QueueProjectionService,
  ) {}

  async read(
    principal: RealtimePrincipal,
    subscription: RealtimeSubscription,
  ): Promise<unknown> {
    const { resource } = subscription;
    const required = permissions[resource];
    if (required) {
      if (
        principal.audience !== 'admin' ||
        !principal.admin?.permissions.includes(required)
      )
        throw adminError('ADMIN_ACCESS_DENIED');
    } else if (principal.audience !== 'owner' || !principal.userId) {
      throw authError('UNAUTHENTICATED');
    }
    const params = this.wire.transform(subscription.params, {
      type: 'query',
    }) as Record<string, string>;
    const owner = principal.userId!;
    const actor = principal.admin!;
    switch (resource) {
      case 'jobs': {
        const page = await this.jobs.list(owner, params);
        return { ...page, items: await this.queues.enrich(page.items) };
      }
      case 'job':
        return (
          await this.queues.enrich([
            await this.jobs.detail(owner, this.id(params)),
          ])
        )[0];
      case 'import':
        return this.imports.get(owner, this.id(params));
      case 'usage':
        this.empty(params);
        return this.usage.readUsage(new Types.ObjectId(owner));
      case 'policy':
        if (Object.keys(params).some((key) => key !== 'schemaVersion'))
          throw authError('INVALID_INPUT');
        return this.policies.publicPolicy(params.schemaVersion);
      case 'admin.jobs': {
        const page = await this.adminJobs.list(actor, params);
        return { ...page, items: await this.queues.enrich(page.items) };
      }
      case 'admin.job':
        return (
          await this.queues.enrich([
            await this.adminJobs.detail(actor, this.id(params)),
          ])
        )[0];
      case 'admin.overview':
        return this.overview.read(actor, params);
      case 'admin.health':
        this.empty(params);
        return this.health.read();
      case 'admin.alerts':
        return this.alerts.list(params);
      case 'admin.workers':
        return this.workers.listMachines(
          actor,
          await this.validation.transform(params, {
            type: 'query',
            metatype: AdminWorkerListQueryDto,
          }),
        );
      case 'admin.worker':
        return this.workers.machineDetail(actor, this.id(params));
      case 'admin.diagnostics': {
        const { id, ...query } = params;
        if (!id) throw authError('INVALID_INPUT');
        return this.workers.machineDiagnostics(
          actor,
          id,
          await this.validation.transform(query, {
            type: 'query',
            metatype: AdminWorkerPageQueryDto,
          }),
        );
      }
      case 'admin.invitations':
        return this.workers.listInvitations(
          actor,
          await this.validation.transform(params, {
            type: 'query',
            metatype: AdminWorkerPageQueryDto,
          }),
        );
      case 'admin.recoveries':
        return this.recoveries.list(params);
      case 'admin.recovery_summary':
        this.empty(params);
        return this.recoveries.summary();
      case 'admin.release_upload':
        if (
          Object.keys(params).length !== 2 ||
          !params.releaseId ||
          !params.uploadId
        )
          throw authError('INVALID_INPUT');
        return this.uploads.read(params.releaseId, params.uploadId);
    }
  }

  private id(params: Record<string, string>): string {
    if (Object.keys(params).length !== 1 || !params.id)
      throw authError('INVALID_INPUT');
    return params.id;
  }

  private empty(params: Record<string, string>): void {
    if (Object.keys(params).length) throw authError('INVALID_INPUT');
  }
}
