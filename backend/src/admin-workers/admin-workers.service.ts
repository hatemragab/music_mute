import { Injectable } from '@nestjs/common';
import { reserveCredential } from '../worker-installations/credential-reservation.schema.js';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { AdminAuditService } from '../admin/admin-audit.service.js';
import { adminError } from '../admin/admin-errors.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import { WorkerControl } from '../worker/worker-control.schema.js';
import { WorkerRegistration } from '../worker/worker-registration.schema.js';
import { WorkerRegistryService } from '../worker/worker-registry.service.js';
import { WorkerRecoveryService } from '../worker/worker-recovery.service.js';
import {
  presentWorker,
  validateStopEvidence,
  workerId,
  workerPage,
} from './admin-workers.presenter.js';
import type {
  RenameAdminWorkerDto,
  RevokeAdminWorkerDto,
  ReleaseStoppedWorkerDto,
  UpdateAdminWorkerDto,
} from './dto/admin-worker.dto.js';

type WorkerWrite =
  'rename' | 'drain' | 'enable' | 'rotate-key' | 'revoke' | 'release-stopped';
type WorkerWriteDto =
  | UpdateAdminWorkerDto
  | RenameAdminWorkerDto
  | RevokeAdminWorkerDto
  | ReleaseStoppedWorkerDto;

@Injectable()
export class AdminWorkersService {
  constructor(
    @InjectModel(WorkerRegistration.name)
    private readonly registrations: Model<WorkerRegistration>,
    @InjectModel(WorkerControl.name)
    private readonly controls: Model<WorkerControl>,
    private readonly registry: WorkerRegistryService,
    private readonly recovery: WorkerRecoveryService,
    private readonly operations: AdminOperationsService,
    private readonly audit: AdminAuditService,
    private readonly config: ConfigService,
  ) {}

  private present(
    registration: WorkerRegistration,
    control: WorkerControl | null,
    now = new Date(),
  ) {
    return presentWorker(
      registration,
      control,
      now,
      this.config.getOrThrow<number>('PROCESSING_LEASE_SECONDS'),
    );
  }

  async list(raw: Record<string, unknown>) {
    const query = workerPage(raw);
    const now = new Date();
    const since = new Date(
      +now - this.config.getOrThrow<number>('PROCESSING_LEASE_SECONDS') * 1000,
    );
    const rows = await this.registrations
      .aggregate<WorkerRegistration & { control: WorkerControl | null }>([
        {
          $match: {
            ...(query.state ? { state: query.state } : {}),
            ...(query.after ? { _id: { $gt: query.after } } : {}),
          },
        },
        { $project: { _id: 1, label: 1, state: 1 } },
        {
          $lookup: {
            from: 'audio_worker_control',
            localField: '_id',
            foreignField: '_id',
            as: 'controls',
          },
        },
        { $set: { control: { $arrayElemAt: ['$controls', 0] } } },
        ...(query.online === undefined
          ? []
          : [
              {
                $match: {
                  'control.lastSeenAt': query.online
                    ? { $gt: since }
                    : { $not: { $gt: since } },
                },
              },
            ]),
        { $sort: { _id: 1 } },
        { $limit: query.limit + 1 },
        { $project: { _id: 1, label: 1, state: 1, control: 1 } },
      ])
      .option({ maxTimeMS: 5000 });
    const visible = rows.slice(0, query.limit);
    return {
      items: visible.map((row) => this.present(row, row.control, now)),
      nextCursor:
        rows.length > query.limit
          ? Buffer.from(
              JSON.stringify({ id: visible.at(-1)!._id, scope: query.scope }),
            ).toString('base64url')
          : null,
      asOf: now.toISOString(),
    };
  }

  async detail(id: string) {
    const { registration, control } = await this.read(workerId(id));
    const worker = this.present(registration, control);
    const events = await this.audit.list({
      resourceType: 'worker',
      resourceId: id,
      limit: '20',
    });
    return {
      ...worker,
      protocolVersion: 3,
      slotState: worker.recoveryRequired
        ? 'recovery_required'
        : control?.activeJobId
          ? 'active'
          : 'idle',
      assignment: control?.activeJobId
        ? {
            jobId: control.activeJobId.toString(),
            attemptId: control.attemptId,
            sessionId: control.sessionId,
            generation: control.generation,
            leaseExpiresAt: control.leaseExpiresAt?.toISOString() ?? null,
          }
        : null,
      recentEvents: events.items.map((event) => ({
        id: event.id,
        action: event.action,
        at: event.at,
        outcome: event.outcome,
      })),
    };
  }

