import { setTimeout as delay } from "node:timers/promises";
import {
  ACQUISITION_SPACING_MS,
  ACQUISITION_REFUSAL_COOLDOWN_MS,
} from "../../../../chrome-extension/src/companion/acquisition-gate.js";
import type { HostContext } from "../host-context.js";
import { PersonalFailure } from "./controller.js";
interface AcquisitionState {
  version: 1;
  reason:
    | null
    | "pending"
    | "interrupted"
    | "SOURCE_BOT_CHALLENGE"
    | "ACQUISITION_RATE_LIMITED";
  startedAt: number;
  blockedUntil: number;
}
export class PrivateAcquisitionGate {
  constructor(
    private readonly host: HostContext,
    private readonly now: () => number = Date.now,
  ) {}
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const lock = await this.host.native.acquireMutex("acquisition");
    if (!lock) throw new PersonalFailure("SOURCE_UNAVAILABLE");
    try {
      let now = this.now();
      const bytes = await this.host.native.vaultRead(
        "account",
        "personal_acquisition",
      );
      let state: AcquisitionState | undefined;
      if (bytes) {
        if (bytes.length > 1024)
          throw new PersonalFailure("SOURCE_UNAVAILABLE");
        state = JSON.parse(bytes.toString("utf8")) as AcquisitionState;
        if (
          !state ||
          Object.keys(state).sort().join() !==
            "blockedUntil,reason,startedAt,version" ||
          state.version !== 1 ||
          ![
            null,
            "pending",
            "interrupted",
            "SOURCE_BOT_CHALLENGE",
            "ACQUISITION_RATE_LIMITED",
          ].includes(state.reason) ||
          !Number.isSafeInteger(state.startedAt) ||
          !Number.isSafeInteger(state.blockedUntil) ||
          state.startedAt < 0 ||
          state.startedAt > now ||
          state.blockedUntil < 0 ||
          state.blockedUntil > now + ACQUISITION_REFUSAL_COOLDOWN_MS
        )
          throw new PersonalFailure("SOURCE_UNAVAILABLE");
      }
      if (state?.reason === "pending") {
        await this.write({
          version: 1,
          reason: "interrupted",
          startedAt: state.startedAt,
          blockedUntil: now + ACQUISITION_REFUSAL_COOLDOWN_MS,
        });
        throw new PersonalFailure("ACQUISITION_COOLDOWN");
      }
      if (state && state.blockedUntil > now)
        throw new PersonalFailure("ACQUISITION_COOLDOWN");
      if (state) {
        const waiting = Math.max(
          0,
          state.startedAt + ACQUISITION_SPACING_MS - now,
        );
        if (waiting) await delay(waiting, undefined, { signal });
        now = this.now();
        if (now < state.startedAt + ACQUISITION_SPACING_MS)
          throw new PersonalFailure("SOURCE_UNAVAILABLE");
      }
      signal.throwIfAborted();
      const startedAt = now;
      await this.write({
        version: 1,
        reason: "pending",
        startedAt,
        blockedUntil: 0,
      });
      try {
        const result = await operation();
        await this.write({
          version: 1,
          reason: null,
          startedAt,
          blockedUntil: 0,
        });
        return result;
      } catch (error) {
        const code = error instanceof PersonalFailure ? error.code : null;
        await this.write({
          version: 1,
          reason:
            code === "SOURCE_BOT_CHALLENGE" ||
            code === "ACQUISITION_RATE_LIMITED"
              ? code
              : null,
          startedAt,
          blockedUntil:
            code === "SOURCE_BOT_CHALLENGE" ||
            code === "ACQUISITION_RATE_LIMITED"
              ? this.now() + ACQUISITION_REFUSAL_COOLDOWN_MS
              : 0,
        });
        throw error;
      }
    } finally {
      await this.host.native.releaseMutex(lock);
    }
  }
  private write(state: AcquisitionState): Promise<void> {
    return this.host.native.vaultWrite(
      "account",
      "personal_acquisition",
      Buffer.from(JSON.stringify(state)),
    );
  }
}
