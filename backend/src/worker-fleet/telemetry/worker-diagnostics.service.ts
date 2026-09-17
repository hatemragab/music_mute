import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import type { Connection, Model } from 'mongoose';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerInstallationSession } from '../enrollment/worker-enrollment.schema.js';
import { WorkerMachine } from '../machines/worker-machine.schema.js';
import { workerError } from '../worker-errors.js';
import type {
  AppendInstallationLogsDto,
  AppendRuntimeLogsDto,
} from './worker-diagnostic.dto.js';
import { WorkerDiagnostic } from './worker-diagnostic.schema.js';
import { sanitizeWorkerDiagnosticLine } from './worker-diagnostic-sanitizer.js';

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

@Injectable()
export class WorkerDiagnosticsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WorkerInstallationSession.name)
    private readonly installations: Model<WorkerInstallationSession>,
    @InjectModel(WorkerDiagnostic.name)
    private readonly diagnostics: Model<WorkerDiagnostic>,
    @InjectModel(WorkerMachine.name)
    private readonly machines: Model<WorkerMachine>,
  ) {}

  async appendInstallationLogs(
    principal: WorkerPrincipal,
    installationId: string,
    dto: AppendInstallationLogsDto,
  ) {
    if (
      principal.kind !== 'installation' ||
      principal.subjectId !== installationId
    )
      throw workerError('WORKER_NOT_FOUND');
    if (
      dto.sequenceEnd < dto.sequenceStart ||
      dto.sequenceEnd - dto.sequenceStart + 1 !== dto.lines.length
    )
      throw workerError('WORKER_INVALID_REQUEST');
    const lines = dto.lines.map(sanitizeWorkerDiagnosticLine);
    const digest = createHash('sha256')
      .update(lines.join('\n'), 'utf8')
      .digest('hex');
    const existing = await this.diagnostics
      .findOne({ installationId, sequenceStart: dto.sequenceStart })
      .maxTimeMS(2000)
      .lean();
    if (existing) {
      if (
        existing.sequenceEnd !== dto.sequenceEnd ||
        existing.digest !== digest
      )
        throw workerError('WORKER_CONFLICT');
      return { acknowledgedSequence: existing.sequenceEnd, replayed: true };
    }
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.diagnostics.create(
          [
            {
              _id: randomUUID(),
              installationId,
              machineId: null,
              kind: 'installation_log',
              sequenceStart: dto.sequenceStart,
              sequenceEnd: dto.sequenceEnd,
              digest,
              lines,
              expiresAt: new Date(Date.now() + RETENTION_MS),
            },
          ],
          { session },
        );
        const acknowledged = await this.installations.updateOne(
          {
            _id: installationId,
            phase: { $in: ['restricted', 'reported', 'activated'] },
          },
          {
            $max: { acknowledgedSequence: dto.sequenceEnd },
            $set: { lastSeenAt: new Date() },
          },
          { session, runValidators: true },
        );
        if (acknowledged.matchedCount !== 1)
          throw workerError('WORKER_CONFLICT');
      });
      return { acknowledgedSequence: dto.sequenceEnd, replayed: false };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const concurrent = await this.diagnostics
        .findOne({ installationId, sequenceStart: dto.sequenceStart })
        .maxTimeMS(2000)
        .lean();
      if (
        !concurrent ||
        concurrent.sequenceEnd !== dto.sequenceEnd ||
        concurrent.digest !== digest
      )
        throw workerError('WORKER_CONFLICT');
      return { acknowledgedSequence: concurrent.sequenceEnd, replayed: true };
    } finally {
      await session.endSession();
    }
  }

  async appendRuntimeLogs(
    principal: WorkerPrincipal,
    dto: AppendRuntimeLogsDto,
  ) {
    if (principal.kind !== 'machine')
      throw workerError('WORKER_UNAUTHENTICATED');
    if (
      dto.sequenceEnd < dto.sequenceStart ||
      dto.sequenceEnd - dto.sequenceStart + 1 !== dto.lines.length
    )
      throw workerError('WORKER_INVALID_REQUEST');
    const machineId = principal.subjectId;
    const authenticated = await this.machines
      .findById(machineId)
      .maxTimeMS(2000)
      .lean();
    if (
      !authenticated ||
      authenticated.status === 'revoked' ||
      authenticated.currentSession?.sessionId !== dto.sessionId ||
      authenticated.currentSession.incarnation !== dto.incarnation
    )
      throw workerError('WORKER_UNAUTHENTICATED');
    const lines = dto.lines.map(sanitizeWorkerDiagnosticLine);
    const digest = createHash('sha256')
      .update(lines.join('\n'), 'utf8')
      .digest('hex');
    const findExisting = () =>
      this.diagnostics
        .findOne({
          machineId,
          kind: 'runtime_log',
          sequenceStart: dto.sequenceStart,
        })
        .maxTimeMS(2000)
        .lean();
    const existing = await findExisting();
    if (existing) {
      if (
        existing.sequenceEnd !== dto.sequenceEnd ||
        existing.digest !== digest
      )
        throw workerError('WORKER_CONFLICT');
      return { acknowledgedSequence: existing.sequenceEnd, replayed: true };
    }
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const machine = await this.machines
          .findById(machineId)
          .session(session)
          .lean();
        if (
          !machine ||
          machine.status === 'revoked' ||
          machine.currentSession?.sessionId !== dto.sessionId ||
          machine.currentSession.incarnation !== dto.incarnation
        )
          throw workerError('WORKER_UNAUTHENTICATED');
        await this.diagnostics.create(
          [
            {
              _id: randomUUID(),
              installationId: null,
              machineId,
              kind: 'runtime_log',
              sequenceStart: dto.sequenceStart,
              sequenceEnd: dto.sequenceEnd,
              digest,
              lines,
              expiresAt: new Date(Date.now() + RETENTION_MS),
            },
          ],
          { session },
        );
        const now = new Date();
        const acknowledged = await this.machines.updateOne(
          {
            _id: machineId,
            revision: machine.revision,
            'currentSession.sessionId': dto.sessionId,
            'currentSession.incarnation': dto.incarnation,
          },
          {
            $max: { acknowledgedDiagnosticSequence: dto.sequenceEnd },
            $set: {
              lastSeenAt: now,
              'currentSession.lastSeenAt': now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (acknowledged.modifiedCount !== 1)
          throw workerError('WORKER_CONFLICT');
      });
      return { acknowledgedSequence: dto.sequenceEnd, replayed: false };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const concurrent = await findExisting();
      if (
        !concurrent ||
        concurrent.sequenceEnd !== dto.sequenceEnd ||
        concurrent.digest !== digest
      )
        throw workerError('WORKER_CONFLICT');
      return { acknowledgedSequence: concurrent.sequenceEnd, replayed: true };
    } finally {
      await session.endSession();
    }
  }
}
