import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionClient } from "./control.js";
import { parseSessionSnapshot } from "../../shared/session-snapshot.js";
import type { SessionSnapshot } from "../../shared/session-contracts.js";

/** Native full-snapshot waits; no HTTP status polling or timer-driven refetch. */
export class SessionObserver {
  private readonly abort = new AbortController();
  private operation: Promise<void> | undefined;
  constructor(
    private readonly options: {
      client: Pick<SessionClient, "command" | "waitState">;
      receive(snapshot: SessionSnapshot): void;
      unavailable(): void;
      wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
    },
  ) {}
  start(): void {
    this.operation ??= this.run();
    void this.operation.catch(() => {});
  }
  async stop(): Promise<void> {
    this.abort.abort();
    await this.operation?.catch(() => {});
  }
  private async run(): Promise<void> {
    let current: SessionSnapshot | undefined,
      retries = 0;
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        const next = parseSessionSnapshot(
          current
            ? await this.options.client.waitState(
                current.revision,
                current.instance_id,
                signal,
              )
            : await this.options.client.command(
                { version: 1, request_id: randomUUID(), action: "status" },
                signal,
              ),
        );
        signal.throwIfAborted();
        if (
          current?.instance_id === next.instance_id &&
          current.release !== next.release
        )
          throw new Error("SESSION_UNAVAILABLE");
        if (
          current?.instance_id === next.instance_id &&
          next.revision < current.revision
        )
          throw new Error("SESSION_UNAVAILABLE");
        if (
          !current ||
          next.instance_id !== current.instance_id ||
          next.revision > current.revision
        )
          this.options.receive(next);
        current = next;
        retries = 0;
      } catch {
        if (signal.aborted) return;
        current = undefined;
        this.options.unavailable();
        const pause = Math.min(5000, 250 * 2 ** Math.min(retries++, 5));
        try {
          await (this.options.wait?.(pause, signal) ??
            delay(pause, undefined, { signal }));
        } catch {
          return;
        }
      }
    }
  }
}
