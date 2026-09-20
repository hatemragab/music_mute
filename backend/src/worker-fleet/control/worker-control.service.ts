import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { trusted, type Model } from 'mongoose';
import { AdminOperationsService } from '../../admin/admin-operations.service.js';
import { adminError } from '../../admin/admin-errors.js';
import type { AdminActor } from '../../admin/admin.types.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import {
  WorkerEnrollmentInvitation,
  WorkerInstallationSession,
} from '../enrollment/worker-enrollment.schema.js';
import { WorkerAttempt } from '../jobs/worker-attempt.schema.js';
import { WorkerMachine } from '../machines/worker-machine.schema.js';
import { WorkerSlot } from '../machines/worker-slot.schema.js';
import { WorkerFleetPolicy } from '../policy/worker-fleet-policy.schema.js';
import { WorkerDiagnostic } from '../telemetry/worker-diagnostic.schema.js';
import { workerError } from '../worker-errors.js';
import { sanitizeWorkerDiagnosticLine } from '../telemetry/worker-diagnostic-sanitizer.js';
import { WorkerCommand } from './worker-command.schema.js';
import type {
  AdminWorkerListQueryDto,
  ApplyWorkerConfigDto,
  CompleteWorkerCommandDto,
  RequestWorkerBenchmarkDto,
  RequestWorkerDoctorDto,
  UpdateWorkerFleetPolicyDto,
  WorkerConfigQueryDto,
} from './worker-control.dto.js';

@Injectable()
export class WorkerControlService {
  constructor(
    @InjectModel(WorkerMachine.name)
    private readonly machines: Model<WorkerMachine>,
    @InjectModel(WorkerSlot.name)
    private readonly slots: Model<WorkerSlot>,
    @InjectModel(WorkerAttempt.name)
    private readonly attempts: Model<WorkerAttempt>,
    @InjectModel(WorkerFleetPolicy.name)
    private readonly policies: Model<WorkerFleetPolicy>,
    @InjectModel(WorkerEnrollmentInvitation.name)
    private readonly invitations: Model<WorkerEnrollmentInvitation>,
    @InjectModel(WorkerInstallationSession.name)
    private readonly installations: Model<WorkerInstallationSession>,
    @InjectModel(WorkerDiagnostic.name)
    private readonly diagnostics: Model<WorkerDiagnostic>,
    @InjectModel(WorkerCommand.name)
    private readonly commands: Model<WorkerCommand>,
    private readonly operations: AdminOperationsService,
  ) {}

  async config(principal: WorkerPrincipal, query: WorkerConfigQueryDto) {
    const machine = await this.currentMachine(principal, query);
    const policy = await this.policies
      .findById('worker-fleet')
      .maxTimeMS(2000)
      .lean();
    if (!policy) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    const commands = await this.commands
      .find({
        machineId: machine._id,
        state: 'pending',
        expiresAt: trusted({ $gt: new Date() }),
      })
      .sort({ createdAt: 1, _id: 1 })
      .limit(10)
      .lean();
    return {
      machineId: machine._id,
      machineStatus: machine.status,
      desiredRevision: machine.policyRevision,
      appliedRevision: machine.appliedRevision,
      claimAllowed:
        machine.status === 'active' &&
        policy.acceptClaims &&
        machine.policyRevision === policy.revision &&
        machine.appliedRevision === policy.revision,
      policy: presentPolicy(policy),
      compatibleRelease: null,
      commands: commands.map(presentCommand),
      serverTime: new Date().toISOString(),
    };
  }

