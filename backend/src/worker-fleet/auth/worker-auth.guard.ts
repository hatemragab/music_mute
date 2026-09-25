import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { WORKER_RATE_LIMIT_DEFAULTS } from '../../config/environment.js';
import { createHash } from 'node:crypto';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  WorkerEnrollmentInvitation,
  WorkerInstallationSession,
} from '../enrollment/worker-enrollment.schema.js';
import { WorkerMachine } from '../machines/worker-machine.schema.js';
import {
  WORKER_CREDENTIAL_KIND,
  WORKER_ALLOW_REVOKED_MACHINE,
  WORKER_ROUTE,
  WORKER_RATE_CLASS,
  type WorkerCredentialKind,
  type WorkerRateClass,
} from './worker-auth.decorators.js';
import type { WorkerRequest } from './worker-auth.types.js';
import { workerError } from '../worker-errors.js';
import { RateBudgetService } from '../../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../../rate-limits/rate-limit-keys.js';

const perMinute: Record<WorkerRateClass, number> = {
  standard: WORKER_RATE_LIMIT_DEFAULTS.WORKER_STANDARD_PER_MINUTE,
  poll: WORKER_RATE_LIMIT_DEFAULTS.WORKER_POLL_PER_MINUTE,
  transfer: WORKER_RATE_LIMIT_DEFAULTS.WORKER_TRANSFER_PER_MINUTE,
  telemetry: WORKER_RATE_LIMIT_DEFAULTS.WORKER_TELEMETRY_PER_MINUTE,
};

