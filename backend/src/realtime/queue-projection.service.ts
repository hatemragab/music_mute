import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model } from 'mongoose';
import { AccountPolicyService } from '../admin-settings/account-policy.service.js';
import {
  dispatchEligibility,
  hasProcessingCapacity,
} from '../jobs/dispatch-eligibility.js';
import { PROCESSING_CAPACITY_STATUSES } from '../jobs/job-lifecycle-policy.js';
import { Job } from '../jobs/job.schema.js';
import { ProcessingReservation } from '../processing-usage/processing-usage.schema.js';
import { User } from '../users/user.schema.js';
import { WorkerMachine } from '../worker-fleet/machines/worker-machine.schema.js';
import { WorkerSlot } from '../worker-fleet/machines/worker-slot.schema.js';
import { WorkerFleetPolicy } from '../worker-fleet/policy/worker-fleet-policy.schema.js';
import { RealtimeFeedService } from './realtime-feed.service.js';
import { affectsRealtimeResource } from './realtime-dependencies.js';

export interface QueueView {
  state: 'waiting' | 'blocked' | 'not_queued' | 'unavailable';
  position: number | null;
  jobsAhead: number | null;
  scope: 'recipe' | null;
  reason:
    | 'account_capacity'
    | 'account_restricted'
    | 'retry_backoff'
    | 'processing_paused'
    | 'worker_unavailable'
    | 'eligibility_unavailable'
    | null;
  asOf: string;
}
const LIMIT = 5000;
const JOB_FIELDS =
  '_id userId status deletedAt queuedAt currentExecution inputObject recipeSnapshot retryEligibility attemptNumber admissionSnapshot';
type Snapshot = { at: number; views: Map<string, QueueView> };

export function queueView(
  state: QueueView['state'],
  at: number,
  reason: QueueView['reason'] = null,
  position: number | null = null,
): QueueView {
  return {
    state,
    position,
    jobsAhead: position === null ? null : position - 1,
    scope: position === null ? null : 'recipe',
    reason,
    asOf: new Date(at).toISOString(),
  };
}

