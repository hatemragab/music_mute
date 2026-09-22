import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ClientSession, Connection, Model } from 'mongoose';
import { AdminOperationsService } from '../../admin/admin-operations.service.js';
import { adminError } from '../../admin/admin-errors.js';
import type { AdminActor } from '../../admin/admin.types.js';
import { Job } from '../../jobs/job.schema.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerAttempt } from '../jobs/worker-attempt.schema.js';
import { workerError } from '../worker-errors.js';
import {
  WorkerEnrollmentInvitation,
  WorkerInstallationSession,
} from './worker-enrollment.schema.js';
import { WorkerMachine } from '../machines/worker-machine.schema.js';
import type {
  WorkerCapability,
  WorkerHardwareReport,
  WorkerRuntimeIdentity,
} from '../machines/worker-machine.schema.js';
import type {
  ActivateWorkerInstallationDto,
  CreateWorkerInvitationDto,
  ExchangeWorkerInvitationDto,
  ReportWorkerInstallationDto,
  WorkerLifecycleDto,
} from './worker-enrollment.dto.js';
import { sanitizeWorkerDiagnosticLine } from '../telemetry/worker-diagnostic-sanitizer.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  QUALIFIED_MODEL_DIGEST,
} from '../../jobs/worker-recipes.js';

const INSTALLATION_TTL_MS = 60 * 60 * 1000;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deriveCredential(secret: string, domain: string, id: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`musicmute-worker/v1:${domain}:${id}`, 'utf8')
    .digest('base64url');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  throw workerError('WORKER_INVALID_REQUEST');
}

function normalizeReport(dto: ReportWorkerInstallationDto) {
  return {
    label: dto.label,
    groupId: dto.groupId ?? null,
    hardwareReport: {
      ...dto.hardware,
      gpus: dto.hardware.gpus.map((gpu) => ({
        ...gpu,
        memoryBytes: gpu.memoryBytes ?? null,
      })),
    },
    runtimeIdentity: dto.runtime,
    capabilities: dto.capabilities,
    reportSummary: sanitizeWorkerDiagnosticLine(dto.summary),
  };
}

function isQualified(dto: {
  hardware: WorkerHardwareReport;
  runtime: WorkerRuntimeIdentity;
  capabilities: WorkerCapability[];
}): boolean {
  if (dto.runtime.protocolVersion !== 1) return false;
  if (dto.runtime.modelDigest !== QUALIFIED_MODEL_DIGEST) return false;
  const gpuIds = new Set(dto.hardware.gpus.map((gpu) => gpu.id));
  const architecture = dto.hardware.architecture.toLowerCase();
  const os = dto.hardware.os.toLowerCase();
  return dto.capabilities.every((capability) => {
    if (!gpuIds.has(capability.gpuId)) return false;
    if (!capability.recipeIds.includes(DEFAULT_WORKER_RECIPE_ID)) return false;
    if (capability.platform === 'darwin-arm64' && capability.provider === 'mps')
      return (
        ['arm64', 'aarch64'].includes(architecture) &&
        (os.includes('darwin') || os.includes('mac'))
      );
    return (
      capability.platform === 'windows-amd64' &&
      capability.provider === 'directml' &&
      ['amd64', 'x64', 'x86_64'].includes(architecture) &&
      os.includes('windows')
    );
  });
}

