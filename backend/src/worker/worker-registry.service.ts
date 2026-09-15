import { WorkerReadinessService } from './worker-readiness.service.js';
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
import { INSTALLATION_ID_PATTERN } from './dto/worker-runtime.dto.js';
import { type WorkerIdentity } from './worker-routes.js';
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

  context(identity?: WorkerIdentity): WorkerIdentity {
    if (
      !identity ||
      !INSTALLATION_ID_PATTERN.test(identity.installationId) ||
      !WORKER_ID_PATTERN.test(identity.workerId) ||
      !WORKER_KEY_PATTERN.test(identity.keySha256)
    )
      throw authError('UNAUTHENTICATED');
    return identity;
  }

  ownerId(value: string | null | undefined): string {
    if (value && WORKER_ID_PATTERN.test(value)) return value;
    throw jobError('STALE_ATTEMPT');
  }

  async authenticateDigest(keySha256: string): Promise<WorkerIdentity> {
    if (!WORKER_KEY_PATTERN.test(keySha256)) throw authError('UNAUTHENTICATED');
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
    const identity = this.context({
      workerId: registration._id,
      keySha256,
      installationId: registration.installationId,
    });
    await this.assertInstallation(identity);
    return identity;
  }

  async describeInstallation(identity: WorkerIdentity) {
    const current = this.context(identity);
    const registration = await this.registrations
      .findOne({ _id: current.workerId, keySha256: current.keySha256 })
      .lean()
      .catch(() => {
        throw authError('SERVICE_UNAVAILABLE');
      });
    if (
      !registration ||
      !['enabled', 'draining'].includes(registration.state) ||
      typeof registration.installationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        registration.installationId,
      )
    )
      throw authError('UNAUTHENTICATED');
    if (registration.installationId !== current.installationId)
      throw authError('UNAUTHENTICATED');
    await this.assertInstallation(current);
    return {
      workerId: current.workerId,
      installationId: registration.installationId,
      state: registration.state,
    };
  }

  async state(identity: WorkerIdentity, session?: ClientSession) {
    const current = this.context(identity);
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
    if (registration.installationId !== current.installationId)
      throw authError('UNAUTHENTICATED');
    await this.assertInstallation(current, session);
    return registration.state;
  }

  private async installationBound(
    identity: Pick<WorkerIdentity, 'workerId' | 'installationId'>,
    session?: ClientSession,
  ): Promise<boolean> {
    if (!INSTALLATION_ID_PATTERN.test(identity.installationId)) return false;
    const installation = await this.registrations.db
      .collection<{
        _id: string;
        assignedWorkerId: string;
        pairingState: string;
        revoked: boolean;
      }>('worker_installations')
      .findOne(
        {
          _id: identity.installationId,
          assignedWorkerId: identity.workerId,
          pairingState: 'approved',
          revoked: false,
        },
        { session, projection: { _id: 1 } },
      )
      .catch(() => {
        throw authError('SERVICE_UNAVAILABLE');
      });
    return Boolean(installation);
  }

  private async assertInstallation(
    identity: WorkerIdentity,
    session?: ClientSession,
  ): Promise<void> {
    if (!(await this.installationBound(identity, session)))
      throw authError('UNAUTHENTICATED');
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
        controlRevision: revision,
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

  async available(
    job: Pick<
      Job,
      'workerId' | 'attemptId' | 'measuredDurationSeconds' | 'inputReservation'
    >,
  ): Promise<boolean> {
    const since = new Date(
      Date.now() -
        this.config.getOrThrow<number>('PROCESSING_LEASE_SECONDS') * 1000,
    );
    if (job.attemptId && !job.workerId) return false;
    if (!job.workerId) {
      const candidates = await this.registrations
        .find({ state: 'enabled' })
        .sort({ _id: 1 })
        .limit(1000)
        .lean();
      const readiness = new WorkerReadinessService(this.controls.db);
      const duration =
        job.measuredDurationSeconds ?? job.inputReservation.durationSeconds;
      for (const candidate of candidates) {
        if (
          !(await this.installationBound({
            workerId: candidate._id,
            installationId: candidate.installationId,
          }))
        )
          continue;
        const eligibility = await readiness.evaluateNewClaim(
          candidate._id,
          undefined,
          true,
        );
        if (
          eligibility.allowed &&
          duration <= eligibility.maxDurationSeconds &&
          job.inputReservation.bytes <= eligibility.maxPreparedAudioBytes
        )
          return true;
      }
      return false;
    }
    const registration = await this.registrations
      .findOne({
        _id: job.workerId,
        state: trusted({ $in: ['enabled', 'draining'] }),
      })
      .lean();
    if (
      !registration ||
      !(await this.installationBound({
        workerId: registration._id,
        installationId: registration.installationId,
      }))
    )
      return false;
    return Boolean(
      await this.controls.exists({
        _id: job.workerId,
        lastSeenAt: trusted({ $gt: since }),
      }),
    );
  }
}
