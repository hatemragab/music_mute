import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import {
  trusted,
  type ClientSession,
  type Connection,
  type Model,
} from 'mongoose';
import type mongoose from 'mongoose';
import { ProcessingAdmissionService } from '../../admin-settings/processing-admission.service.js';
import { Job } from '../../jobs/job.schema.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerAttempt } from '../jobs/worker-attempt.schema.js';
import { WorkerMachine } from '../machines/worker-machine.schema.js';
import { WorkerSlot } from '../machines/worker-slot.schema.js';
import { WorkerFleetPolicy } from '../policy/worker-fleet-policy.schema.js';
import { workerError } from '../worker-errors.js';
import type {
  ClaimWorkerJobDto,
  OpenWorkerSessionDto,
  RegisterWorkerSlotDto,
} from './worker-claim.dto.js';

const ACTIVE_ATTEMPT_STATES = ['claimed', 'running', 'uploading'] as const;

@Injectable()
export class WorkerClaimService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WorkerMachine.name)
    private readonly machines: Model<WorkerMachine>,
    @InjectModel(WorkerSlot.name)
    private readonly slots: Model<WorkerSlot>,
    @InjectModel(WorkerAttempt.name)
    private readonly attempts: Model<WorkerAttempt>,
    @InjectModel(WorkerFleetPolicy.name)
    private readonly policies: Model<WorkerFleetPolicy>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly admission: ProcessingAdmissionService,
  ) {}

  async openSession(principal: WorkerPrincipal, dto: OpenWorkerSessionDto) {
    const machineId = this.machineId(principal);
    const machine = await this.machines
      .findById(machineId)
      .maxTimeMS(2000)
      .lean();
    if (!machine || machine.status === 'revoked')
      throw workerError('WORKER_UNAUTHENTICATED');
    if (
      machine.currentSession?.sessionId === dto.sessionId &&
      machine.currentSession.incarnation === dto.incarnation
    ) {
      await this.fenceSupersededSessions(
        machineId,
        dto.sessionId,
        dto.incarnation,
        new Date(),
      );
      return this.presentSession(machine, true);
    }
    const now = new Date();
    const generation = machine.supervisorGeneration + 1;
    const updated = await this.machines
      .findOneAndUpdate(
        {
          _id: machineId,
          revision: machine.revision,
          status: trusted({ $in: ['active', 'paused', 'draining'] }),
        },
        {
          $set: {
            currentSession: {
              sessionId: dto.sessionId,
              incarnation: dto.incarnation,
              generation,
              startedAt: now,
              lastSeenAt: now,
            },
            supervisorGeneration: generation,
            lastSeenAt: now,
          },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!updated) throw workerError('WORKER_CONFLICT');
    await this.fenceSupersededSessions(
      machineId,
      dto.sessionId,
      dto.incarnation,
      now,
    );
    await this.slots.updateMany(
      { machineId, currentAttemptId: null },
      { $set: { state: 'offline', lastSeenAt: now }, $inc: { revision: 1 } },
      { runValidators: true },
    );
    return this.presentSession(updated, false);
  }

  private async fenceSupersededSessions(
    machineId: string,
    sessionId: string,
    incarnation: string,
    now: Date,
  ): Promise<void> {
    const superseded = {
      machineId,
      $or: [
        { sessionId: trusted({ $ne: sessionId }) },
        { incarnation: trusted({ $ne: incarnation }) },
      ],
    };
    await this.attempts.updateMany(
      {
        ...superseded,
        state: trusted({ $in: ACTIVE_ATTEMPT_STATES }),
      },
      { $set: { leaseExpiresAt: now }, $inc: { revision: 1 } },
      { runValidators: true },
    );
    await this.jobs.updateMany(
      {
        'currentExecution.machineId': machineId,
        $or: [
          {
            'currentExecution.sessionId': trusted({ $ne: sessionId }),
          },
          {
            'currentExecution.incarnation': trusted({ $ne: incarnation }),
          },
        ],
      },
      { $set: { 'currentExecution.leaseExpiresAt': now } },
      { runValidators: true },
    );
  }

  async registerSlot(principal: WorkerPrincipal, dto: RegisterWorkerSlotDto) {
    const machineId = this.machineId(principal);
    const machine = await this.machines
      .findById(machineId)
      .maxTimeMS(2000)
      .lean();
    this.assertMachineSession(machine, dto.sessionId, dto.incarnation, false);
    const capability = machine!.approvedCapabilities.find(
      (candidate) => candidate.gpuId === dto.gpuId,
    );
    if (
      !capability ||
      dto.slotIndex >= capability.maxSlots ||
      dto.recipeIds.some((recipe) => !capability.recipeIds.includes(recipe))
    )
      throw workerError('WORKER_FORBIDDEN');
    const current = await this.slots
      .findById(dto.workerId)
      .maxTimeMS(2000)
      .lean();
    if (current?.currentAttemptId) throw workerError('WORKER_CONFLICT');
    if (
      current &&
      (current.machineId !== machineId ||
        current.gpuId !== dto.gpuId ||
        current.slotIndex !== dto.slotIndex)
    )
      throw workerError('WORKER_CONFLICT');
    const now = new Date();
    let slot: WorkerSlot | null;
    try {
      slot = await this.slots
        .findOneAndUpdate(
          { _id: dto.workerId, currentAttemptId: null },
          {
            $set: {
              sessionId: dto.sessionId,
              incarnation: dto.incarnation,
              state: 'idle',
              allowedRecipeIds: dto.recipeIds,
              lastSeenAt: now,
            },
            $setOnInsert: {
              machineId,
              gpuId: dto.gpuId,
              slotIndex: dto.slotIndex,
            },
            $inc: { revision: 1 },
          },
          {
            upsert: true,
            returnDocument: 'after',
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        )
        .lean();
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw workerError('WORKER_CONFLICT');
      throw error;
    }
    if (!slot) throw workerError('WORKER_CONFLICT');
    return {
      workerId: slot._id,
      state: slot.state,
      revision: slot.revision,
      serverTime: now.toISOString(),
    };
  }

  async claim(principal: WorkerPrincipal, dto: ClaimWorkerJobDto) {
    const machineId = this.machineId(principal);
    const session = await this.connection.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const machine = await this.machines
          .findById(machineId)
          .session(session)
          .lean();
        this.assertMachineSession(
          machine,
          dto.sessionId,
          dto.incarnation,
          false,
        );
        const replay = await this.attempts
          .findOne({ machineId, claimRequestId: dto.requestId })
          .session(session)
          .lean();
        if (replay) {
          if (
            !ACTIVE_ATTEMPT_STATES.some((state) => state === replay.state) ||
            replay.workerId !== dto.workerId ||
            replay.gpuId !== dto.gpuId ||
            replay.sessionId !== dto.sessionId ||
            replay.incarnation !== dto.incarnation
          )
            throw workerError('WORKER_CONFLICT');
          const job = await this.jobs
            .findById(replay.jobId)
            .session(session)
            .lean();
          if (!job || job.currentExecution?.attemptId !== replay._id)
            throw workerError('WORKER_CONFLICT');
          return this.presentClaim(job, replay, true);
        }
        if (machine!.status !== 'active') throw workerError('WORKER_FORBIDDEN');
        if (
          machine!.policyRevision !== dto.appliedPolicyRevision ||
          machine!.appliedRevision !== dto.appliedPolicyRevision
        )
          throw workerError('WORKER_CONFLICT');
        const policy = await this.policies
          .findById('worker-fleet')
          .session(session)
          .lean();
        const enabledRecipes =
          policy?.recipes.filter((recipe) => recipe.enabled) ?? [];
        if (
          !policy ||
          !policy.acceptClaims ||
          policy.revision !== dto.appliedPolicyRevision ||
          enabledRecipes.length === 0
        )
          throw workerError('WORKER_FORBIDDEN');
        const slot = await this.slots
          .findOne({
            _id: dto.workerId,
            machineId,
            gpuId: dto.gpuId,
            slotIndex: dto.slotIndex,
            sessionId: dto.sessionId,
            incarnation: dto.incarnation,
            state: 'idle',
            currentAttemptId: null,
          })
          .session(session)
          .lean();
        if (!slot) throw workerError('WORKER_CONFLICT');
        const eligibleRecipes = enabledRecipes
          .filter((recipe) => slot.slotIndex < recipe.maxSlotsPerMachine)
          .map((recipe) => recipe.recipeId)
          .filter((recipe) => slot.allowedRecipeIds.includes(recipe));
        if (eligibleRecipes.length === 0) throw workerError('WORKER_FORBIDDEN');
        const candidate = await this.oldestEligibleCandidate(
          {
            status: 'queued',
            deletedAt: null,
            queuedAt: trusted({ $ne: null }),
            currentExecution: null,
            inputObject: trusted({ $ne: null }),
            recipeSnapshot: trusted({ $ne: null }),
            'recipeSnapshot.recipeId': trusted({
              $in: eligibleRecipes,
            }),
            'retryEligibility.eligible': true,
            'retryEligibility.attemptsRemaining': trusted({ $gt: 0 }),
            $expr: trusted({
              $lt: [
                '$attemptNumber',
                '$admissionSnapshot.maxInfrastructureAttempts',
              ],
            }),
            $or: [
              { 'retryEligibility.nextAttemptAt': null },
              {
                'retryEligibility.nextAttemptAt': trusted({ $lte: new Date() }),
              },
            ],
          },
          session,
        );
        if (!candidate) return null;
        const now = new Date();
        const attemptId = randomUUID();
        const attemptNumber = candidate.attemptNumber + 1;
        const leaseExpiresAt = new Date(
          now.getTime() + policy.leaseSeconds * 1000,
        );
        const deadlineAt = new Date(
          now.getTime() + policy.processingDeadlineSeconds * 1000,
        );
        const execution = {
          attemptId,
          machineId,
          workerId: dto.workerId,
          sessionId: dto.sessionId,
          incarnation: dto.incarnation,
          leaseExpiresAt,
          deadlineAt,
        };
        const machineFence = await this.machines.updateOne(
          {
            _id: machineId,
            status: 'active',
            revision: machine!.revision,
            'currentSession.sessionId': dto.sessionId,
            'currentSession.incarnation': dto.incarnation,
            policyRevision: dto.appliedPolicyRevision,
            appliedRevision: dto.appliedPolicyRevision,
          },
          { $inc: { revision: 1 }, $set: { lastSeenAt: now } },
          { session, runValidators: true },
        );
        if (machineFence.modifiedCount !== 1)
          throw workerError('WORKER_CONFLICT');
        const slotFence = await this.slots.updateOne(
          {
            _id: slot._id,
            revision: slot.revision,
            state: 'idle',
            currentAttemptId: null,
            sessionId: dto.sessionId,
            incarnation: dto.incarnation,
          },
          {
            $set: {
              state: 'reserved',
              currentAttemptId: attemptId,
              lastSeenAt: now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (slotFence.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
        const job = await this.jobs
          .findOneAndUpdate(
            {
              _id: candidate._id,
              status: 'queued',
              revision: candidate.revision,
              currentExecution: null,
              inputObject: trusted({ $ne: null }),
              recipeSnapshot: trusted({ $ne: null }),
            },
            {
              $set: {
                status: 'processing',
                currentExecution: execution,
                processingStartedAt: candidate.processingStartedAt ?? now,
              },
              $inc: { attemptNumber: 1, revision: 1 },
            },
            { session, returnDocument: 'after', runValidators: true },
          )
          .lean();
        if (!job) throw workerError('WORKER_CONFLICT');
        const [attempt] = await this.attempts.create(
          [
            {
              _id: attemptId,
              jobId: job._id,
              machineId,
              workerId: dto.workerId,
              gpuId: dto.gpuId,
              sessionId: dto.sessionId,
              incarnation: dto.incarnation,
              claimRequestId: dto.requestId,
              attemptNumber,
              state: 'claimed',
              stage: 'claimed',
              leaseExpiresAt,
              deadlineAt,
            },
          ],
          { session },
        );
        return this.presentClaim(job, attempt.toObject(), false);
      });
      return {
        claim: result,
        serverTime: new Date().toISOString(),
      };
    } finally {
      await session.endSession();
    }
  }

  private async oldestEligibleCandidate(
    eligibility: mongoose.QueryFilter<Job>,
    session: ClientSession,
  ): Promise<Job | null> {
    let cursor: { _id: Job['_id']; queuedAt: Date } | null = null;
    while (true) {
      const candidate: Job | null = await this.jobs
        .findOne({
          $and: [
            eligibility,
            ...(cursor
              ? [
                  {
                    $or: [
                      { queuedAt: { $gt: cursor.queuedAt } },
                      {
                        queuedAt: cursor.queuedAt,
                        _id: { $gt: cursor._id },
                      },
                    ],
                  },
                ]
              : []),
          ],
        })
        .sort({ queuedAt: 1, _id: 1 })
        .session(session)
        .lean();
      if (!candidate) return null;
      if (await this.admission.claimProcessingSlot(candidate, session))
        return candidate;
      if (!candidate.queuedAt) return null;
      cursor = { _id: candidate._id, queuedAt: candidate.queuedAt };
    }
  }

  private machineId(principal: WorkerPrincipal): string {
    if (principal.kind !== 'machine')
      throw workerError('WORKER_UNAUTHENTICATED');
    return principal.subjectId;
  }

  private assertMachineSession(
    machine: WorkerMachine | null,
    sessionId: string,
    incarnation: string,
    requireActive: boolean,
  ): void {
    if (!machine || machine.status === 'revoked')
      throw workerError('WORKER_UNAUTHENTICATED');
    if (requireActive && machine.status !== 'active')
      throw workerError('WORKER_FORBIDDEN');
    if (
      machine.currentSession?.sessionId !== sessionId ||
      machine.currentSession.incarnation !== incarnation
    )
      throw workerError('WORKER_CONFLICT');
  }

  private presentSession(machine: WorkerMachine, replayed: boolean) {
    return {
      machineId: machine._id,
      session: machine.currentSession,
      policyRevision: machine.policyRevision,
      replayed,
      serverTime: new Date().toISOString(),
    };
  }

  private presentClaim(job: Job, attempt: WorkerAttempt, replayed: boolean) {
    return {
      attemptId: attempt._id,
      jobId: job._id.toString(),
      attemptNumber: attempt.attemptNumber,
      leaseExpiresAt: attempt.leaseExpiresAt.toISOString(),
      deadlineAt: attempt.deadlineAt.toISOString(),
      input: job.inputObject,
      recipe: job.recipeSnapshot,
      replayed,
    };
  }
}
