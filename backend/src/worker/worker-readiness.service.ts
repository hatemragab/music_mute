import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { WorkerRuntime } from './worker-runtime.schema.js';
import { WorkerRegistration } from './worker-registration.schema.js';
import { WorkerControl } from './worker-control.schema.js';
import type { WorkerQualification } from './worker-qualification.schema.js';
import type {
  ReleasePolicy,
  WorkerRelease,
  WorkerUpdatePolicy,
} from '../worker-releases/worker-release.schema.js';
import type { WorkerReleaseTarget } from '../worker-releases/publication-receipt.js';
import type { WorkerRuntimeDto } from './dto/worker-runtime.dto.js';

export interface ReadinessInput {
  now: Date;
  capacity?: boolean;
  runtime: WorkerRuntime | null;
  registration: WorkerRegistration | null;
  control: WorkerControl | null;
  release: WorkerRelease | null;
  qualification: WorkerQualification | null;
  update?: WorkerUpdatePolicy | null;
  targetRelease?: WorkerRelease | null;
}
export function exactRuntime(
  runtime: WorkerRuntimeDto,
  target: WorkerReleaseTarget,
): boolean {
  return (
    runtime.workerBuild === target.buildNumber &&
    runtime.profileId === target.profileId &&
    runtime.modelSha256 === target.modelSha256 &&
    runtime.runtimeLockSha256 === target.runtimeLockSha256 &&
    runtime.os === target.os &&
    runtime.arch === target.arch &&
    runtime.launcherBuild >= target.minimumLauncherBuild &&
    runtime.protocolVersion >= target.protocolMin &&
    runtime.protocolVersion <= target.protocolMax
  );
}
/** Pairing consumes service/model execution proof; reboot remains a fresh-claim gate. */
export function evaluateQualification(
  qualification: WorkerQualification | null,
  release: WorkerRelease | null,
  now = new Date(),
) {
  const q = qualification?.report;
  const target =
    qualification &&
    release?.metadata.artifacts.find((a) =>
      exactRuntime(qualification.runtime, a),
    );
  const approval = target?.approvedProfile;
  const reasonCodes: string[] = [];
  if (release?.state !== 'published') reasonCodes.push('RELEASE_UNAVAILABLE');
  if (
    !approval ||
    !Number.isSafeInteger(approval.fixtureDurationSeconds) ||
    approval.maxDurationSeconds > approval.fixtureDurationSeconds ||
    !Number.isFinite(Date.parse(approval.expiresAt)) ||
    Date.parse(approval.expiresAt) <= now.getTime()
  )
    reasonCodes.push('UNSUPPORTED_PROFILE');
  if (
    !q ||
    !target ||
    !approval ||
    q.profileId !== target.profileId ||
    q.modelSha256 !== target.modelSha256 ||
    q.fixtureSha256 !== approval.fixtureSha256 ||
    q.provider !== approval.provider ||
    !q.acceleratorUsed ||
    !q.outputValid ||
    !q.referenceCheckPassed ||
    !q.serviceContextPassed ||
    q.reasonCodes.length ||
    q.wallMilliseconds <= 0 ||
    q.wallMilliseconds > approval.maxWallMilliseconds ||
    qualification?.serviceBindingSha256 !== approval.serviceBindingSha256
  )
    reasonCodes.push('GPU_QUALIFICATION_REQUIRED');
  return { allowed: reasonCodes.length === 0, reasonCodes };
}
export function evaluateReadiness(input: ReadinessInput) {
  const reasons: string[] = [];
  const deny = (reason: string) => {
    reasons.push(reason);
  };
  const { runtime, registration, control, release, qualification, update } =
    input;
  if (registration?.state !== 'enabled') deny('WORKER_NOT_ENABLED');
  if (!input.capacity && control?.activeJobId) deny('ASSIGNMENT_RESERVED');
  if (
    !runtime ||
    input.now.getTime() - runtime.receivedAt.getTime() > 300000 ||
    runtime.receivedAt > input.now
  )
    deny('RUNTIME_REPORT_REQUIRED');
  const r = runtime?.report;
  if (!r || registration?.installationId !== r.installationId)
    deny('INSTALLATION_BINDING_MISMATCH');
  if (
    r?.activity !== 'ready' &&
    !(input.capacity && r?.activity === 'busy' && control?.activeJobId)
  )
    deny(
      r?.activity === 'recovery_required'
        ? 'WORKER_RECOVERY_REQUIRED'
        : 'RUNTIME_NOT_READY',
    );
  if (r?.protocolVersion !== 3) deny('WORKER_REINSTALL_REQUIRED');
  const target =
    r && release?.metadata.artifacts.find((a) => exactRuntime(r, a));
  if (release?.state !== 'published') deny('RELEASE_UNAVAILABLE');
  const approval = target?.approvedProfile;
  if (
    !approval ||
    approval.maxDurationSeconds > approval.fixtureDurationSeconds ||
    !Number.isSafeInteger(approval.fixtureDurationSeconds) ||
    !Number.isFinite(Date.parse(approval.expiresAt)) ||
    Date.parse(approval.expiresAt) <= input.now.getTime()
  )
    deny('UNSUPPORTED_PROFILE');
  const qualificationDecision = evaluateQualification(
    qualification,
    release,
    input.now,
  );
  if (
    !qualificationDecision.allowed ||
    !qualification ||
    qualification._id !== runtime?.qualificationReportId ||
    qualification.installationId !== r?.installationId ||
    !r ||
    !target ||
    !exactRuntime(qualification.runtime, target)
  )
    deny('GPU_QUALIFICATION_REQUIRED');
  const boot = runtime?.reportedBoot;
  if (
    !r?.bootVerified ||
    !boot?.installed ||
    !boot.serviceContextPassed ||
    !boot.unattendedRebootPassed ||
    !boot.observedBootId ||
    boot.reasonCodes.length ||
    boot.profileId !== r.profileId ||
    boot.serviceBindingSha256 !== approval?.serviceBindingSha256 ||
    qualification?.serviceBindingSha256 !== boot.serviceBindingSha256
  )
    deny('BOOT_VERIFICATION_REQUIRED');
  if (update && r) {
    if (r.workerBuild < update.minimumClaimBuild)
      deny('WORKER_BUILD_PROHIBITED');
    if (
      update.paused ||
      ['activating', 'failed', 'rolled_back', 'blocked', 'paused'].includes(
        update.stage,
      )
    )
      deny('UPDATE_POLICY_HOLD');
    if (input.targetRelease?.state !== 'published') deny('UPDATE_POLICY_HOLD');
    const targetMatch = exactRuntime(r, update.target);
    const sourceMatch =
      r.os === update.target.os &&
      r.arch === update.target.arch &&
      r.launcherBuild >= update.target.minimumLauncherBuild &&
      r.protocolVersion >= update.target.protocolMin &&
      r.protocolVersion <= update.target.protocolMax &&
      [
        {
          profileId: update.target.profileId,
          modelSha256: update.target.modelSha256,
          runtimeLockSha256: update.target.runtimeLockSha256,
          rollbackAllowed: false,
        },
        ...update.target.compatibleSources,
      ].some(
        (s) =>
          s.profileId === r.profileId &&
          s.modelSha256 === r.modelSha256 &&
          s.runtimeLockSha256 === r.runtimeLockSha256 &&
          (r.workerBuild <= update.target.buildNumber || s.rollbackAllowed),
      );
    if (
      ['running', 'verified'].includes(update.stage)
        ? !targetMatch
        : !(targetMatch || sourceMatch)
    )
      deny('INCOMPATIBLE_PROFILE');
  }
  return {
    allowed: reasons.length === 0,
    reasonCodes: [...new Set(reasons)],
    maxDurationSeconds: approval?.maxDurationSeconds ?? 0,
    maxPreparedAudioBytes: approval?.maxPreparedAudioBytes ?? 0,
    evidenceSha256: approval?.evidenceSha256 ?? null,
    qualificationReportId: qualification?._id ?? null,
  };
}
@Injectable()
export class WorkerReadinessService {
  constructor(@InjectConnection() private readonly db: Connection) {}
  /** The caller already fences WorkerControl. Runtime and publication writes conflict here. */
  async evaluateNewClaim(
    workerId: string,
    session?: ClientSession,
    capacity = false,
  ) {
    const runtime = await this.db
      .model<WorkerRuntime>(WorkerRuntime.name)
      .findById(workerId)
      .session(session ?? null)
      .lean();
    if (session && runtime)
      await this.db
        .model<WorkerRuntime>(WorkerRuntime.name)
        .updateOne(
          { _id: workerId },
          { $inc: { rolloutFence: 1 } },
          { session },
        );
    if (session)
      await this.db
        .model<ReleasePolicy>('ReleasePolicy')
        .updateOne(
          { _id: 'policy' },
          { $inc: { fence: 1 } },
          { session, upsert: true },
        );
    const registration = await this.db
      .model<WorkerRegistration>(WorkerRegistration.name)
      .findById(workerId)
      .session(session ?? null)
      .lean();
    const control = await this.db
      .model<WorkerControl>(WorkerControl.name)
      .findById(workerId)
      .session(session ?? null)
      .lean();
    const release = runtime
      ? await this.db
          .model<WorkerRelease>('WorkerRelease')
          .findOne({ buildNumber: runtime.report.workerBuild })
          .session(session ?? null)
          .lean()
      : null;
    const qualification = runtime?.qualificationReportId
      ? await this.db
          .model<WorkerQualification>('WorkerQualification')
          .findById(runtime.qualificationReportId)
          .session(session ?? null)
          .lean()
      : null;
    const update = await this.db
      .model<WorkerUpdatePolicy>('WorkerUpdatePolicy')
      .findById(workerId)
      .session(session ?? null)
      .lean();
    const targetRelease = update
      ? await this.db
          .model<WorkerRelease>('WorkerRelease')
          .findById(update.target.releaseId)
          .session(session ?? null)
          .lean()
      : null;
    return evaluateReadiness({
      now: new Date(),
      capacity,
      runtime,
      registration,
      control,
      release,
      qualification,
      update,
      targetRelease,
    });
  }
}
