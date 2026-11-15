import { randomBytes } from "node:crypto";
import {
  sameConsumerProcess,
  type ConsumerOwnedProcess,
  type ConsumerProcessIdentity,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  parsePersonalCommand,
  parsePersonalScope,
  type PersonalJobView,
} from "../../shared/personal-contracts.js";
import type { PersonalAgentConfiguration } from "./configuration.js";
import { PersonalFailure, PersonalProcessingController } from "./controller.js";
import type { PersonalReply } from "./session-port.js";
import type { BrokerPersonalAdmission } from "./broker-admission.js";
import type { StorePersonalRunConfiguration } from "./store-runtime.js";
import { StoreNodeIssuer } from "../session/store-node-issuer.js";
export class PersonalCommandRouter {
  #storeIssuer: StoreNodeIssuer | undefined;
  private readonly owners = new Map<string, ConsumerProcessIdentity>();
  constructor(
    private readonly controller: PersonalProcessingController,
    private readonly configuration:
      PersonalAgentConfiguration | StorePersonalRunConfiguration,
    private readonly admission?: BrokerPersonalAdmission,
    store?: { issuer: StoreNodeIssuer; native: WindowsConsumerNative },
  ) {
    if ("distribution" in configuration) {
      if (!store) throw new PersonalFailure("OWNER_DETACHED");
      StoreNodeIssuer.prototype.assertNative.call(store.issuer, store.native);
      if (store.issuer.nodeRole !== "personal")
        throw new PersonalFailure("OWNER_DETACHED");
      this.#storeIssuer = store.issuer;
    } else if (store) {
      throw new PersonalFailure("OWNER_DETACHED");
    }
  }
  async command(
    bytes: Buffer,
    nativePeer: ConsumerProcessIdentity,
  ): Promise<{ reply: PersonalReply; stop: boolean }> {
    const envelope = JSON.parse(bytes.toString("utf8")) as {
      command: unknown;
      peer: ConsumerProcessIdentity | null;
      captured_scope?: unknown;
    };
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !["command,peer", "captured_scope,command,peer"].includes(
        Object.keys(envelope).sort().join(),
      )
    )
      throw new PersonalFailure("INVALID_REQUEST");
    const command = parsePersonalCommand(
      Buffer.from(JSON.stringify(envelope.command)),
    );
    const guarding =
      command.action === "guard_acquire" ||
      command.action === "guard_status" ||
      command.action === "guard_release" ||
      command.action === "yield_idle";
    const control = this.#storeIssuer
      ? await StoreNodeIssuer.prototype.verifyControlPeer.call(
          this.#storeIssuer,
          nativePeer,
          "session-agent",
        )
      : "distribution" in this.configuration
        ? false
        : sameConsumerProcess(
            nativePeer,
            guarding
              ? this.configuration.admissionPeer
              : command.action === "wait_changes"
                ? this.configuration.eventsPeer
                : this.configuration.controlPeer,
          );
    if (!control) throw new PersonalFailure("OWNER_DETACHED");
    const peer =
      envelope.peer === null
        ? null
        : processIdentityFromWire(processIdentityToWire(envelope.peer));
    if (
      peer &&
      (peer.sid !== nativePeer.sid || peer.sessionId !== nativePeer.sessionId)
    )
      throw new PersonalFailure("OWNER_DETACHED");
    const base: PersonalReply = {
      version: 1,
      requestId: command.requestId,
      ok: true,
    };
    if (
      command.action === "guard_acquire" ||
      command.action === "guard_status" ||
      command.action === "guard_release"
    ) {
      if (peer || !this.admission) throw new PersonalFailure("INVALID_REQUEST");
      const guard =
        command.action === "guard_acquire"
          ? await this.admission.guardAcquire(command.jobId, command.gpu)
          : command.action === "guard_release"
            ? await this.admission.guardRelease(
                command.jobId,
                command.guardNonce,
              )
            : this.admission.status(command.jobId);
      return { reply: { ...base, guard }, stop: false };
    }
    if (command.action === "yield_idle") {
      if (peer) throw new PersonalFailure("INVALID_REQUEST");
      this.controller.requestGpuYield();
      return { reply: { ...base, idle: false }, stop: false };
    }
    if (command.action === "status") return { reply: base, stop: false };
    if (command.action === "idle_proof") {
      if (peer) throw new PersonalFailure("INVALID_REQUEST");
      return {
        reply: { ...base, idle: this.controller.isIdle() },
        stop: false,
      };
    }
    if (command.action === "scope") {
      if (peer) throw new PersonalFailure("INVALID_REQUEST");
      await this.controller.applyAccountScope(command.scope);
      return { reply: base, stop: false };
    }
    if (command.action === "stop") {
      if (peer) throw new PersonalFailure("INVALID_REQUEST");
      await this.controller.stop();
      return { reply: base, stop: true };
    }
    // Only the authenticated session dispatcher captures this private field.
    // Omission is permanently account-free, never the process's current user.
    const capturedScope = parsePersonalScope(envelope.captured_scope ?? null);
    const assertScope = () => {
      if (
        capturedScope &&
        JSON.stringify(capturedScope) !==
          JSON.stringify(this.controller.currentScope())
      )
        throw new PersonalFailure("SCOPE_CHANGED");
    };
    assertScope();
    const ownerId =
      command.action === "submit"
        ? command.submission.ownerId
        : command.ownerId;
    const previous = this.owners.get(ownerId);
    if (command.action === "jobs" && peer && !previous)
      this.owners.set(ownerId, peer);
    if (command.action === "wait_changes") {
      if (!peer || (previous && !sameConsumerProcess(previous, peer)))
        throw new PersonalFailure("OWNER_DETACHED");
      if (!previous) this.owners.set(ownerId, peer);
      const changes = await this.controller.changes(
        ownerId,
        command.afterVersion,
        command.instanceId,
        capturedScope,
      );
      if (
        !sameConsumerProcess(
          this.owners.get(ownerId) ??
            ("distribution" in this.configuration
              ? nativePeer
              : this.configuration.eventsPeer),
          peer,
        )
      )
        throw new PersonalFailure("OWNER_DETACHED");
      assertScope();
      return { reply: { ...base, ...changes }, stop: false };
    }
    if (command.action === "submit") {
      if (!peer || (previous && !sameConsumerProcess(previous, peer)))
        throw new PersonalFailure("OWNER_DETACHED");
      this.owners.set(ownerId, peer);
      return {
        reply: {
          ...base,
          job: this.controller.submit(command.submission, capturedScope),
        },
        stop: false,
      };
    }
    if (
      peer &&
      (!this.owners.get(ownerId) ||
        !sameConsumerProcess(this.owners.get(ownerId)!, peer))
    )
      throw new PersonalFailure("OWNER_DETACHED");
    if (command.action === "detach") {
      await this.controller.detachOwner(ownerId);
      this.owners.delete(ownerId);
    }
    if (command.action === "cancel")
      await this.controller.cancel(ownerId, command.jobId);
    const jobs: PersonalJobView[] = this.controller.snapshot(
      ownerId,
      capturedScope,
    );
    return { reply: { ...base, jobs }, stop: false };
  }
}
export async function servePersonalAgent(
  native: WindowsConsumerNative,
  owner: ConsumerOwnedProcess,
  router: PersonalCommandRouter,
  signal: AbortSignal,
  ticketKey:
    | "personal_ticket"
    | "personal_admission_ticket"
    | "personal_events_ticket" = "personal_ticket",
): Promise<void> {
  const server = await native.identity(),
    channel = randomBytes(32).toString("hex");
  while (!signal.aborted) {
    const nonce = randomBytes(32).toString("hex");
    await native.vaultWrite(
      "account",
      ticketKey,
      Buffer.from(
        JSON.stringify({
          version: 1,
          owner,
          server,
          channel,
          nonce,
          expiresAt: Date.now() + 35000,
        }),
      ),
    );
    let connection:
      | Awaited<ReturnType<WindowsConsumerNative["pipeAccept"]>>["connection"]
      | undefined;
    try {
      const request = await native.pipeAccept({
        channel,
        nonce,
        peer: null,
        timeoutMs: 30000,
      });
      connection = request.connection;
      let reply: PersonalReply,
        stop = false;
      try {
        const result = await router.command(
          request.payload,
          request.connection.peer,
        );
        reply = result.reply;
        stop = result.stop;
      } catch (error) {
        let requestId = "00000000-0000-4000-8000-000000000000";
        try {
          const envelope = JSON.parse(request.payload.toString("utf8"));
          requestId = parsePersonalCommand(
            Buffer.from(JSON.stringify(envelope.command)),
          ).requestId;
        } catch {}
        reply = {
          version: 1,
          requestId,
          ok: false,
          error:
            error instanceof PersonalFailure ? error.code : "INVALID_REQUEST",
        };
      }
      let encoded = Buffer.from(JSON.stringify(reply));
      if (encoded.length > 32768)
        encoded = Buffer.from(
          JSON.stringify({
            version: 1,
            requestId: reply.requestId,
            ok: false,
            error: "OUTPUT_INVALID",
          }),
        );
      await native.pipeReply(connection, encoded);
      connection = undefined;
      if (stop) return;
    } catch (error) {
      if (connection) await native.pipeClose(connection).catch(() => {});
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "TIMEOUT"
      )
        continue;
      throw error;
    }
  }
}
