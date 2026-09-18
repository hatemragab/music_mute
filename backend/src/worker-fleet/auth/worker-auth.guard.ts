import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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
  WORKER_ROUTE,
  type WorkerCredentialKind,
} from './worker-auth.decorators.js';
import type { WorkerRequest } from './worker-auth.types.js';
import { workerError } from '../worker-errors.js';

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
    if (!kind) throw workerError('WORKER_UNAUTHENTICATED');
    const request = context.switchToHttp().getRequest<WorkerRequest>();
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
      return true;
    }
    const machine = await this.machines
      .findOne({ credentialDigest: digest })
      .maxTimeMS(2000)
      .lean();
    if (!machine || machine.status === 'revoked')
      throw workerError('WORKER_UNAUTHENTICATED');
    request.workerPrincipal = {
      kind,
      subjectId: machine._id,
      credential,
      machineStatus: machine.status,
    };
    return true;
  }
}
