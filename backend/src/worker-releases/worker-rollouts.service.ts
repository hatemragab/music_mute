import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import {
  type Connection,
  type ClientSession,
  type Model,
  trusted,
} from 'mongoose';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { JobAttempt } from '../jobs/job-attempt.schema.js';
import { WorkerControl } from '../worker/worker-control.schema.js';
import {
  WorkerRegistration,
  WORKER_ID_PATTERN,
} from '../worker/worker-registration.schema.js';
import { WorkerRuntime } from '../worker/worker-runtime.schema.js';
import type { WorkerIdentity } from '../worker/worker-routes.js';
import {
  PublicationReceiptVerifier,
  UUID,
  type WorkerReleaseTarget,
} from './publication-receipt.js';
import type {
  WorkerRelease,
  WorkerGroup,
  ReleasePolicy,
  WorkerRollout,
  WorkerUpdatePolicy,
} from './worker-release.schema.js';

type Command = Record<string, unknown> & {
  operationId: string;
  expectedRevision: number;
};
type Selection = {
  selectedWorkerIds: string[];
  selectedGroupIds: string[];
  releaseId: string;
  minimumClaimBuild: number;
  allowedFallbackReleaseIds: string[];
};
const terminal = ['failed', 'rolled_back', 'blocked'];
const stages = [
  'available',
  'downloading',
  'prepared',
  'waiting_for_idle',
  'validating',
  'activating',
  'running',
  'verified',
];
function requireId(id: string) {
  if (!UUID.test(id)) throw adminError('INVALID_REQUEST');
}
function integer(n: unknown, min = 0): asserts n is number {
  if (!Number.isSafeInteger(n) || Number(n) < min)
    throw adminError('INVALID_REQUEST');
}
function fields(raw: Record<string, unknown>, allowed: string[]) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !allowed.includes(k))
  )
    throw adminError('INVALID_REQUEST');
}
function ids(raw: unknown, worker = false): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length > 1000 ||
    raw.some(
      (id) =>
        typeof id !== 'string' || !(worker ? WORKER_ID_PATTERN : UUID).test(id),
    )
  )
    throw adminError('INVALID_REQUEST');
  return [...new Set(raw as string[])].sort();
}

