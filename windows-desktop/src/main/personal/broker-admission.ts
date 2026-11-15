import type {
  ConsumerGpuLease,
  WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  parseDirectmlGpuIdentity,
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import {
  PERSONAL_UUID,
  type PersonalWaitReason,
} from "../../shared/personal-contracts.js";
import { PersonalFailure } from "./controller.js";
import type { PersonalGpuAdmission } from "./runner.js";
export interface RoleGpuPermit {
  jobId: string;
  gpuLuid: string;
  leaseNonce: string;
}
export interface RoleGpuGateway {
  acquire(
    request: { jobId: string; gpu: DirectmlGpuIdentity },
    signal: AbortSignal,
    onWait?: (reason: PersonalWaitReason) => void,
  ): Promise<RoleGpuPermit>;
  release(request: {
    jobId: string;
    leaseNonce: string;
    exited: true;
    cleaned: true;
  }): Promise<void>;
  cancelAfterCleanup(request: {
    jobId: string;
    exited: true;
    cleaned: true;
  }): Promise<void>;
}
interface Reservation {
  gpu: DirectmlGpuIdentity;
  guard: ConsumerGpuLease | undefined;
  permit: RoleGpuPermit | undefined;
  exited: boolean;
  cleaned: boolean;
}
export interface PersonalGuardView {
  jobId: string;
  acquired?: boolean;
  nonce?: string;
  held?: boolean;
  exited?: boolean;
  cleaned?: boolean;
}
/** The session broker grants a logical permit only after this role owns the physical guard. */
export class BrokerPersonalAdmission implements PersonalGpuAdmission {
  private readonly reservations = new Map<string, Reservation>();
  constructor(
    private readonly native: WindowsConsumerNative,
    private readonly gateway: RoleGpuGateway,
  ) {}
  async acquire(
    request: Parameters<PersonalGpuAdmission["acquire"]>[0],
    signal: AbortSignal,
    onWait?: (reason: PersonalWaitReason) => void,
  ): Promise<{ releaseAfterExit(): Promise<void> }> {
    if (
      !PERSONAL_UUID.test(request.jobId) ||
      this.reservations.has(request.jobId)
    )
      throw new PersonalFailure("INVALID_REQUEST");
    signal.throwIfAborted();
    const gpu = resolveQualifiedGpuIdentity(
      request.gpu,
      await this.native.enumerateGpus(),
    );
    const reservation: Reservation = {
      gpu,
      guard: undefined,
      permit: undefined,
      exited: false,
      cleaned: false,
    };
    this.reservations.set(request.jobId, reservation);
    const permit = await this.gateway.acquire(
      { jobId: request.jobId, gpu },
      signal,
      onWait,
    );
    reservation.permit = permit;
    if (
      permit.jobId !== request.jobId ||
      permit.gpuLuid !== gpu.luid ||
      !/^[a-f0-9]{64}$/.test(permit.leaseNonce) ||
      !reservation.guard ||
      reservation.guard.gpu.luid !== gpu.luid
    )
      throw new PersonalFailure("GPU_UNSUPPORTED");
    resolveQualifiedGpuIdentity(
      reservation.guard.gpu,
      await this.native.enumerateGpus(),
    );
    signal.throwIfAborted();
    return {
      releaseAfterExit: async () => {
        reservation.exited = true;
        reservation.cleaned = true;
        await this.gateway.release({
          jobId: request.jobId,
          leaseNonce: permit.leaseNonce,
          exited: true,
          cleaned: true,
        });
        if (reservation.guard) throw new PersonalFailure("STOP_UNCONFIRMED");
        this.reservations.delete(request.jobId);
      },
    };
  }
  async guardAcquire(
    jobId: string,
    selected: DirectmlGpuIdentity,
  ): Promise<PersonalGuardView> {
    const row = this.reservations.get(jobId);
    if (!row || row.exited || row.cleaned)
      throw new PersonalFailure("INVALID_REQUEST");
    const gpu = parseDirectmlGpuIdentity(selected);
    resolveQualifiedGpuIdentity(row.gpu, [gpu]);
    if (row.guard) return { jobId, acquired: true, nonce: row.guard.nonce };
    const guard = await this.native.acquireGpuGuard(gpu);
    if (!guard) return { jobId, acquired: false };
    if (guard.abandoned) {
      await this.native.releaseGpuGuard(guard);
      throw new PersonalFailure("GPU_UNSUPPORTED");
    }
    row.guard = guard;
    return { jobId, acquired: true, nonce: guard.nonce };
  }
  async releasePendingAfterCleanup(jobId: string): Promise<void> {
    const row = this.reservations.get(jobId);
    if (!row) return;
    row.exited = true;
    row.cleaned = true;
    if (row.permit) {
      await this.gateway.release({
        jobId,
        leaseNonce: row.permit.leaseNonce,
        exited: true,
        cleaned: true,
      });
      if (row.guard) throw new PersonalFailure("STOP_UNCONFIRMED");
    } else {
      await this.gateway.cancelAfterCleanup({
        jobId,
        exited: true,
        cleaned: true,
      });
      if (row.guard) throw new PersonalFailure("STOP_UNCONFIRMED");
    }
    this.reservations.delete(jobId);
  }
  status(jobId: string): PersonalGuardView {
    const row = this.reservations.get(jobId);
    return {
      jobId,
      held: !!row?.guard,
      exited: row?.exited ?? false,
      cleaned: row?.cleaned ?? false,
    };
  }
  async guardRelease(jobId: string, nonce: string): Promise<PersonalGuardView> {
    const row = this.reservations.get(jobId);
    if (!row?.guard || row.guard.nonce !== nonce || !row.exited || !row.cleaned)
      throw new PersonalFailure("STOP_UNCONFIRMED");
    await this.native.releaseGpuGuard(row.guard);
    row.guard = undefined;
    return { jobId, held: false, exited: true, cleaned: true };
  }
}
