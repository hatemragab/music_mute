import type { ConsumerGpuLease } from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  fleetCommandDigest,
  type FleetChildCommand,
  type FleetChildReply,
} from "./channel.js";
import type { FleetRuntimeControl } from "./runtime-control.js";
export interface FleetRoleControlOptions {
  runtime: FleetRuntimeControl;
  gpuLuid: string;
  idle(): boolean;
  setPending(value: boolean): Promise<void>;
  acquireGuard(): Promise<ConsumerGpuLease | null>;
  releaseGuard(lease: ConsumerGpuLease): Promise<void>;
}
/** Logical permits live in the session broker; the stable role helper owns its physical guard. */
export class FleetRoleControl {
  private guard: ConsumerGpuLease | null = null;
  private lastReleased: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly receipts = new Map<
    string,
    { digest: string; reply: FleetChildReply }
  >();
  constructor(private readonly options: FleetRoleControlOptions) {}
  guardHeld(): boolean {
    return this.guard !== null;
  }
  private proof() {
    return {
      idle: this.options.idle(),
      held: this.guardHeld(),
      guardNonce: this.guard?.nonce ?? null,
    };
  }
  execute(command: FleetChildCommand): Promise<FleetChildReply> {
    const operation = this.queue.then(() => this.run(command));
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  async releaseAfterExit(expectedNonce?: string): Promise<void> {
    if (!this.options.idle()) throw new Error("FLEET_INFERENCE_ACTIVE");
    const guard = this.guard;
    if (!guard) {
      if (expectedNonce && this.lastReleased !== expectedNonce)
        throw new Error("FLEET_GUARD_STALE");
      return;
    }
    if (expectedNonce && expectedNonce !== guard.nonce)
      throw new Error("FLEET_GUARD_STALE");
    await this.options.releaseGuard(guard);
    this.lastReleased = guard.nonce;
    this.guard = null;
  }
  private async run(command: FleetChildCommand): Promise<FleetChildReply> {
    const digest = fleetCommandDigest(command),
      previous = this.receipts.get(command.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new Error("FLEET_REQUEST_REUSED");
      return structuredClone(previous.reply);
    }
    let reply: FleetChildReply;
    if (command.action === "admission_pending") {
      await this.options.setPending(command.pending!);
      reply = {
        version: 1,
        requestId: command.requestId,
        ok: true,
        code: null,
        data: this.proof(),
      };
    } else if (command.action === "inference_proof")
      reply = {
        version: 1,
        requestId: command.requestId,
        ok: true,
        code: null,
        data: this.proof(),
      };
    else if (command.action === "guard_acquire") {
      if (command.gpuLuid !== this.options.gpuLuid)
        throw new Error("FLEET_GPU_INVALID");
      if (!this.options.idle()) throw new Error("FLEET_INFERENCE_ACTIVE");
      if (!this.guard) {
        const guard = await this.options.acquireGuard();
        if (!guard) throw new Error("FLEET_GPU_BUSY");
        if (guard.abandoned) {
          await this.options.releaseGuard(guard);
          throw new Error("FLEET_GPU_REQUALIFICATION_REQUIRED");
        }
        this.guard = guard;
      }
      reply = {
        version: 1,
        requestId: command.requestId,
        ok: true,
        code: null,
        data: this.proof(),
      };
    } else if (command.action === "guard_release") {
      await this.releaseAfterExit(command.guardNonce);
      reply = {
        version: 1,
        requestId: command.requestId,
        ok: true,
        code: null,
        data: this.proof(),
      };
    } else reply = await this.options.runtime.execute(command);
    this.receipts.set(command.requestId, { digest, reply });
    if (this.receipts.size > 64)
      this.receipts.delete(this.receipts.keys().next().value!);
    return structuredClone(reply);
  }
}