@Injectable()
export class WorkerRolloutsService implements OnModuleInit {
  private releases: Model<WorkerRelease>;
  private groups: Model<WorkerGroup>;
  private policy: Model<ReleasePolicy>;
  private rollouts: Model<WorkerRollout>;
  private updates: Model<WorkerUpdatePolicy>;
  private attempts: Model<JobAttempt>;
  private controls: Model<WorkerControl>;
  private registrations: Model<WorkerRegistration>;
  private runtimes: Model<WorkerRuntime>;
  constructor(
    @InjectConnection() connection: Connection,
    private readonly operations: AdminOperationsService,
    private readonly transactions: ProcessingTransactions,
    private readonly verifier: PublicationReceiptVerifier,
    private readonly config: ConfigService,
  ) {
    this.releases = connection.model<WorkerRelease>('WorkerRelease');
    this.groups = connection.model<WorkerGroup>('WorkerGroup');
    this.policy = connection.model<ReleasePolicy>('ReleasePolicy');
    this.rollouts = connection.model<WorkerRollout>('WorkerRollout');
    this.updates = connection.model<WorkerUpdatePolicy>('WorkerUpdatePolicy');
    this.attempts = connection.model<JobAttempt>(JobAttempt.name);
    this.controls = connection.model<WorkerControl>(WorkerControl.name);
    this.registrations = connection.model<WorkerRegistration>(
      WorkerRegistration.name,
    );
    this.runtimes = connection.model<WorkerRuntime>(WorkerRuntime.name);
  }
  async onModuleInit() {
    await Promise.all(
      [
        this.releases,
        this.groups,
        this.policy,
        this.rollouts,
        this.updates,
      ].map((m) => m.init()),
    );
    await this.policy.updateOne(
      { _id: 'policy' },
      { $setOnInsert: { revision: 0, maximumBuild: 0 } },
      { upsert: true },
    );
  }
  private async mutate(
    actor: AdminActor,
    kind: string,
    id: string | null,
    action: string,
    body: Command,
    fn: (session: ClientSession) => Promise<{ id: string; revision: number }>,
  ) {
    requireId(body.operationId);
    integer(body.expectedRevision);
    const result = await this.operations.run(
      actor,
      {
        operationId: body.operationId,
        route: `POST /admin/worker-${kind}${id ? `/${id}` : ''}/${action}`,
        request: body,
        action: `worker_${kind}.${action}`,
        resourceType: `worker_${kind}`,
        reason: null,
      },
      async (session) => {
        const value = await fn(session);
        return { resourceId: value.id, revision: value.revision, value };
      },
    );
    return { receipt: result.receipt, replayed: result.replayed };
  }
  async createRelease(actor: AdminActor, body: Command) {
    fields(body, ['operationId', 'expectedRevision', 'publicationReceipt']);
    if (body.expectedRevision !== 0) throw adminError('REVISION_CONFLICT');
    // Verification occurs within the idempotent mutation, so expired receipts can still replay.
    return this.mutate(
      actor,
      'releases',
      null,
      'create',
      body,
      async (session) => {
        const metadata = this.verifier.verify(body.publicationReceipt);
        const fence = await this.policy.updateOne(
          {
            _id: 'policy',
            maximumBuild: trusted({ $lt: metadata.buildNumber }),
          },
          {
            $set: { maximumBuild: metadata.buildNumber },
            $inc: { revision: 1 },
          },
          { session },
        );
        if (fence.modifiedCount !== 1) throw adminError('REVISION_CONFLICT');
        await this.releases.create(
          [
            {
              _id: metadata.releaseId,
              revision: 0,
              state: 'draft',
              metadata,
              buildNumber: metadata.buildNumber,
            },
          ],
          { session },
        );
        return { id: metadata.releaseId, revision: 0 };
      },
    );
  }
  async releaseAction(
    actor: AdminActor,
    id: string,
    action: 'publish' | 'withdraw' | 'stable',
    body: Command,
  ) {
    requireId(id);
    fields(body, [
      'operationId',
      'expectedRevision',
      ...(action === 'publish' ? ['publicationReceipt'] : []),
    ]);
    return this.mutate(actor, 'releases', id, action, body, async (session) => {
      const release = await this.releases
        .findOne({ _id: id, revision: body.expectedRevision })
        .session(session)
        .lean();
      if (!release) throw adminError('REVISION_CONFLICT');
      if (action === 'publish') {
        const verified = this.verifier.verify(body.publicationReceipt);
        if (
          release.state !== 'draft' ||
          operationFingerprint(verified) !==
            operationFingerprint(release.metadata)
        )
          throw adminError('INVALID_REQUEST');
      } else if (release.state !== 'published')
        throw adminError('REVISION_CONFLICT');
      await this.releases.updateOne(
        { _id: id, revision: body.expectedRevision },
        {
          $inc: { revision: 1 },
          ...(action === 'stable'
            ? {}
            : {
                $set: {
                  state: action === 'publish' ? 'published' : 'withdrawn',
                },
              }),
        },
        { session },
      );
      await this.policy.updateOne(
        { _id: 'policy' },
        {
          $inc: { revision: 1 },
          ...(action === 'stable' ? { $set: { stableReleaseId: id } } : {}),
        },
        { session },
      );
      return { id, revision: release.revision + 1 };
    });
  }
  async saveGroup(actor: AdminActor, id: string | null, body: Command) {
    if (id) requireId(id);
    fields(body, ['operationId', 'expectedRevision', 'label', 'workerIds']);
    if (
      typeof body.label !== 'string' ||
      !/^[\x20-\x7e]{1,100}$/.test(body.label) ||
      body.label.trim() !== body.label
    )
      throw adminError('INVALID_REQUEST');
    const members = ids(body.workerIds, true);
    return this.mutate(
      actor,
      'groups',
      id,
      id ? 'update' : 'create',
      body,
      async (session) => {
        if (
          (await this.registrations
            .countDocuments({ _id: trusted({ $in: members }) })
            .session(session)) !== members.length
        )
          throw adminError('RESOURCE_NOT_FOUND');
        if (!id) {
          if (body.expectedRevision !== 0)
            throw adminError('REVISION_CONFLICT');
          const groupId = randomUUID();
          await this.groups.create(
            [
              {
                _id: groupId,
                revision: 1,
                label: String(body.label),
                workerIds: members,
              },
            ],
            { session },
          );
          return { id: groupId, revision: 1 };
        }
        const result = await this.groups.updateOne(
          { _id: id, revision: body.expectedRevision },
          {
            $set: { label: String(body.label), workerIds: members },
            $inc: { revision: 1 },
          },
          { session },
        );
        if (result.modifiedCount !== 1) throw adminError('REVISION_CONFLICT');
        return { id, revision: body.expectedRevision + 1 };
      },
    );
  }
  private selection(raw: Record<string, unknown>): Selection {
    const selectedWorkerIds = ids(raw.selectedWorkerIds, true),
      selectedGroupIds = ids(raw.selectedGroupIds),
      allowedFallbackReleaseIds = ids(raw.allowedFallbackReleaseIds);
    if (
      selectedGroupIds.length > 100 ||
      allowedFallbackReleaseIds.length > 32 ||
      typeof raw.releaseId !== 'string'
    )
      throw adminError('INVALID_REQUEST');
    requireId(raw.releaseId);
    integer(raw.minimumClaimBuild);
    return {
      selectedWorkerIds,
      selectedGroupIds,
      releaseId: raw.releaseId,
      minimumClaimBuild: raw.minimumClaimBuild,
      allowedFallbackReleaseIds,
    };
  }
  private sameRecipe(
    source: Pick<
      WorkerReleaseTarget,
      'profileId' | 'modelSha256' | 'runtimeLockSha256'
    >,
    target: Pick<
      WorkerReleaseTarget,
      'profileId' | 'modelSha256' | 'runtimeLockSha256'
    >,
  ): boolean {
    return (
      source.profileId === target.profileId &&
      source.modelSha256 === target.modelSha256 &&
      source.runtimeLockSha256 === target.runtimeLockSha256
    );
  }
  private platformCompatible(
    runtime: WorkerRuntime | null,
    target: WorkerReleaseTarget | undefined,
  ): boolean {
    return (
      !!runtime &&
      !!target &&
      runtime.report.os === target.os &&
      runtime.report.arch === target.arch &&
      runtime.report.launcherBuild >= target.minimumLauncherBuild &&
      runtime.report.protocolVersion >= target.protocolMin &&
      runtime.report.protocolVersion <= target.protocolMax
    );
  }
  private exactTarget(
    runtime: WorkerRuntime | null,
    target: WorkerReleaseTarget,
    build = false,
  ): boolean {
    return (
      this.platformCompatible(runtime, target) &&
      this.sameRecipe(runtime!.report, target) &&
      (!build || runtime!.report.workerBuild === target.buildNumber)
    );
  }
  private compatible(
    runtime: WorkerRuntime | null,
    target: WorkerReleaseTarget | undefined,
  ): boolean {
    return (
      !!target &&
      this.platformCompatible(runtime, target) &&
      (this.sameRecipe(runtime!.report, target) ||
        target.compatibleSources.some((source) =>
          this.sameRecipe(runtime!.report, source),
        ))
    );
  }
  private fallbackTarget(
    runtime: WorkerRuntime | null,
    target: WorkerReleaseTarget,
    release: WorkerRelease,
  ): WorkerReleaseTarget | null {
    const matches = release.metadata.artifacts.filter(
      (fallback) =>
        this.platformCompatible(runtime, fallback) &&
        fallback.os === target.os &&
        fallback.arch === target.arch &&
        (this.sameRecipe(fallback, target) ||
          target.compatibleSources.some(
            (source) =>
              source.rollbackAllowed && this.sameRecipe(source, fallback),
          )),
    );
    return matches.length === 1 ? matches[0]! : null;
  }
  private async resolve(selection: Selection, session: ClientSession) {
    const policy = await this.policy.findById('policy').session(session).lean();
    const release = await this.releases
      .findById(selection.releaseId)
      .session(session)
      .lean();
    if (
      !policy ||
      !release ||
      release.state !== 'published' ||
      selection.minimumClaimBuild > release.buildNumber
    )
      throw adminError('INVALID_REQUEST');
    const groups = await this.groups
      .find({ _id: trusted({ $in: selection.selectedGroupIds }) })
      .session(session)
      .lean();
    if (groups.length !== selection.selectedGroupIds.length)
      throw adminError('RESOURCE_NOT_FOUND');
    const workerIds = [
      ...new Set([
        ...selection.selectedWorkerIds,
        ...groups.flatMap((g) => g.workerIds),
      ]),
    ].sort();
    if (!workerIds.length || workerIds.length > 1000)
      throw adminError('INVALID_REQUEST');
    const fallback = await this.releases
      .find({
        _id: trusted({ $in: selection.allowedFallbackReleaseIds }),
        state: 'published',
        buildNumber: trusted({ $gte: selection.minimumClaimBuild }),
      })
      .session(session)
      .lean();
    if (fallback.length !== selection.allowedFallbackReleaseIds.length)
      throw adminError('INVALID_REQUEST');
    const filter = { _id: trusted({ $in: workerIds }) };
    const controls = await this.controls.find(filter).session(session).lean();
    const registrations = await this.registrations
      .find(filter)
      .session(session)
      .lean();
    const runtimes = await this.runtimes.find(filter).session(session).lean();
    const updates = await this.updates.find(filter).session(session).lean();
    const workers = workerIds.map((workerId) => {
      const control = controls.find((w) => w._id === workerId),
        registration = registrations.find((w) => w._id === workerId),
        runtime = runtimes.find((w) => w._id === workerId) ?? null,
        update = updates.find((w) => w._id === workerId);
      const matches = release.metadata.artifacts.filter((a) =>
        this.compatible(runtime, a),
      );
      const target = matches.length === 1 ? matches[0] : undefined;
      const reasons: string[] = [];
      if (!control || !registration) reasons.push('WORKER_NOT_FOUND');
      else if (registration.state !== 'enabled')
        reasons.push('WORKER_NOT_ENABLED');
      if (!this.compatible(runtime, target))
        reasons.push('INCOMPATIBLE_PROFILE');
      if (
        fallback.some(
          (r) => !target || !this.fallbackTarget(runtime, target, r),
        )
      )
        reasons.push('INCOMPATIBLE_FALLBACK');
      if (matches.length > 1) reasons.push('AMBIGUOUS_TARGET');
      const compatibility = runtime
        ? {
            os: runtime.report.os,
            arch: runtime.report.arch,
            profileId: runtime.report.profileId,
            launcherBuild: runtime.report.launcherBuild,
            protocolVersion: runtime.report.protocolVersion,
            modelSha256: runtime.report.modelSha256,
            runtimeLockSha256: runtime.report.runtimeLockSha256,
          }
        : null;
      return {
        workerId,
        managementRevision: control?.managementRevision ?? -1,
        policyRevision: update?.revision ?? 0,
        compatibilityHash: operationFingerprint(compatibility),
        state: registration?.state ?? 'unknown',
        currentBuild: runtime?.report.workerBuild ?? null,
        stage: update?.stage ?? null,
        rolloutId: update?.rolloutId ?? null,
        target: target ?? null,
        reasonCodes: reasons,
      };
    });
    return { policy, groups, workers, workerIds };
  }
  async preview(raw: Record<string, unknown>) {
    fields(raw, [
      'selectedWorkerIds',
      'selectedGroupIds',
      'releaseId',
      'minimumClaimBuild',
      'allowedFallbackReleaseIds',
    ]);
    const selection = this.selection(raw);
    return this.transactions.run(async (session) => {
      const resolved = await this.resolve(selection, session);
      return {
        workers: resolved.workers,
        confirmation: {
          expectedRevision: resolved.policy.revision,
          expectedGroupRevisions: Object.fromEntries(
            resolved.groups.map((g) => [g._id, g.revision]),
          ),
          expectedWorkerRevisions: Object.fromEntries(
            resolved.workers.map((w) => [
              w.workerId,
              {
                managementRevision: w.managementRevision,
                policyRevision: w.policyRevision,
                compatibilityHash: w.compatibilityHash,
              },
            ]),
          ),
          snapshotWorkerIds: resolved.workerIds,
        },
      };
    });
  }
  async confirm(actor: AdminActor, body: Command) {
    fields(body, [
      'operationId',
      'expectedRevision',
      'selectedWorkerIds',
      'selectedGroupIds',
      'releaseId',
      'minimumClaimBuild',
      'allowedFallbackReleaseIds',
      'expectedGroupRevisions',
      'expectedWorkerRevisions',
      'snapshotWorkerIds',
      'supersedeRolloutIds',
    ]);
    const selection = this.selection(body),
      snapshot = ids(body.snapshotWorkerIds, true),
      supersede = ids(body.supersedeRolloutIds ?? []);
    return this.mutate(
      actor,
      'rollouts',
      null,
      'create',
      body,
      async (session) => {
        const r = await this.resolve(selection, session);
        if (
          r.policy.revision !== body.expectedRevision ||
          operationFingerprint(snapshot) !==
            operationFingerprint(r.workerIds) ||
          operationFingerprint(body.expectedGroupRevisions) !==
            operationFingerprint(
              Object.fromEntries(r.groups.map((g) => [g._id, g.revision])),
            ) ||
          operationFingerprint(body.expectedWorkerRevisions) !==
            operationFingerprint(
              Object.fromEntries(
                r.workers.map((w) => [
                  w.workerId,
                  {
                    managementRevision: w.managementRevision,
                    policyRevision: w.policyRevision,
                    compatibilityHash: w.compatibilityHash,
                  },
                ]),
              ),
            )
        )
          throw adminError('REVISION_CONFLICT');
        if (
          r.workers.some(
            (w) =>
              w.reasonCodes.length ||
              (w.rolloutId && !supersede.includes(w.rolloutId)) ||
              ['activating', 'running'].includes(w.stage ?? ''),
          )
        )
          throw adminError('REVISION_CONFLICT');
        // Writes serialize with withdrawal/stable changes and selected membership edits.
        await this.policy.updateOne(
          { _id: 'policy', revision: body.expectedRevision },
          { $inc: { fence: 1 } },
          { session },
        );
        for (const group of r.groups)
          await this.groups.updateOne(
            { _id: group._id, revision: group.revision },
            { $inc: { fence: 1 } },
            { session },
          );
        const rolloutId = randomUUID();
        for (const worker of r.workers) {
          const fence = await this.controls.updateOne(
            {
              _id: worker.workerId,
              managementRevision: worker.managementRevision,
            },
            { $inc: { controlRevision: 1, managementRevision: 1 } },
            { session },
          );
          if (fence.modifiedCount !== 1) throw adminError('REVISION_CONFLICT');
          // A runtime write must conflict with confirmation, including a compatibility change after preview.
          const runtime = await this.runtimes
            .findById(worker.workerId)
            .session(session);
          if (!runtime) throw adminError('REVISION_CONFLICT');
          await this.runtimes.updateOne(
            { _id: worker.workerId },
            { $inc: { rolloutFence: 1 } },
            { session },
          );
          await this.updates.replaceOne(
            { _id: worker.workerId },
            {
              _id: worker.workerId,
              revision: worker.policyRevision + 1,
              rolloutId,
              target: worker.target!,
              minimumClaimBuild: selection.minimumClaimBuild,
              allowedFallbackReleaseIds: selection.allowedFallbackReleaseIds,
              stage: 'available',
              paused: false,
              runningAt: null,
              verifiedAttemptId: null,
              observedBuild: null,
              receivedAt: null,
              eventId: null,
              eventHash: null,
            },
            { session, upsert: true },
          );
        }
        await this.rollouts.create(
          [
            {
              _id: rolloutId,
              revision: 1,
              paused: false,
              releaseId: selection.releaseId,
              workerIds: r.workerIds,
              groupRevisions: body.expectedGroupRevisions as Record<
                string,
                number
              >,
              createdAt: new Date(),
            },
          ],
          { session },
        );
        return { id: rolloutId, revision: 1 };
      },
    );
  }
  async rolloutAction(
    actor: AdminActor,
    id: string,
    action: 'pause' | 'retry',
    body: Command,
  ) {
    requireId(id);
    fields(body, [
      'operationId',
      'expectedRevision',
      ...(action === 'retry' ? ['workerIds'] : []),
    ]);
    const retryIds = action === 'retry' ? ids(body.workerIds, true) : [];
    return this.mutate(actor, 'rollouts', id, action, body, async (session) => {
      const rollout = await this.rollouts
        .findOne({ _id: id, revision: body.expectedRevision })
        .session(session)
        .lean();
      if (!rollout) throw adminError('REVISION_CONFLICT');
      if (
        action === 'retry' &&
        (!retryIds.length ||
          retryIds.some((worker) => !rollout.workerIds.includes(worker)))
      )
        throw adminError('INVALID_REQUEST');
      const targets = await this.updates
        .find({
          rolloutId: id,
          ...(action === 'retry' ? { _id: trusted({ $in: retryIds }) } : {}),
        })
        .session(session)
        .lean();
      if (
        action === 'retry' &&
        (targets.length !== retryIds.length ||
          targets.some(
            (w) =>
              !terminal.includes(w.stage) &&
              !(w.paused && stages.indexOf(w.stage) < 5),
          ))
      )
        throw adminError('REVISION_CONFLICT');
      if (
        action === 'retry' &&
        !(await this.releases
          .exists({ _id: rollout.releaseId, state: 'published' })
          .session(session))
      )
        throw adminError('REVISION_CONFLICT');
      await this.policy.updateOne(
        { _id: 'policy' },
        { $inc: { fence: 1 } },
        { session },
      );
      await this.rollouts.updateOne(
        { _id: id, revision: body.expectedRevision },
        {
          $inc: { revision: 1 },
          ...(action === 'pause' ? { $set: { paused: true } } : {}),
        },
        { session },
      );
      for (const target of targets) {
        await this.controls.updateOne(
          { _id: target._id },
          { $inc: { controlRevision: 1, managementRevision: 1 } },
          { session },
        );
        await this.updates.updateOne(
          { _id: target._id, revision: target.revision },
          action === 'retry'
            ? {
                $inc: { revision: 1 },
                $set: {
                  paused: false,
                  stage: 'available',
                  eventId: null,
                  eventHash: null,
                  receivedAt: null,
                  observedBuild: null,
                  runningAt: null,
                  verifiedAttemptId: null,
                },
              }
            : { $set: { paused: true } },
          { session },
        );
      }
      return { id, revision: rollout.revision + 1 };
    });
  }
  async getUpdateDecision(workerId: string) {
    return this.transactions.run(async (session) => {
      const serverTime = new Date().toISOString();
      const update = await this.updates
        .findById(workerId)
        .session(session)
        .lean();
      if (!update)
        return {
          serverTime,
          policyRevision: 0,
          action: 'none',
          target: null,
          minimumClaimBuild: 0,
          allowedFallbackReleaseIds: [],
          reasonCodes: [],
        };
      const release = await this.releases
        .findById(update.target.releaseId)
        .session(session)
        .lean();
      const registration = await this.registrations
        .findById(workerId)
        .session(session)
        .lean();
      const runtime = await this.runtimes
        .findById(workerId)
        .session(session)
        .lean();
      const fallback = await this.releases
        .find({
          _id: trusted({ $in: update.allowedFallbackReleaseIds }),
          state: 'published',
          buildNumber: trusted({ $gte: update.minimumClaimBuild }),
        })
        .session(session)
        .lean();
      const reasons: string[] = [];
      if (update.paused) reasons.push('ROLLOUT_PAUSED');
      if (release?.state !== 'published') reasons.push('RELEASE_WITHDRAWN');
      if (registration?.state !== 'enabled') reasons.push('WORKER_NOT_ENABLED');
      if (
        !(['running', 'verified'].includes(update.stage)
          ? this.exactTarget(runtime, update.target, true)
          : this.compatible(runtime, update.target))
      )
        reasons.push('INCOMPATIBLE_PROFILE');
      if (terminal.includes(update.stage))
        reasons.push('CANDIDATE_QUARANTINED');
      return {
        policyRevision: update.revision,
        serverTime,
        action: reasons.length
          ? 'hold'
          : update.stage === 'verified'
            ? 'none'
            : 'prepare',
        target: release?.state === 'published' ? update.target : null,
        minimumClaimBuild: update.minimumClaimBuild,
        allowedFallbackReleaseIds: fallback
          .filter((r) => !!this.fallbackTarget(runtime, update.target, r))
          .map((r) => r._id),
        reasonCodes: reasons,
      };
    });
  }
  async updateStatus(identity: WorkerIdentity, raw: Record<string, unknown>) {
    fields(raw, [
      'policyRevision',
      'stage',
      'observedBuild',
      'eventId',
      'processingAttemptId',
    ]);
    integer(raw.policyRevision, 1);
    integer(raw.observedBuild, 1);
    if (
      typeof raw.eventId !== 'string' ||
      !UUID.test(raw.eventId) ||
      typeof raw.stage !== 'string' ||
      ![...stages, ...terminal].includes(raw.stage)
    )
      throw adminError('INVALID_REQUEST');
    // Verification requires independent processing evidence; a contributor cannot self-attest it.
    if (
      raw.stage === 'verified' &&
      (typeof raw.processingAttemptId !== 'string' ||
        !UUID.test(raw.processingAttemptId))
    )
      throw adminError('INVALID_REQUEST');
    return this.transactions.run(async (session) => {
      const registration = await this.registrations
        .findOne({ _id: identity.workerId, keySha256: identity.keySha256 })
        .session(session)
        .lean();
      const update = await this.updates
        .findOne({
          _id: identity.workerId,
          revision: Number(raw.policyRevision),
        })
        .session(session)
        .lean();
      if (!registration || !update) throw adminError('REVISION_CONFLICT');
      const hash = operationFingerprint(raw);
      if (update.eventId === raw.eventId) {
        if (update.eventHash !== hash) throw adminError('REVISION_CONFLICT');
        return { accepted: true };
      }
      const release = await this.releases
        .findById(update.target.releaseId)
        .session(session)
        .lean();
      const control = await this.controls
        .findById(identity.workerId)
        .session(session)
        .lean();
      const stage = raw.stage as string;
      if (stage === 'activating') {
        const runtime = await this.runtimes
          .findById(identity.workerId)
          .session(session)
          .lean();
        if (!this.compatible(runtime, update.target))
          throw adminError('REVISION_CONFLICT');
        await this.runtimes.updateOne(
          { _id: identity.workerId },
          { $inc: { rolloutFence: 1 } },
          { session },
        );
      }
      if (
        stage === 'activating' &&
        (update.paused ||
          release?.state !== 'published' ||
          registration.state !== 'enabled' ||
          !control ||
          control?.activeJobId)
      )
        throw adminError('REVISION_CONFLICT');
      if (
        !terminal.includes(stage) &&
        (terminal.includes(update.stage) ||
          stages.indexOf(stage) !== stages.indexOf(update.stage) + 1)
      )
        throw adminError('REVISION_CONFLICT');
      const observedRuntime = await this.runtimes
        .findById(identity.workerId)
        .session(session)
        .lean();
      if (
        !observedRuntime ||
        raw.observedBuild !== observedRuntime.report.workerBuild
      )
        throw adminError('INVALID_REQUEST');
      if (
        ['running', 'verified'].includes(stage) &&
        !this.exactTarget(observedRuntime, update.target, true)
      )
        throw adminError('INVALID_REQUEST');
      if (['running', 'verified', 'rolled_back'].includes(stage))
        await this.runtimes.updateOne(
          { _id: identity.workerId },
          { $inc: { rolloutFence: 1 } },
          { session },
        );
      if (stage === 'verified') {
        const runtime = await this.runtimes
          .findById(identity.workerId)
          .session(session)
          .lean();
        if (
          !update.runningAt ||
          runtime?.report.workerBuild !== update.target.buildNumber ||
          !this.exactTarget(runtime, update.target, true) ||
          !(await this.attempts
            .exists({
              workerId: identity.workerId,
              attemptId: String(raw.processingAttemptId),
              outcome: 'ready',
              startedAt: trusted({ $gte: update.runningAt }),
              endedAt: trusted({ $ne: null }),
            })
            .session(session))
        )
          throw adminError('INVALID_REQUEST');
      }
      if (stage === 'rolled_back') {
        const fallback = await this.releases
          .findOne({
            _id: trusted({ $in: update.allowedFallbackReleaseIds }),
            state: 'published',
            buildNumber: Number(raw.observedBuild),
          })
          .session(session)
          .lean();
        if (
          !fallback ||
          fallback.buildNumber < update.minimumClaimBuild ||
          !this.fallbackTarget(observedRuntime, update.target, fallback) ||
          !this.exactTarget(
            observedRuntime,
            this.fallbackTarget(observedRuntime, update.target, fallback)!,
            true,
          )
        )
          throw adminError('INVALID_REQUEST');
      }
      await this.controls.updateOne(
        { _id: identity.workerId },
        { $inc: { controlRevision: 1 } },
        { session },
      );
      await this.policy.updateOne(
        { _id: 'policy' },
        { $inc: { fence: 1 } },
        { session },
      );
      await this.rollouts.updateOne(
        { _id: update.rolloutId },
        { $inc: { revision: 0 } },
        { session },
      );
      await this.updates.updateOne(
        { _id: identity.workerId, revision: Number(raw.policyRevision) },
        {
          $set: {
            stage,
            observedBuild: raw.observedBuild,
            receivedAt: new Date(),
            eventId: raw.eventId,
            eventHash: hash,
            ...(stage === 'running' ? { runningAt: new Date() } : {}),
            ...(stage === 'verified'
              ? { verifiedAttemptId: String(raw.processingAttemptId) }
              : {}),
          },
        },
        { session },
      );
      return { accepted: true };
    });
  }
  async stable(profileId: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(profileId))
      throw adminError('INVALID_REQUEST');
    const p = await this.policy.findById('policy').lean();
    const r = p?.stableReleaseId
      ? await this.releases
          .findOne({ _id: p.stableReleaseId, state: 'published' })
          .lean()
      : null;
    return {
      policyRevision: p?.revision ?? 0,
      target:
        r?.metadata.artifacts.find((a) => a.profileId === profileId) ?? null,
    };
  }
  async list(kind: 'groups' | 'releases', query: Record<string, unknown>) {
    fields(query, ['cursor', 'limit']);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    integer(limit, 1);
    if (limit > 100) throw adminError('INVALID_REQUEST');
    let cursor: string | null = null;
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== 'string' || query.cursor.length > 100)
        throw adminError('INVALID_REQUEST');
      cursor = Buffer.from(query.cursor, 'base64url').toString();
      requireId(cursor);
    }
    const filter = cursor ? { _id: trusted({ $gt: cursor }) } : {};
    const rows =
      kind === 'groups'
        ? await this.groups
            .find(filter)
            .sort({ _id: 1 })
            .limit(limit + 1)
            .lean()
        : await this.releases
            .find(filter)
            .sort({ _id: 1 })
            .limit(limit + 1)
            .lean();
    return {
      items: rows.slice(0, limit),
      nextCursor:
        rows.length > limit
          ? Buffer.from(rows[limit - 1]!._id).toString('base64url')
          : null,
    };
  }
  async detail(id: string) {
    requireId(id);
    const rollout = await this.rollouts.findById(id).lean();
    if (!rollout) throw adminError('RESOURCE_NOT_FOUND');
    const workers = await this.updates
      .find({ rolloutId: id })
      .limit(1000)
      .lean();
    const now = Date.now();
    const ids = workers.map((worker) => worker._id);
    const runtimes = await this.runtimes
      .find({ _id: trusted({ $in: ids }) })
      .lean();
    const controls = await this.controls
      .find({ _id: trusted({ $in: ids }) })
      .lean();
    const freshnessMs =
      this.config.get<number>('PROCESSING_LEASE_SECONDS', 90) * 1000;
    const liveness = new Map(
      ids.map((id) => {
        const times = [
          runtimes.find((row) => row._id === id)?.receivedAt,
          controls.find((row) => row._id === id)?.lastSeenAt,
        ].filter((date): date is Date => !!date);
        return [
          id,
          times.length
            ? new Date(Math.max(...times.map((date) => date.getTime())))
            : null,
        ] as const;
      }),
    );
    return {
      rollout,
      workers: workers.map((worker) => ({
        ...worker,
        lastSeenAt: liveness.get(worker._id) ?? null,
      })),
      counts: {
        desired: rollout.workerIds.length,
        current: workers.length,
        downloaded: workers.filter((w) => stages.indexOf(w.stage) >= 2).length,
        running: workers.filter((w) => w.stage === 'running').length,
        verified: workers.filter((w) => w.stage === 'verified').length,
        failed: workers.filter((w) => terminal.includes(w.stage)).length,
        unknown: workers.filter((w) => !liveness.get(w._id)).length,
        offline: workers.filter(
          (w) =>
            liveness.get(w._id) &&
            now - liveness.get(w._id)!.getTime() > freshnessMs,
        ).length,
      },
    };
  }
}