  async applyConfig(principal: WorkerPrincipal, dto: ApplyWorkerConfigDto) {
    const machine = await this.currentMachine(principal, dto);
    const policy = await this.policies
      .findById('worker-fleet')
      .maxTimeMS(2000)
      .lean();
    if (!policy || policy.revision !== dto.revision)
      throw workerError('WORKER_CONFLICT');
    if (machine.appliedRevision === dto.revision)
      return {
        requestId: dto.requestId,
        revision: dto.revision,
        replayed: true,
      };
    const updated = await this.machines.updateOne(
      {
        _id: machine._id,
        revision: machine.revision,
        policyRevision: dto.revision,
        'currentSession.sessionId': dto.sessionId,
        'currentSession.incarnation': dto.incarnation,
      },
      {
        $set: {
          appliedRevision: dto.revision,
          lastSeenAt: new Date(),
          'currentSession.lastSeenAt': new Date(),
        },
        $inc: { revision: 1 },
      },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
    return {
      requestId: dto.requestId,
      revision: dto.revision,
      replayed: false,
    };
  }

  async listMachines(_actor: AdminActor, query: AdminWorkerListQueryDto) {
    const filter = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.groupId ? { groupId: query.groupId } : {}),
    };
    const machines = await this.machines
      .find(filter)
      .sort({ lastSeenAt: -1, _id: 1 })
      .limit(query.limit)
      .maxTimeMS(3000)
      .lean();
    return { items: machines.map(presentMachine), nextCursor: null };
  }

  async machineDetail(_actor: AdminActor, id: string) {
    const machine = await this.machines.findById(id).maxTimeMS(2000).lean();
    if (!machine) throw adminError('RESOURCE_NOT_FOUND');
    const [slots, attempts, diagnostics, installation, commands] =
      await Promise.all([
        this.slots
          .find({ machineId: id })
          .sort({ slotIndex: 1 })
          .limit(32)
          .lean(),
        this.attempts
          .find({ machineId: id })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),
        this.diagnostics
          .find({ machineId: id })
          .sort({ createdAt: -1, _id: -1 })
          .limit(50)
          .lean(),
        this.installations.findOne({ machineId: id }).lean(),
        this.commands
          .find({ machineId: id })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),
      ]);
    return {
      machine: presentMachine(machine),
      slots,
      attempts: attempts.map((attempt) => ({
        attemptId: attempt._id,
        jobId: attempt.jobId.toHexString(),
        workerId: attempt.workerId,
        state: attempt.state,
        stage: attempt.stage,
        attemptNumber: attempt.attemptNumber,
        leaseExpiresAt: attempt.leaseExpiresAt,
        deadlineAt: attempt.deadlineAt,
        terminalCode: attempt.terminalCode,
        terminalSummary: attempt.terminalSummary,
        finishedAt: attempt.finishedAt,
      })),
      diagnostics: diagnostics.map((item) => ({
        id: item._id,
        kind: item.kind,
        sequenceStart: item.sequenceStart,
        sequenceEnd: item.sequenceEnd,
        lineCount: item.lines.length,
        metricCount: item.metrics.length,
        createdAt: item.createdAt,
      })),
      installation: installation
        ? {
            id: installation._id,
            phase: installation.phase,
            outcomeCode: installation.outcomeCode,
            reportSummary: installation.reportSummary,
            activatedAt: installation.activatedAt,
          }
        : null,
      commands: commands.map(presentCommand),
    };
  }

  async machineDiagnostics(_actor: AdminActor, id: string) {
    if (!(await this.machines.exists({ _id: id })))
      throw adminError('RESOURCE_NOT_FOUND');
    const items = await this.diagnostics
      .find({ machineId: id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .lean();
    return {
      items: items.map((item) => ({
        id: item._id,
        kind: item.kind,
        sequenceStart: item.sequenceStart,
        sequenceEnd: item.sequenceEnd,
        lines: item.lines,
        metrics: item.metrics,
        createdAt: item.createdAt,
      })),
    };
  }

  async listInvitations(_actor: AdminActor) {
    const now = new Date();
    const items = await this.invitations
      .find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return {
      items: items.map((item) => ({
        invitationId: item._id,
        state:
          item.state === 'active' && item.expiresAt <= now
            ? 'expired'
            : item.state,
        createdByUid: item.createdByUid,
        initialPolicyId: item.initialPolicyId,
        expiresAt: item.expiresAt,
        consumedAt: item.consumedAt,
        revokedAt: item.revokedAt,
        installationSessionId: item.installationSessionId,
        revision: item.revision,
      })),
    };
  }

  async policy(_actor: AdminActor) {
    const policy = await this.policies.findById('worker-fleet').lean();
    if (!policy) throw adminError('DEPENDENCY_UNAVAILABLE');
    return presentPolicy(policy);
  }

  requestDoctor(actor: AdminActor, id: string, dto: RequestWorkerDoctorDto) {
    return this.requestCommand(actor, id, dto, {
      kind: 'doctor',
      checks: dto.checks,
      recipeId: null,
      iterations: null,
    });
  }

  requestBenchmark(
    actor: AdminActor,
    id: string,
    dto: RequestWorkerBenchmarkDto,
  ) {
    return this.requestCommand(actor, id, dto, {
      kind: 'benchmark',
      checks: [],
      recipeId: dto.recipeId,
      iterations: dto.iterations,
    });
  }

  async completeCommand(
    principal: WorkerPrincipal,
    id: string,
    dto: CompleteWorkerCommandDto,
  ) {
    if (!isUUID(id, '4')) throw workerError('WORKER_INVALID_REQUEST');
    const machine = await this.currentMachine(principal, dto);
    const command = await this.commands.findById(id).lean();
    if (!command || command.machineId !== machine._id)
      throw workerError('WORKER_CONFLICT');
    const summary = sanitizeWorkerDiagnosticLine(dto.summary);
    if (command.state !== 'pending') {
      if (
        command.resultRequestId !== dto.requestId ||
        command.state !== dto.outcome ||
        command.summary !== summary ||
        JSON.stringify(command.metrics) !== JSON.stringify(dto.metrics)
      )
        throw workerError('WORKER_CONFLICT');
      return { commandId: id, state: command.state, replayed: true };
    }
    if (command.expiresAt <= new Date()) throw workerError('WORKER_EXPIRED');
    const updated = await this.commands.updateOne(
      {
        _id: id,
        machineId: machine._id,
        state: 'pending',
        revision: command.revision,
      },
      {
        $set: {
          state: dto.outcome,
          resultRequestId: dto.requestId,
          summary,
          metrics: dto.metrics,
          completedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
      { runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
    return { commandId: id, state: dto.outcome, replayed: false };
  }

  async updatePolicy(actor: AdminActor, dto: UpdateWorkerFleetPolicyDto) {
    if (
      new Set(dto.recipes.map((recipe) => recipe.recipeId)).size !==
      dto.recipes.length
    )
      throw adminError('INVALID_REQUEST');
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'PUT /admin/worker-fleet/policy',
        request: {
          expectedRevision: dto.expectedRevision,
          acceptClaims: dto.acceptClaims,
          recipes: dto.recipes,
          leaseSeconds: dto.leaseSeconds,
          processingDeadlineSeconds: dto.processingDeadlineSeconds,
        },
        action: 'workers.policy.update',
        resourceType: 'worker_fleet_policy',
        reason: dto.reason,
      },
      async (session) => {
        const current = await this.policies
          .findById('worker-fleet')
          .session(session)
          .lean();
        if (!current) throw adminError('RESOURCE_NOT_FOUND');
        if (current.revision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const revision = current.revision + 1;
        const updated = await this.policies.updateOne(
          { _id: 'worker-fleet', revision: current.revision },
          {
            $set: {
              acceptClaims: dto.acceptClaims,
              recipes: dto.recipes,
              leaseSeconds: dto.leaseSeconds,
              processingDeadlineSeconds: dto.processingDeadlineSeconds,
              updatedAt: new Date(),
              updatedByUid: actor.uid,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (updated.modifiedCount !== 1) throw adminError('REVISION_CONFLICT');
        await this.machines.updateMany(
          { status: trusted({ $ne: 'revoked' }) },
          {
            $set: { policyRevision: revision, desiredRevision: revision },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        return {
          resourceId: 'worker-fleet',
          previousRevision: current.revision,
          revision,
          value: { revision },
        };
      },
    );
    return { revision: result.receipt.revision, replayed: result.replayed };
  }

  private async requestCommand(
    actor: AdminActor,
    id: string,
    dto: RequestWorkerDoctorDto | RequestWorkerBenchmarkDto,
    command: {
      kind: 'doctor' | 'benchmark';
      checks: string[];
      recipeId: string | null;
      iterations: number | null;
    },
  ) {
    if (!isUUID(id, '4')) throw adminError('INVALID_REQUEST');
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: `POST /admin/worker-fleet/machines/:id/${command.kind}`,
        request: { id, expectedRevision: dto.expectedRevision, ...command },
        action: `workers.machine.${command.kind}`,
        resourceType: 'worker_command',
        reason: dto.reason,
      },
      async (session) => {
        const machine = await this.machines
          .findById(id)
          .session(session)
          .lean();
        if (!machine) throw adminError('RESOURCE_NOT_FOUND');
        if (machine.revision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        if (machine.status === 'revoked') throw adminError('INVALID_REQUEST');
        const busy = Boolean(
          await this.slots
            .exists({ machineId: id, currentAttemptId: trusted({ $ne: null }) })
            .session(session),
        );
        const commandId = randomUUID();
        await this.commands.create(
          [
            {
              _id: commandId,
              machineId: id,
              ...command,
              state: 'pending',
              requestedByUid: actor.uid,
              requestedAt: new Date(),
              expiresAt: new Date(Date.now() + 3_600_000),
            },
          ],
          { session },
        );
        return {
          resourceId: commandId,
          previousRevision: machine.revision,
          revision: 0,
          value: { commandId, deferred: command.kind === 'benchmark' && busy },
        };
      },
    );
    return {
      commandId: result.receipt.resourceId,
      deferred: result.value?.deferred ?? null,
      replayed: result.replayed,
    };
  }

  private async currentMachine(
    principal: WorkerPrincipal,
    identity: WorkerConfigQueryDto,
  ) {
    if (principal.kind !== 'machine')
      throw workerError('WORKER_UNAUTHENTICATED');
    const machine = await this.machines
      .findById(principal.subjectId)
      .maxTimeMS(2000)
      .lean();
    if (
      !machine ||
      machine.status === 'revoked' ||
      machine.currentSession?.sessionId !== identity.sessionId ||
      machine.currentSession.incarnation !== identity.incarnation
    )
      throw workerError('WORKER_UNAUTHENTICATED');
    return machine;
  }
}

function presentPolicy(policy: WorkerFleetPolicy) {
  return {
    revision: policy.revision,
    acceptClaims: policy.acceptClaims,
    recipes: policy.recipes,
    leaseSeconds: policy.leaseSeconds,
    processingDeadlineSeconds: policy.processingDeadlineSeconds,
    updatedAt: policy.updatedAt,
  };
}

function presentMachine(machine: WorkerMachine) {
  return {
    machineId: machine._id,
    status: machine.status,
    label: machine.label,
    groupId: machine.groupId,
    policyRevision: machine.policyRevision,
    appliedRevision: machine.appliedRevision,
    desiredRevision: machine.desiredRevision,
    capabilities: machine.approvedCapabilities,
    hardware: machine.hardwareReport,
    runtime: machine.runtimeIdentity,
    session: machine.currentSession,
    lastSeenAt: machine.lastSeenAt,
    revokedAt: machine.revokedAt,
    revision: machine.revision,
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt,
  };
}

function presentCommand(command: WorkerCommand) {
  return {
    commandId: command._id,
    kind: command.kind,
    state: command.state,
    checks: command.checks,
    recipeId: command.recipeId,
    iterations: command.iterations,
    requestedAt: command.requestedAt,
    expiresAt: command.expiresAt,
    summary: command.summary,
    metrics: command.metrics,
    completedAt: command.completedAt,
    revision: command.revision,
  };
}
