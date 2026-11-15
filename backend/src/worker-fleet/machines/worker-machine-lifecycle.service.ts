import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerAttempt } from '../jobs/worker-attempt.schema.js';
import { workerError } from '../worker-errors.js';
import { WorkerMachine } from './worker-machine.schema.js';

const ACTIVE_ATTEMPT_STATES = ['claimed', 'running', 'uploading'] as const;

@Injectable()
export class WorkerMachineLifecycleService {
  constructor(
    @InjectModel(WorkerMachine.name)
    private readonly machines: Model<WorkerMachine>,
    @InjectModel(WorkerAttempt.name)
    private readonly attempts: Model<WorkerAttempt>,
  ) {}

  async status(principal: WorkerPrincipal) {
    if (principal.kind !== 'machine')
      throw workerError('WORKER_UNAUTHENTICATED');
    const machine = await this.machines
      .findOne({
        _id: principal.subjectId,
        status: { $ne: 'revoked' },
      })
      .select({
        _id: 1,
        status: 1,
        groupId: 1,
        policyRevision: 1,
        revision: 1,
        lastSeenAt: 1,
      })
      .maxTimeMS(2000)
      .lean();
    if (!machine) throw workerError('WORKER_UNAUTHENTICATED');
    const activeAttempts = await this.attempts
      .countDocuments({
        machineId: principal.subjectId,
        state: { $in: ACTIVE_ATTEMPT_STATES },
      })
      .maxTimeMS(2000);
    return {
      machineId: machine._id,
      status: machine.status,
      groupId: machine.groupId,
      policyRevision: machine.policyRevision,
      revision: machine.revision,
      lastSeenAt: machine.lastSeenAt?.toISOString() ?? null,
      activeAttempts,
      claimsAllowed: machine.status === 'active',
    };
  }

  async unpair(principal: WorkerPrincipal, force = false) {
    if (principal.kind !== 'machine')
      throw workerError('WORKER_UNAUTHENTICATED');
    const credentialDigest = createHash('sha256')
      .update(principal.credential)
      .digest('hex');
    if (principal.machineStatus === 'revoked') {
      const revoked = await this.machines
        .findOne({
          _id: principal.subjectId,
          credentialDigest,
          status: 'revoked',
        })
        .select({ _id: 1, revision: 1 })
        .maxTimeMS(2000)
        .lean();
      if (!revoked) throw workerError('WORKER_UNAUTHENTICATED');
      return {
        machineId: revoked._id,
        status: 'revoked' as const,
        confirmed: true as const,
        revision: revoked.revision,
      };
    }
    const activeAttempt = await this.attempts
      .exists({
        machineId: principal.subjectId,
        state: { $in: ACTIVE_ATTEMPT_STATES },
      })
      .maxTimeMS(2000);
    if (activeAttempt && !force) throw workerError('WORKER_CONFLICT');
    const now = new Date();
    const machine = await this.machines
      .findOneAndUpdate(
        {
          _id: principal.subjectId,
          credentialDigest,
          status: { $ne: 'revoked' },
        },
        {
          $set: {
            status: 'revoked',
            revokedAt: now,
            currentSession: null,
            lastSeenAt: now,
          },
          $inc: { revision: 1, credentialRevision: 1 },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!machine) throw workerError('WORKER_UNAUTHENTICATED');
    return {
      machineId: machine._id,
      status: 'revoked' as const,
      confirmed: true as const,
      revision: machine.revision,
    };
  }
}
