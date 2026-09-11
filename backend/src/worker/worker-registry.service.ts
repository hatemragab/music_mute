import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import {
  trusted,
  type ClientSession,
  type HydratedDocument,
  type Model,
} from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { jobError } from '../jobs/job-errors.js';
import { WorkerControl } from './worker-control.schema.js';
import {
  WorkerRegistration,
  WORKER_ID_PATTERN,
  WORKER_KEY_PATTERN,
} from './worker-registration.schema.js';
import { WORKER_ID, type WorkerIdentity } from './worker-routes.js';
import type { Job } from '../jobs/job.schema.js';

@Injectable()
export class WorkerRegistryService implements OnModuleInit {
  constructor(
    @InjectModel(WorkerRegistration.name)
    private readonly registrations: Model<WorkerRegistration>,
    @InjectModel(WorkerControl.name)
    private readonly controls: Model<WorkerControl>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([this.registrations.init(), this.controls.init()]);
  }

  get mode(): 'legacy' | 'fleet' {
    return this.config.get<'legacy' | 'fleet'>(
      'PROCESSING_WORKER_AUTH_MODE',
      'legacy',
    );
  }

  context(identity?: WorkerIdentity): WorkerIdentity {
    if (this.mode === 'legacy') {
      if (
        identity &&
        (identity.mode !== 'legacy' ||
          identity.workerId !== WORKER_ID ||
          identity.keySha256 !==
            this.config.get<string>('PROCESSING_WORKER_KEY_SHA256', ''))
      )
        throw authError('UNAUTHENTICATED');
      return (
        identity ?? {
          workerId: WORKER_ID,
          mode: 'legacy',
          keySha256: this.config.get<string>(
            'PROCESSING_WORKER_KEY_SHA256',
            '',
          ),
        }
      );
    }
    if (
      !identity ||
      identity.mode !== 'fleet' ||
      !WORKER_ID_PATTERN.test(identity.workerId) ||
      !WORKER_KEY_PATTERN.test(identity.keySha256)
    )
      throw authError('UNAUTHENTICATED');
    return identity;
  }

  ownerId(value: string | null | undefined): string {
    if (value && WORKER_ID_PATTERN.test(value)) return value;
    if (value == null && this.mode === 'legacy') return WORKER_ID;
    throw jobError('STALE_ATTEMPT');
  }

  async authenticateDigest(keySha256: string): Promise<WorkerIdentity> {
    if (this.mode !== 'fleet' || !WORKER_KEY_PATTERN.test(keySha256))
      throw authError('UNAUTHENTICATED');
    const registration = await this.registrations
      .findOne({ keySha256 })
      .lean()
      .catch(() => {
        throw authError('SERVICE_UNAVAILABLE');
      });
    if (
      !registration ||
      !WORKER_ID_PATTERN.test(registration._id) ||
      !['enabled', 'draining'].includes(registration.state)
    )
      throw authError('UNAUTHENTICATED');
    return { workerId: registration._id, keySha256, mode: 'fleet' };
  }

  async state(identity: WorkerIdentity, session?: ClientSession) {
    const current = this.context(identity);
    if (current.mode === 'legacy') return 'enabled' as const;
    const query = this.registrations.findOne({
      _id: current.workerId,
      keySha256: current.keySha256,
    });
    if (session) query.session(session);
    const registration = await query.lean().catch(() => {
      throw authError('SERVICE_UNAVAILABLE');
    });
    if (!registration || !['enabled', 'draining'].includes(registration.state))
      throw authError('UNAUTHENTICATED');
    return registration.state;
  }

  // All registry lifecycle/key mutations must touch this same control document in
  // their transaction. A snapshot read alone cannot serialize credential revocation.
  async touchControl(
    control: HydratedDocument<WorkerControl>,
    session: ClientSession,
  ): Promise<void> {
    const revision = control.controlRevision;
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Worker control revision exhausted');
    const result = await this.controls.updateOne(
      {
        _id: control._id,
        ...(revision === 0
          ? {
              $or: [
                { controlRevision: 0 },
                { controlRevision: trusted({ $exists: false }) },
              ],
            }
          : { controlRevision: revision }),
      },
      { $inc: { controlRevision: 1 } },
      { session },
    );
    if (result.matchedCount !== 1) throw jobError('STALE_ATTEMPT');
    control.controlRevision = revision + 1;
  }

  async fence(identity: WorkerIdentity | undefined, session: ClientSession) {
    const current = this.context(identity);
    const state = await this.state(current, session);
    const control = await this.controls
      .findById(current.workerId)
      .session(session);
    if (!control) throw authError('UNAUTHENTICATED');
    await this.touchControl(control, session);
    return { identity: current, state, control };
  }

  async available(job: Pick<Job, 'workerId' | 'attemptId'>): Promise<boolean> {
    const since = new Date(
      Date.now() -
        this.config.getOrThrow<number>('PROCESSING_LEASE_SECONDS') * 1000,
    );
    if (this.mode === 'legacy') {
      if (job.workerId && job.workerId !== WORKER_ID) return false;
      return Boolean(
        await this.controls.exists({
          _id: WORKER_ID,
          lastSeenAt: trusted({ $gt: since }),
        }),
      );
    }
    if (job.attemptId && !job.workerId) return false;
    const rows = await this.controls.aggregate([
      {
        $match: {
          lastSeenAt: { $gt: since },
          ...(job.workerId ? { _id: job.workerId } : {}),
        },
      },
      {
        $lookup: {
          from: 'audio_workers',
          localField: '_id',
          foreignField: '_id',
          as: 'registration',
        },
      },
      {
        $match: {
          'registration.state': job.workerId
            ? { $in: ['enabled', 'draining'] }
            : 'enabled',
        },
      },
      { $limit: 1 },
      { $project: { _id: 1 } },
    ]);
    return rows.length > 0;
  }
}