  async update(
    actor: AdminActor,
    id: string,
    action: WorkerWrite,
    dto: WorkerWriteDto,
  ) {
    this.authorize(
      actor,
      action === 'release-stopped' ? 'workers.recover' : 'workers.manage',
    );
    workerId(id);
    if (action === 'release-stopped') {
      const proof = dto as ReleaseStoppedWorkerDto;
      validateStopEvidence(proof.stopEvidence, proof.stoppedAt);
    }
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route:
          action === 'rename'
            ? 'PATCH /admin/workers/:id'
            : `POST /admin/workers/:id/${action}`,
        request: { id, ...dto },
        action: `workers.${action}`,
        resourceType: 'worker',
        reason: dto.reason,
      },
      async (session) => {
        const { registration, control } = await this.read(id, session);
        if (!control) throw adminError('RECOVERY_PROOF_REQUIRED');
        if (control.managementRevision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const previousRevision = control.managementRevision;
        // The same control-document write remains serialized with worker authority fences.
        const managementUpdate = await this.controls.updateOne(
          { _id: id, managementRevision: dto.expectedRevision },
          { $inc: { managementRevision: 1 } },
          { session },
        );
        if (managementUpdate.matchedCount !== 1)
          throw adminError('REVISION_CONFLICT');
        control.managementRevision = previousRevision + 1;
        const active = Boolean(
          control.activeJobId || control.attemptId || control.sessionId,
        );
        if (action === 'release-stopped') {
          const proof = dto as ReleaseStoppedWorkerDto;
          await this.recovery.releaseStopped(
            id,
            { ...proof, expectedRevision: control.controlRevision },
            session,
          );
          const latest = await this.controls.findById(id).session(session);
          return {
            resourceId: id,
            previousRevision,
            revision: latest!.managementRevision,
            stopEvidence: {
              attestation: proof.stopEvidence,
              stoppedAt: proof.stoppedAt,
              jobId: proof.jobId,
              attemptId: proof.attemptId,
              sessionId: proof.sessionId,
              generation: proof.generation,
            },
            value: {
              worker: this.present(registration, latest),
              rawKey: undefined as string | undefined,
            },
          };
        }
        if (registration.state === 'revoked' && action !== 'rename')
          throw adminError('REVISION_CONFLICT');
        if (action === 'rotate-key' && active)
          throw adminError('WORKER_NOT_IDLE');
        if (
          action === 'revoke' &&
          active &&
          (dto as RevokeAdminWorkerDto).emergency !== true
        )
          throw adminError('WORKER_NOT_IDLE');
        let rawKey: string | undefined;
        if (action === 'rename')
          registration.label = (dto as RenameAdminWorkerDto).label;
        if (action === 'drain') registration.state = 'draining';
        if (action === 'enable') registration.state = 'enabled';
        if (action === 'revoke') registration.state = 'revoked';
        if (action === 'rotate-key') {
          rawKey = randomBytes(32).toString('hex');
          registration.keySha256 = createHash('sha256')
            .update(rawKey)
            .digest('hex');
          await reserveCredential(
            this.registrations.db,
            session,
            registration.keySha256,
            'worker',
            id,
          );
        }
        await this.registry.touchControl(control, session);
        await registration.save({ session });
        return {
          resourceId: id,
          previousRevision,
          revision: control.managementRevision,
          value: { worker: this.present(registration, control), rawKey },
        };
      },
    );
    if (action === 'rotate-key')
      return result.value ?? { operation: result.receipt };
    if (result.value) return result.value.worker;
    const { registration, control } = await this.read(id);
    return this.present(registration, control);
  }

  private authorize(
    actor: AdminActor,
    permission: 'workers.manage' | 'workers.recover',
  ) {
    if (!actor.permissions.includes(permission))
      throw adminError('PERMISSION_DENIED');
  }
  private async read(id: string, session?: ClientSession) {
    const registryQuery = this.registrations.findById(id).maxTimeMS(5000);
    const controlQuery = this.controls.findById(id).maxTimeMS(5000);
    if (session) {
      registryQuery.session(session);
      controlQuery.session(session);
    }
    const registration = await registryQuery;
    if (!registration) throw adminError('RESOURCE_NOT_FOUND');
    return { registration, control: await controlQuery };
  }
}