@Injectable()
export class WorkerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectModel(WorkerEnrollmentInvitation.name)
    private readonly invitations: Model<WorkerEnrollmentInvitation>,
    @InjectModel(WorkerInstallationSession.name)
    private readonly installations: Model<WorkerInstallationSession>,
    @InjectModel(WorkerMachine.name)
    private readonly machines: Model<WorkerMachine>,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(WORKER_ROUTE, targets) !== true
    )
      return true;
    const kind = this.reflector.getAllAndOverride<WorkerCredentialKind>(
      WORKER_CREDENTIAL_KIND,
      targets,
    );
    const allowRevokedMachine =
      this.reflector.getAllAndOverride<boolean>(
        WORKER_ALLOW_REVOKED_MACHINE,
        targets,
      ) === true;
    if (!kind) throw workerError('WORKER_UNAUTHENTICATED');
    const request = context.switchToHttp().getRequest<WorkerRequest>();
    await this.assertPreauthBudget(request.ip ?? 'unknown', context);
    const header = request.headers.authorization;
    const count = (request.rawHeaders ?? []).filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'authorization',
    ).length;
    if (count !== 1 || typeof header !== 'string')
      throw workerError('WORKER_UNAUTHENTICATED');
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) throw workerError('WORKER_UNAUTHENTICATED');
    const credential = match[1];
    const digest = createHash('sha256').update(credential).digest('hex');
    const now = new Date();
    if (kind === 'enrollment') {
      const invitation = await this.invitations
        .findOne({ codeDigest: digest })
        .maxTimeMS(2000)
        .lean();
      if (!invitation) throw workerError('WORKER_UNAUTHENTICATED');
      if (invitation.expiresAt.getTime() <= now.getTime())
        throw workerError('WORKER_EXPIRED');
      if (!['active', 'consumed'].includes(invitation.state))
        throw workerError('WORKER_UNAUTHENTICATED');
      request.workerPrincipal = {
        kind,
        subjectId: invitation._id,
        credential,
      };
      await this.assertBudget(kind, invitation._id, context);
      return true;
    }
    if (kind === 'installation') {
      const installation = await this.installations
        .findOne({ credentialDigest: digest })
        .maxTimeMS(2000)
        .lean();
      if (!installation) throw workerError('WORKER_UNAUTHENTICATED');
      if (installation.expiresAt.getTime() <= now.getTime())
        throw workerError('WORKER_EXPIRED');
      if (['failed', 'expired', 'revoked'].includes(installation.phase))
        throw workerError('WORKER_UNAUTHENTICATED');
      request.workerPrincipal = {
        kind,
        subjectId: installation._id,
        credential,
      };
      await this.assertBudget(kind, installation._id, context);
      return true;
    }
    const machine = await this.machines
      .findOne({ credentialDigest: digest })
      .maxTimeMS(2000)
      .lean();
    if (!machine || (machine.status === 'revoked' && !allowRevokedMachine))
      throw workerError('WORKER_UNAUTHENTICATED');
    request.workerPrincipal = {
      kind,
      subjectId: machine._id,
      credential,
      machineStatus: machine.status,
    };
    await this.assertBudget(kind, machine._id, context);
    return true;
  }

  private async assertPreauthBudget(
    ip: string,
    context: ExecutionContext,
  ): Promise<void> {
    const decision = await this.budgets.reserve([
      {
        key: this.keys.bucket('worker-preauth-ip', ip),
        limit: this.config.get<number>(
          'WORKER_PREAUTH_IP_PER_MINUTE',
          WORKER_RATE_LIMIT_DEFAULTS.WORKER_PREAUTH_IP_PER_MINUTE,
        ),
        windowMs: 60_000,
      },
      {
        key: this.keys.bucket('worker-preauth-service', 'global'),
        limit: this.config.get<number>(
          'WORKER_PREAUTH_SERVICE_PER_MINUTE',
          WORKER_RATE_LIMIT_DEFAULTS.WORKER_PREAUTH_SERVICE_PER_MINUTE,
        ),
        windowMs: 60_000,
      },
    ]);
    if (!decision.allowed) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('Retry-After', decision.retryAfterSeconds);
      throw workerError('WORKER_RATE_LIMITED');
    }
  }

  private async assertBudget(
    kind: WorkerCredentialKind,
    subjectId: string,
    context: ExecutionContext,
  ): Promise<void> {
    const targets = [context.getHandler(), context.getClass()];
    const rateClass =
      this.reflector.getAllAndOverride<WorkerRateClass>(
        WORKER_RATE_CLASS,
        targets,
      ) ?? 'standard';
    const endpoint = `${context.getClass().name}.${context.getHandler().name}`;
    const decision = await this.budgets.reserve([
      {
        key: this.keys.bucket(`worker-${kind}`, subjectId),
        limit: this.config.get<number>(
          kind === 'machine'
            ? 'WORKER_MACHINE_PER_MINUTE'
            : kind === 'installation'
              ? 'WORKER_INSTALLATION_PER_MINUTE'
              : 'WORKER_ENROLLMENT_PER_MINUTE',
          kind === 'machine'
            ? WORKER_RATE_LIMIT_DEFAULTS.WORKER_MACHINE_PER_MINUTE
            : kind === 'installation'
              ? WORKER_RATE_LIMIT_DEFAULTS.WORKER_INSTALLATION_PER_MINUTE
              : WORKER_RATE_LIMIT_DEFAULTS.WORKER_ENROLLMENT_PER_MINUTE,
        ),
        windowMs: 60_000,
      },
      {
        key: this.keys.bucket(`worker-${rateClass}`, `${kind}:${subjectId}`),
        limit: this.config.get<number>(
          `WORKER_${rateClass.toUpperCase()}_PER_MINUTE`,
          perMinute[rateClass],
        ),
        windowMs: 60_000,
      },
      {
        key: this.keys.bucket('worker-endpoint', endpoint),
        limit: this.config.get<number>(
          'WORKER_ENDPOINT_PER_MINUTE',
          WORKER_RATE_LIMIT_DEFAULTS.WORKER_ENDPOINT_PER_MINUTE,
        ),
        windowMs: 60_000,
      },
      {
        key: this.keys.bucket('worker-service', 'global'),
        limit: this.config.get<number>(
          'WORKER_SERVICE_PER_MINUTE',
          WORKER_RATE_LIMIT_DEFAULTS.WORKER_SERVICE_PER_MINUTE,
        ),
        windowMs: 60_000,
      },
    ]);
    if (!decision.allowed) {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('Retry-After', decision.retryAfterSeconds);
      throw workerError('WORKER_RATE_LIMITED');
    }
  }
}
