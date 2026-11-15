import { setTimeout as delay } from "node:timers/promises";
import type { LocalLifecycleState } from "../../../../worker/src/runtime/local-lifecycle.js";
import type { LocalRuntimeStatus } from "../../../../worker/src/runtime/local-runtime-status.js";
import {
  fleetCommandDigest,
  type FleetChildCommand,
  type FleetChildReply,
} from "./channel.js";
export interface FleetRuntimeControlOptions {
  processId: number;
  runtime: { hintAvailableWork(): void; stop(): Promise<void> };
  setIntent(
    intent: "active" | "paused" | "draining",
  ): Promise<LocalLifecycleState>;
  status(): Promise<LocalRuntimeStatus>;
  closed(): boolean;
  now?: () => number;
  wait?: () => Promise<void>;
  drainTimeoutMs?: number;
}
/** Pause/Drain prohibit new claims and preserve accepted attempts; Stop waits for a real drain ACK. */
export class FleetRuntimeControl {
  private readonly receipts = new Map<
    string,
    { digest: string; reply: FleetChildReply }
  >();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private readonly options: FleetRuntimeControlOptions) {}
  execute(command: FleetChildCommand): Promise<FleetChildReply> {
    const operation = this.queue.then(() => this.run(command));
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  private async run(command: FleetChildCommand): Promise<FleetChildReply> {
    const digest = fleetCommandDigest(command),
      previous = this.receipts.get(command.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new Error("FLEET_REQUEST_REUSED");
      return structuredClone(previous.reply);
    }
    if (this.stopped || this.options.closed())
      throw new Error("FLEET_RUNTIME_STOPPED");
    if (command.action === "intent")
      await this.options.setIntent(
        command.intent === "running" ? "active" : command.intent!,
      );
    if (command.action === "sleep") await this.options.setIntent("paused");
    if (command.action !== "stop") this.options.runtime.hintAvailableWork();
    else {
      const requested = await this.options.setIntent("draining");
      this.options.runtime.hintAvailableWork();
      const now = this.options.now ?? Date.now,
        deadline = now() + (this.options.drainTimeoutMs ?? 7000);
      let drained = false;
      while (now() < deadline && !this.options.closed()) {
        try {
          const status = await this.options.status();
          drained =
            status.processId === this.options.processId &&
            status.observedLifecycle?.revision === requested.revision &&
            status.observedLifecycle.intent === "draining" &&
            status.activeAttemptIds.length === 0;
          if (drained) break;
        } catch {
          /* Uncertain local state cannot authorize a physical stop. */
        }
        await (this.options.wait?.() ?? delay(50));
      }
      if (!drained && !this.options.closed())
        throw new Error("FLEET_DRAIN_PENDING");
      await this.options.runtime.stop();
      this.stopped = true;
    }
    const reply: FleetChildReply = {
      version: 1,
      requestId: command.requestId,
      ok: true,
      code: null,
    };
    this.receipts.set(command.requestId, { digest, reply });
    if (this.receipts.size > 64)
      this.receipts.delete(this.receipts.keys().next().value!);
    return structuredClone(reply);
  }
}