/** One bounded, consistent queue snapshot per process, shared across all owners. */
@Injectable()
export class QueueProjectionService implements OnModuleInit, OnModuleDestroy {
  private cached?: Snapshot;
  private pending?: Promise<Snapshot>;
  private generation = 0;
  private unsubscribe?: () => void;
  private deadline?: NodeJS.Timeout;
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(ProcessingReservation.name)
    private readonly reservations: Model<ProcessingReservation>,
    @InjectModel(WorkerMachine.name)
    private readonly machines: Model<WorkerMachine>,
    @InjectModel(WorkerSlot.name) private readonly slots: Model<WorkerSlot>,
    @InjectModel(WorkerFleetPolicy.name)
    private readonly fleet: Model<WorkerFleetPolicy>,
    private readonly policies: AccountPolicyService,
    private readonly config: ConfigService,
    private readonly feed: RealtimeFeedService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.feed.subscribe((event) => {
      if (affectsRealtimeResource('jobs', event.collection)) {
        this.generation++;
        this.cached = undefined;
      }
    });
  }
  onModuleDestroy(): void {
    this.unsubscribe?.();
    clearTimeout(this.deadline);
  }

  async enrich<T extends { id: string; status: string }>(
    items: T[],
  ): Promise<Array<T & { queue: QueueView; queuePosition: number | null }>> {
    const snapshot = items.some((item) => item.status === 'queued')
      ? await this.snapshot()
      : { at: Date.now(), views: new Map<string, QueueView>() };
    return items.map((item) => {
      const queue =
        item.status !== 'queued'
          ? queueView('not_queued', snapshot.at)
          : (snapshot.views.get(item.id) ??
            queueView('unavailable', snapshot.at, 'eligibility_unavailable'));
      return { ...item, queue, queuePosition: queue.position };
    });
  }

  private async snapshot(): Promise<Snapshot> {
    if (this.cached && Date.now() - this.cached.at < 1000) return this.cached;
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = this.build().catch(() => ({
      at: Date.now(),
      views: new Map<string, QueueView>(),
    }));
    try {
      const snapshot = await this.pending;
      if (generation === this.generation) this.cached = snapshot;
      return snapshot;
    } finally {
      this.pending = undefined;
    }
  }

  private async build(): Promise<Snapshot> {
    const session = await this.jobs.db.startSession();
    try {
      return await session.withTransaction(() => this.read(session), {
        readConcern: { level: 'snapshot' },
        readPreference: 'primary',
        maxCommitTimeMS: 2000,
      });
    } finally {
      await session.endSession();
    }
  }

  private async read(session: ClientSession): Promise<Snapshot> {
    const at = Date.now();
    const now = new Date(at);
    const views = new Map<string, QueueView>();
    const queued = await this.jobs
      .find({ status: 'queued', deletedAt: null })
      .select(JOB_FIELDS)
      .sort({ queuedAt: 1, _id: 1 })
      .limit(LIMIT + 1)
      .maxTimeMS(2000)
      .session(session)
      .lean();
    if (queued.length > LIMIT)
      throw new Error('Queue projection budget exceeded');
    const global = await this.policies.global(session);
    const fleet = await this.fleet
      .findById('worker-fleet')
      .maxTimeMS(2000)
      .session(session)
      .lean();
    const paused =
      !global.acceptNewJobs ||
      this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') !== true ||
      !fleet?.acceptClaims;
    if (paused) {
      for (const job of queued)
        views.set(
          job._id.toHexString(),
          queueView('blocked', at, 'processing_paused'),
        );
      return { at, views };
    }
    const recipeIds = fleet.recipes
      .filter((recipe) => recipe.enabled)
      .map((recipe) => recipe.recipeId);
    const eligible = await this.jobs
      .find(dispatchEligibility(recipeIds, now))
      .select('_id')
      .limit(LIMIT + 1)
      .maxTimeMS(2000)
      .session(session)
      .lean();
    if (eligible.length > LIMIT)
      throw new Error('Queue projection budget exceeded');
    const eligibleIds = new Set(eligible.map((job) => job._id.toHexString()));
    const ownerIds = [
      ...new Map(
        queued.map((job) => [job.userId.toHexString(), job.userId]),
      ).values(),
    ];
    const users = await this.users
      .find({ _id: trusted({ $in: ownerIds }) })
      .select('_id status')
      .maxTimeMS(2000)
      .session(session)
      .lean();
    const active = new Set(
      users
        .filter((user) => user.status === 'active')
        .map((user) => user._id.toHexString()),
    );
    const reservations = await this.reservations
      .find({
        _id: trusted({ $in: queued.map((job) => job._id) }),
        state: 'reserved',
      })
      .select('_id accountId')
      .maxTimeMS(2000)
      .session(session)
      .lean();
    const reserved = new Map(
      reservations.map((value) => [
        value._id.toHexString(),
        value.accountId.toHexString(),
      ]),
    );
    const capacity = await this.jobs
      .aggregate<{ _id: Job['userId']; count: number }>([
        {
          $match: {
            userId: { $in: ownerIds },
            deletedAt: null,
            status: { $in: PROCESSING_CAPACITY_STATUSES },
          },
        },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ])
      .session(session)
      .option({ maxTimeMS: 2000 });
    const counts = new Map(
      capacity.map((value) => [value._id.toHexString(), value.count]),
    );
    const machines = await this.machines
      .find({
        status: 'active',
        policyRevision: fleet.revision,
        appliedRevision: fleet.revision,
      })
      .select('_id currentSession lastSeenAt')
      .limit(LIMIT + 1)
      .maxTimeMS(2000)
      .session(session)
      .lean();
    const slots = await this.slots
      .find({
        machineId: trusted({ $in: machines.map((machine) => machine._id) }),
      })
      .select(
        'machineId slotIndex sessionId incarnation allowedRecipeIds state lastSeenAt',
      )
      .limit(LIMIT * 2 + 1)
      .maxTimeMS(2000)
      .session(session)
      .lean();
    if (
      machines.length > LIMIT ||
      slots.length > LIMIT * 2 ||
      Date.now() - at > 2000
    )
      throw new Error('Queue projection budget exceeded');
    // Busy compatible slots still establish capacity; running jobs are excluded from rank.
    const usable = new Set<string>();
    let next = Infinity;
    const slotsByMachine = new Map<string, typeof slots>();
    for (const slot of slots) {
      const entries = slotsByMachine.get(slot.machineId) ?? [];
      entries.push(slot);
      slotsByMachine.set(slot.machineId, entries);
    }
    for (const machine of machines) {
      const seen = machine.lastSeenAt?.getTime() ?? 0;
      if (!machine.currentSession || seen + 90_000 <= at) continue;
      next = Math.min(next, seen + 90_000);
      for (const slot of slotsByMachine.get(machine._id) ?? []) {
        if (
          slot.sessionId !== machine.currentSession.sessionId ||
          slot.incarnation !== machine.currentSession.incarnation ||
          !['idle', 'reserved', 'busy'].includes(slot.state)
        )
          continue;
        for (const recipe of fleet.recipes)
          if (
            recipe.enabled &&
            slot.slotIndex < recipe.maxSlotsPerMachine &&
            slot.allowedRecipeIds.includes(recipe.recipeId)
          )
            usable.add(recipe.recipeId);
      }
    }
    const ranks = new Map<string, number>();
    for (const job of queued) {
      const id = job._id.toHexString();
      const owner = job.userId.toHexString();
      const retryAt = job.retryEligibility?.nextAttemptAt?.getTime() ?? 0;
      const recipe = job.recipeSnapshot?.recipeId;
      const maximum = job.admissionSnapshot?.maxProcessingJobs;
      let view: QueueView;
      if (
        !job.queuedAt ||
        !job.inputObject ||
        !recipe ||
        job.currentExecution ||
        !hasProcessingCapacity(maximum, 0) ||
        reserved.get(id) !== owner
      )
        view = queueView('unavailable', at, 'eligibility_unavailable');
      else if (!active.has(owner))
        view = queueView('blocked', at, 'account_restricted');
      else if (retryAt > at) {
        next = Math.min(next, retryAt);
        view = queueView('blocked', at, 'retry_backoff');
      } else if (!eligibleIds.has(id))
        view = queueView('unavailable', at, 'eligibility_unavailable');
      else if (!hasProcessingCapacity(maximum, counts.get(owner) ?? 0))
        view = queueView('blocked', at, 'account_capacity');
      else if (!usable.has(recipe))
        view = queueView('blocked', at, 'worker_unavailable');
      else {
        const position = (ranks.get(recipe) ?? 0) + 1;
        ranks.set(recipe, position);
        view = queueView('waiting', at, null, position);
      }
      views.set(id, view);
    }
    clearTimeout(this.deadline);
    if (Number.isFinite(next))
      this.deadline = setTimeout(
        () => this.feed.invalidate('audio_jobs'),
        Math.max(1, next - Date.now()),
      );
    this.deadline?.unref();
    return { at, views };
  }
}