@Injectable()
export class WorkerEnrollmentService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WorkerEnrollmentInvitation.name)
    private readonly invitations: Model<WorkerEnrollmentInvitation>,
    @InjectModel(WorkerInstallationSession.name)
    private readonly installations: Model<WorkerInstallationSession>,
    @InjectModel(WorkerMachine.name)
    private readonly machines: Model<WorkerMachine>,
    @InjectModel(WorkerAttempt.name)
    private readonly attempts: Model<WorkerAttempt>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly operations: AdminOperationsService,
  ) {}

  async createInvitation(actor: AdminActor, dto: CreateWorkerInvitationDto) {
    const code = randomBytes(32).toString('base64url');
    const invitationId = randomUUID();
    const expiresAt = new Date(Date.now() + dto.expiresInSeconds * 1000);
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/workers/invitations',
        request: {
          expiresInSeconds: dto.expiresInSeconds,
          initialPolicyId: dto.initialPolicyId ?? null,
        },
        action: 'workers.invitation.create',
        resourceType: 'worker_invitation',
        reason: dto.reason,
      },
      async (session) => {
        await this.invitations.create(
          [
            {
              _id: invitationId,
              codeDigest: digest(code),
              createdByUid: actor.uid,
              initialPolicyId: dto.initialPolicyId ?? null,
              state: 'active',
              expiresAt,
            },
          ],
          { session },
        );
        return {
          resourceId: invitationId,
          revision: 0,
          value: { credential: code, expiresAt: expiresAt.toISOString() },
        };
      },
    );
    return {
      invitationId: result.receipt.resourceId,
      revision: result.receipt.revision,
      credential: result.value?.credential ?? null,
      expiresAt: result.value?.expiresAt ?? null,
      replayed: result.replayed,
    };
  }

  async revokeInvitation(
    actor: AdminActor,
    id: string,
    dto: WorkerLifecycleDto,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw adminError('INVALID_REQUEST');
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/workers/invitations/:id/revoke',
        request: { id, expectedRevision: dto.expectedRevision },
        action: 'workers.invitation.revoke',
        resourceType: 'worker_invitation',
        reason: dto.reason,
      },
      async (session) => {
        const now = new Date();
        const invitation = await this.invitations
          .findById(id)
          .session(session)
          .lean();
        if (!invitation) throw adminError('RESOURCE_NOT_FOUND');
        if (invitation.revision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        if (invitation.state !== 'active' || invitation.expiresAt <= now)
          throw adminError('INVALID_REQUEST');
        const updated = await this.invitations.updateOne(
          { _id: id, state: 'active', revision: dto.expectedRevision },
          {
            $set: { state: 'revoked', revokedAt: now },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (updated.modifiedCount !== 1) throw adminError('REVISION_CONFLICT');
        return {
          resourceId: id,
          previousRevision: dto.expectedRevision,
          revision: dto.expectedRevision + 1,
          value: { state: 'revoked' as const },
        };
      },
    );
    return {
      invitationId: result.receipt.resourceId,
      revision: result.receipt.revision,
      state: result.value?.state ?? 'revoked',
      replayed: result.replayed,
    };
  }

  async exchange(principal: WorkerPrincipal, dto: ExchangeWorkerInvitationDto) {
    if (principal.kind !== 'enrollment')
      throw workerError('WORKER_UNAUTHENTICATED');
    const session = await this.connection.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const invitation = await this.invitations
          .findById(principal.subjectId)
          .session(session)
          .lean();
        if (!invitation) throw workerError('WORKER_UNAUTHENTICATED');
        if (invitation.expiresAt.getTime() <= Date.now())
          throw workerError('WORKER_EXPIRED');
        if (invitation.state === 'consumed') {
          if (
            invitation.exchangeRequestId !== dto.requestId ||
            !invitation.installationSessionId
          )
            throw workerError('WORKER_CONFLICT');
          const existing = await this.installations
            .findById(invitation.installationSessionId)
            .session(session)
            .lean();
          if (!existing) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
          return { installation: existing, replayed: true };
        }
        if (invitation.state !== 'active' || invitation.useCount !== 0)
          throw workerError('WORKER_UNAUTHENTICATED');
        const installationId = randomUUID();
        const credential = deriveCredential(
          principal.credential,
          'installation',
          dto.requestId,
        );
        const expiresAt = new Date(Date.now() + INSTALLATION_TTL_MS);
        const consumed = await this.invitations.updateOne(
          {
            _id: invitation._id,
            state: 'active',
            useCount: 0,
            expiresAt: { $gt: new Date() },
            revision: invitation.revision,
          },
          {
            $set: {
              state: 'consumed',
              consumedAt: new Date(),
              exchangeRequestId: dto.requestId,
              installationSessionId: installationId,
            },
            $inc: { useCount: 1, revision: 1 },
          },
          { session, runValidators: true },
        );
        if (consumed.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
        const [installation] = await this.installations.create(
          [
            {
              _id: installationId,
              invitationId: invitation._id,
              credentialDigest: digest(credential),
              exchangeRequestId: dto.requestId,
              phase: 'restricted',
              lastSeenAt: new Date(),
              expiresAt,
            },
          ],
          { session },
        );
        return { installation: installation.toObject(), replayed: false };
      });
      if (!result) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
      const credential = deriveCredential(
        principal.credential,
        'installation',
        dto.requestId,
      );
      return {
        installationId: result.installation._id,
        phase: result.installation.phase,
        expiresAt: result.installation.expiresAt.toISOString(),
        credential,
        replayed: result.replayed,
      };
    } finally {
      await session.endSession();
    }
  }

  async report(
    principal: WorkerPrincipal,
    id: string,
    dto: ReportWorkerInstallationDto,
  ) {
    this.assertInstallation(principal, id);
    const normalized = normalizeReport(dto);
    const reportDigest = digest(canonical(normalized));
    const current = await this.installations
      .findById(id)
      .maxTimeMS(2000)
      .lean();
    if (!current) throw workerError('WORKER_NOT_FOUND');
    if (
      current.reportRequestId === dto.requestId &&
      current.reportDigest === reportDigest
    )
      return this.presentInstallation(current, true);
    if (current.reportRequestId === dto.requestId)
      throw workerError('WORKER_CONFLICT');
    if (!['restricted', 'reported'].includes(current.phase))
      throw workerError('WORKER_CONFLICT');
    const updated = await this.installations
      .findOneAndUpdate(
        { _id: id, revision: dto.expectedRevision, phase: current.phase },
        {
          $set: {
            ...normalized,
            reportDigest,
            reportRequestId: dto.requestId,
            phase: 'reported',
            outcomeCode: null,
            lastSeenAt: new Date(),
          },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!updated) throw workerError('WORKER_CONFLICT');
    return this.presentInstallation(updated, false);
  }

  async activate(
    principal: WorkerPrincipal,
    id: string,
    dto: ActivateWorkerInstallationDto,
  ) {
    this.assertInstallation(principal, id);
    const session = await this.connection.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const installation = await this.installations
          .findById(id)
          .session(session)
          .lean();
        if (!installation) throw workerError('WORKER_NOT_FOUND');
        if (installation.phase === 'activated' && installation.machineId) {
          if (installation.activationRequestId !== dto.requestId)
            throw workerError('WORKER_CONFLICT');
          const machine = await this.machines
            .findById(installation.machineId)
            .session(session)
            .lean();
          if (!machine) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
          if (machine.credentialDigest !== dto.credentialDigest)
            throw workerError('WORKER_CONFLICT');
          return { machine, replayed: true, failed: false };
        }
        if (
          installation.phase !== 'reported' ||
          installation.revision !== dto.expectedRevision ||
          !installation.hardwareReport ||
          !installation.runtimeIdentity ||
          !installation.qualificationObject ||
          installation.capabilities.length === 0
        )
          throw workerError('WORKER_CONFLICT');
        const qualified = isQualified({
          hardware: installation.hardwareReport,
          runtime: installation.runtimeIdentity,
          capabilities: installation.capabilities,
        });
        if (!qualified) {
          await this.installations.updateOne(
            { _id: id, revision: dto.expectedRevision, phase: 'reported' },
            {
              $set: { phase: 'failed', outcomeCode: 'qualification_failed' },
              $inc: { revision: 1 },
            },
            { session, runValidators: true },
          );
          return { machine: null, replayed: false, failed: true };
        }
        const machineId = randomUUID();
        const machine = await new this.machines({
          _id: machineId,
          credentialDigest: dto.credentialDigest,
          status: 'active',
          label: installation.label,
          groupId: installation.groupId,
          approvedCapabilities: installation.capabilities,
          hardwareReport: installation.hardwareReport,
          runtimeIdentity: installation.runtimeIdentity,
        }).save({ session });
        const activated = await this.installations.updateOne(
          { _id: id, revision: dto.expectedRevision, phase: 'reported' },
          {
            $set: {
              phase: 'activated',
              machineId,
              activationRequestId: dto.requestId,
              activatedAt: new Date(),
              outcomeCode: 'activated',
              lastSeenAt: new Date(),
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (activated.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
        return { machine: machine.toObject(), replayed: false, failed: false };
      });
      if (!result) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
      if (result.failed) throw workerError('WORKER_FORBIDDEN');
      const machine = result.machine!;
      return {
        machineId: machine._id,
        status: machine.status,
        credentialRevision: machine.credentialRevision,
        replayed: result.replayed,
      };
    } finally {
      await session.endSession();
    }
  }

  pause(actor: AdminActor, id: string, dto: WorkerLifecycleDto) {
    return this.changeMachine(actor, id, dto, 'paused');
  }

  drain(actor: AdminActor, id: string, dto: WorkerLifecycleDto) {
    return this.changeMachine(actor, id, dto, 'draining');
  }

  resume(actor: AdminActor, id: string, dto: WorkerLifecycleDto) {
    return this.changeMachine(actor, id, dto, 'active');
  }

  revoke(actor: AdminActor, id: string, dto: WorkerLifecycleDto) {
    return this.changeMachine(actor, id, dto, 'revoked');
  }

  private async changeMachine(
    actor: AdminActor,
    id: string,
    dto: WorkerLifecycleDto,
    target: 'active' | 'paused' | 'draining' | 'revoked',
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw adminError('INVALID_REQUEST');
    const action = `workers.machine.${target === 'active' ? 'resume' : target}`;
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: `POST /admin/workers/machines/:id/${target === 'active' ? 'resume' : target}`,
        request: { id, expectedRevision: dto.expectedRevision },
        action,
        resourceType: 'worker_machine',
        reason: dto.reason,
      },
      async (session) =>
        this.mutateMachine(id, dto.expectedRevision, target, session),
    );
    return {
      machineId: result.receipt.resourceId,
      revision: result.receipt.revision,
      status: result.value?.status ?? target,
      replayed: result.replayed,
    };
  }

  private async mutateMachine(
    id: string,
    expectedRevision: number,
    target: 'active' | 'paused' | 'draining' | 'revoked',
    session: ClientSession,
  ) {
    const machine = await this.machines.findById(id).session(session).lean();
    if (!machine) throw adminError('RESOURCE_NOT_FOUND');
    if (machine.revision !== expectedRevision)
      throw adminError('REVISION_CONFLICT');
    const allowed =
      (target === 'paused' &&
        ['active', 'draining'].includes(machine.status)) ||
      (target === 'draining' && machine.status === 'active') ||
      (target === 'active' && machine.status === 'paused') ||
      (target === 'active' && machine.status === 'draining') ||
      (target === 'revoked' && machine.status !== 'revoked');
    if (!allowed) throw adminError('INVALID_REQUEST');
    const now = new Date();
    const updated = await this.machines
      .findOneAndUpdate(
        { _id: id, revision: expectedRevision, status: machine.status },
        {
          $set: {
            status: target,
            ...(target === 'revoked'
              ? { revokedAt: now, currentSession: null }
              : {}),
          },
          $inc: {
            revision: 1,
            ...(target === 'revoked' ? { credentialRevision: 1 } : {}),
          },
        },
        { session, returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!updated) throw adminError('REVISION_CONFLICT');
    if (target === 'revoked') {
      await this.installations.updateMany(
        { machineId: id, phase: 'activated' },
        {
          $set: { phase: 'revoked', revokedAt: now },
          $inc: { revision: 1 },
        },
        { session, runValidators: true },
      );
      await this.jobs.updateMany(
        { 'currentExecution.machineId': id },
        {
          $set: {
            'currentExecution.leaseExpiresAt': now,
          },
        },
        { session, runValidators: true },
      );
      await this.attempts.updateMany(
        {
          machineId: id,
          state: { $in: ['claimed', 'running', 'uploading'] },
        },
        {
          $set: { leaseExpiresAt: now },
          $inc: { revision: 1 },
        },
        { session, runValidators: true },
      );
    }
    return {
      resourceId: id,
      previousRevision: expectedRevision,
      revision: updated.revision,
      value: { status: updated.status },
    };
  }

  private assertInstallation(principal: WorkerPrincipal, id: string): void {
    if (principal.kind !== 'installation' || principal.subjectId !== id)
      throw workerError('WORKER_NOT_FOUND');
  }

  private presentInstallation(
    installation: WorkerInstallationSession,
    replayed: boolean,
  ) {
    return {
      installationId: installation._id,
      phase: installation.phase,
      outcomeCode: installation.outcomeCode,
      revision: installation.revision,
      replayed,
    };
  }
}
