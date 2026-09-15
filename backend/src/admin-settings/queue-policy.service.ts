import { WorkerReadinessService } from '../worker/worker-readiness.service.js';
import {
  assertQualification,
  qualificationReady,
  type ProcessingQualification,
} from './processing-qualification.js';
import { WorkerRegistration } from '../worker/worker-registration.schema.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { ProcessingAdmissionFence } from './processing-settings.schema.js';
import {
  DEFAULT_QUEUE_POLICY,
  ProcessingQueuePolicy,
  validateQueuePolicy,
} from './queue-policy.schema.js';
import type { UpdateQueuePolicyDto } from './dto/queue-policy.dto.js';
export async function readQueuePolicy(
  model: Model<ProcessingQueuePolicy>,
  session?: ClientSession,
) {
  const stored = await model
    .findById('processing')
    .session(session ?? null)
    .lean();
  if (!stored)
    return {
      ...DEFAULT_QUEUE_POLICY,
      qualification: null,
      revision: 0,
      updatedAt: new Date(0),
    };
  try {
    if (
      !Number.isSafeInteger(stored.revision) ||
      stored.revision < 0 ||
      !(stored.updatedAt instanceof Date) ||
      !Number.isFinite(stored.updatedAt.getTime())
    )
      throw new Error();
    validateQueuePolicy(stored);
    if (stored.qualification)
      assertQualification(stored.qualification, new Date(), true);
  } catch {
    throw adminError('DEPENDENCY_UNAVAILABLE');
  }
  return stored;
}
export async function qualifiedWorkers(
  model: Model<ProcessingQueuePolicy>,
  qualification: ProcessingQualification | null,
  session?: ClientSession,
  durationSeconds = 1,
  bytes = 1,
): Promise<string[]> {
  if (!qualificationReady(qualification, new Date())) return [];
  const registrations = await model.db
    .model<WorkerRegistration>(WorkerRegistration.name)
    .find({ state: 'enabled' })
    .sort({ _id: 1 })
    .limit(1000)
    .session(session ?? null)
    .lean();
  const eligible: string[] = [];
  const readiness = new WorkerReadinessService(model.db);
  for (const registration of registrations) {
    const result = await readiness.evaluateNewClaim(
      registration._id,
      session,
      true,
    );
    if (
      result.allowed &&
      result.maxDurationSeconds >= durationSeconds &&
      result.maxPreparedAudioBytes >= bytes
    )
      eligible.push(registration._id);
  }
  return eligible;
}
@Injectable()
export class QueuePolicyService {
  constructor(
    @InjectModel(ProcessingQueuePolicy.name)
    private readonly policies: Model<ProcessingQueuePolicy>,
    @InjectModel(ProcessingAdmissionFence.name)
    private readonly fences: Model<ProcessingAdmissionFence>,
    private readonly operations: AdminOperationsService,
  ) {}
  async current() {
    const policy = await readQueuePolicy(this.policies);
    const { _id: _ignored, ...values } = policy as ProcessingQueuePolicy;
    const capableWorkerIds = await qualifiedWorkers(
      this.policies,
      policy.qualification,
    );
    return {
      schemaVersion: 2 as const,
      ...values,
      qualification: policy.qualification,
      updatedAt: policy.updatedAt.toISOString(),
      shortLongThresholdSeconds: 600,
      readiness: {
        evidenceStatus: policy.qualification
          ? qualificationReady(policy.qualification, new Date())
            ? 'verified'
            : 'stale'
          : 'unavailable',
        expandedAdmissionAvailable: capableWorkerIds.length > 0,
        capableWorkerIds,
        costModelRevision: policy.qualification?.costModelRevision ?? null,
        maxOutstandingEstimatedWorkerSeconds:
          policy.qualification?.maxOutstandingEstimatedWorkerSeconds ?? null,
      },
    };
  }
  async update(actor: AdminActor, dto: UpdateQueuePolicyDto) {
    validateQueuePolicy(dto);
    if (dto.qualification) {
      assertQualification(dto.qualification, new Date(), true);
      if (
        dto.qualification.referenceProcessingSecondsPerAudioSecond *
          dto.maxDurationSeconds >
        dto.qualification.processingTimeoutSeconds
      )
        throw adminError('INVALID_REQUEST');
    }
    const next: Record<string, unknown> = Object.fromEntries(
      Object.keys(DEFAULT_QUEUE_POLICY).map((key) => [
        key,
        dto[key as keyof typeof DEFAULT_QUEUE_POLICY],
      ]),
    );
    if (dto.qualification !== undefined) next.qualification = dto.qualification;
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'PUT /admin/settings/processing-v2',
        request: { ...next, expectedRevision: dto.expectedRevision },
        action: 'settings.processing-v2.update',
        resourceType: 'processing_settings',
        reason: dto.reason,
      },
      async (session) => {
        await this.fences.updateOne(
          { _id: 'settings' },
          { $inc: { revision: 1 } },
          { upsert: true, session, setDefaultsOnInsert: true },
        );
        const current = await readQueuePolicy(this.policies, session);
        if (
          dto.qualification &&
          JSON.stringify(dto.qualification) !==
            JSON.stringify(current.qualification)
        )
          assertQualification(dto.qualification, new Date());
        if (current.qualification && dto.qualification === undefined)
          throw adminError('REVISION_CONFLICT');
        if (current.revision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const updatedAt = new Date();
        if (current.updatedAt.getTime() === 0)
          await this.policies.create(
            [{ _id: 'processing', ...next, revision: 1, updatedAt }],
            { session },
          );
        else {
          const changed = await this.policies.updateOne(
            { _id: 'processing', revision: dto.expectedRevision },
            { $set: { ...next, updatedAt }, $inc: { revision: 1 } },
            { session, runValidators: true },
          );
          if (changed.modifiedCount !== 1)
            throw adminError('REVISION_CONFLICT');
        }
        return {
          processingChanges: [
            ...Object.keys(DEFAULT_QUEUE_POLICY).map((key) => ({
              field: key,
              before: current[key as keyof typeof DEFAULT_QUEUE_POLICY],
              after: dto[key as keyof typeof DEFAULT_QUEUE_POLICY],
            })),
            {
              field: 'qualificationEvidenceReference',
              before: current.qualification?.evidenceReference ?? null,
              after: dto.qualification?.evidenceReference ?? null,
            },
            {
              field: 'qualificationExpiresAt',
              before: current.qualification?.expiresAt ?? null,
              after: dto.qualification?.expiresAt ?? null,
            },
          ],
          resourceId: 'processing-v2',
          previousRevision: dto.expectedRevision,
          revision: dto.expectedRevision + 1,
          value: {
            schemaVersion: 2,
            ...next,
            revision: dto.expectedRevision + 1,
            updatedAt: updatedAt.toISOString(),
            readiness: {
              evidenceStatus: 'unavailable',
              expandedAdmissionAvailable: false,
              costModelRevision: null,
              maxOutstandingEstimatedWorkerSeconds: null,
            },
          },
        };
      },
    );
    void result;
    return this.current();
  }
}
