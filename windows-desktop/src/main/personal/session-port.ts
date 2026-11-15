import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  sameConsumerProcess,
  type ConsumerOwnedProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import { verifyWindowsRelease } from "../../../../worker/src/platform/windows/release-manifest.js";
import {
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  parsePersonalCommand,
  parsePersonalScope,
  type PersonalCommand,
  type PersonalJobView,
} from "../../shared/personal-contracts.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import { HostContext } from "../host-context.js";
import type {
  SessionControlTicket,
  SessionRuntimeContext,
} from "../session/context.js";
import type { PersonalSessionPort } from "../session/supervisor.js";
import { parseReadyReceipt } from "../prepare/operations.js";
import {
  privateFingerprint,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import {
  parsePersonalAgentConfiguration,
  type PersonalAgentConfiguration,
} from "./configuration.js";
import { PersonalFailure } from "./controller.js";
import type { PersonalGuardView } from "./broker-admission.js";
import { StoreNodeIssuer } from "../session/store-node-issuer.js";
import { readStoreRoleReadiness } from "../prepare/store-readiness.js";
export interface PersonalReply {
  version: 1;
  requestId: string;
  ok: boolean;
  jobs?: PersonalJobView[];
  job?: PersonalJobView;
  error?: string;
  guard?: PersonalGuardView;
  changeVersion?: number;
  instanceId?: string;
  unchanged?: boolean;
  idle?: boolean;
}
function projectWaitReason(job: PersonalJobView): void {
  if (!job || typeof job !== "object" || Array.isArray(job))
    throw new PersonalFailure("PROCESSING_FAILED");
  const reason = job.waitReason;
  job.waitReason =
    job.state === "preparing" &&
    job.stage === "preparation" &&
    (reason === "waiting-for-worker" ||
      reason === "gpu-busy" ||
      reason === "recovering")
      ? reason
      : null;
}
export function parsePersonalTicket(
  value: unknown,
  expected?: ConsumerOwnedProcess,
): SessionControlTicket {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PersonalFailure("PREPARE_REQUIRED");
  const row = value as SessionControlTicket;
  if (
    Object.keys(row).sort().join() !==
      ["version", "owner", "server", "channel", "nonce", "expiresAt"]
        .sort()
        .join() ||
    row.version !== 1 ||
    !row.owner ||
    Object.keys(row.owner).length !== 3 ||
    row.owner.role !== "personal" ||
    !/^[a-f0-9]{64}$/.test(row.owner.nonce) ||
    !/^[a-f0-9]{64}$/.test(row.channel) ||
    !/^[a-f0-9]{64}$/.test(row.nonce) ||
    !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt < Date.now() ||
    row.expiresAt > Date.now() + 60_000
  )
    throw new PersonalFailure("PREPARE_REQUIRED");
  const owner = processIdentityFromWire(
      processIdentityToWire(row.owner.identity),
    ),
    server = processIdentityFromWire(processIdentityToWire(row.server));
  if (
    owner.sid !== server.sid ||
    owner.sessionId !== server.sessionId ||
    (expected &&
      (expected.nonce !== row.owner.nonce ||
        !sameConsumerProcess(expected.identity, owner)))
  )
    throw new PersonalFailure("OWNER_DETACHED");
  return structuredClone(row);
}
/** This client runs in the session agent which owns the personal guardian. */
export class PersonalAgentClient {
  #storeIssuer: StoreNodeIssuer | undefined;
  private owner: ConsumerOwnedProcess | undefined;
  private lastNonce: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly guardClient: PersonalAgentClient | undefined;
  private readonly eventsClient: PersonalAgentClient | undefined;
  constructor(
    private readonly context: Pick<
      SessionRuntimeContext,
      "native" | "verifyOwnedPeer"
    >,
    admissionContext?: Pick<
      SessionRuntimeContext,
      "native" | "verifyOwnedPeer"
    >,
    private readonly ticketKey:
      | "personal_ticket"
      | "personal_admission_ticket"
      | "personal_events_ticket" = "personal_ticket",
    eventsContext?: Pick<SessionRuntimeContext, "native" | "verifyOwnedPeer">,
    storeIssuer?: StoreNodeIssuer,
  ) {
    if (storeIssuer) {
      StoreNodeIssuer.prototype.assertNative.call(storeIssuer, context.native);
      if (storeIssuer.nodeRole !== "session-agent")
        throw new PersonalFailure("OWNER_DETACHED");
      this.#storeIssuer = storeIssuer;
    }
    this.guardClient = admissionContext
      ? new PersonalAgentClient(
          admissionContext,
          undefined,
          "personal_admission_ticket",
          undefined,
          storeIssuer,
        )
      : undefined;
    this.eventsClient = eventsContext
      ? new PersonalAgentClient(
          eventsContext,
          undefined,
          "personal_events_ticket",
          undefined,
          storeIssuer,
        )
      : undefined;
  }
  static forStore(
    issuer: StoreNodeIssuer,
    native: SessionRuntimeContext["native"],
  ): PersonalAgentClient {
    if (arguments.length !== 2) throw new PersonalFailure("OWNER_DETACHED");
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    if (issuer.nodeRole !== "session-agent")
      throw new PersonalFailure("OWNER_DETACHED");
    const context = Object.freeze({
      native,
      verifyOwnedPeer: async (
        owner: ConsumerOwnedProcess,
        peer: ConsumerProcessIdentity,
      ) => {
        StoreNodeIssuer.prototype.assertNative.call(issuer, native);
        if (!(await native.isOwnedProcess(owner, peer)))
          throw new PersonalFailure("OWNER_DETACHED");
        StoreNodeIssuer.prototype.assertNative.call(issuer, native);
      },
    });
    return new PersonalAgentClient(
      context,
      context,
      "personal_ticket",
      context,
      issuer,
    );
  }
  bind(owner: ConsumerOwnedProcess): void {
    if (owner.role !== "personal") throw new PersonalFailure("INVALID_REQUEST");
    this.owner = structuredClone(owner);
    this.guardClient?.bind(owner);
    this.eventsClient?.bind(owner);
  }
  async waitReady(signal: AbortSignal): Promise<void> {
    if (this.#storeIssuer) {
      signal.throwIfAborted();
      // The Creator's event-based mailbox waits for the actual owned Node;
      // Store startup never polls a mutable legacy ticket or selected pipe.
      await this.command({
        version: 1,
        requestId: randomUUID(),
        action: "status",
      });
      signal.throwIfAborted();
      return;
    }
    await this.guardClient?.waitReady(signal);
    await this.eventsClient?.waitReady(signal);
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const bytes = await this.context.native.vaultRead(
        "account",
        this.ticketKey,
      );
      if (bytes) {
        try {
          const ticket = parsePersonalTicket(
            JSON.parse(bytes.toString("utf8")),
            this.owner,
          );
          if (this.owner) {
            await this.context.verifyOwnedPeer(this.owner, ticket.server);
            return;
          }
        } catch {}
      }
      await delay(100, undefined, { signal });
    }
    throw new PersonalFailure("PREPARE_REQUIRED");
  }
  command(
    command: PersonalCommand,
    peer: ConsumerProcessIdentity | null = null,
    capturedScope?: SessionAccountScope | null,
  ): Promise<PersonalReply> {
    const guarding =
      command.action === "guard_acquire" ||
      command.action === "guard_status" ||
      command.action === "guard_release" ||
      command.action === "yield_idle";
    if (guarding && this.guardClient)
      return this.guardClient.command(command, peer, capturedScope);
    if (guarding && this.ticketKey !== "personal_admission_ticket")
      return Promise.reject(new PersonalFailure("INVALID_REQUEST"));
    if (command.action === "wait_changes" && this.eventsClient)
      return this.eventsClient.command(command, peer, capturedScope);
    if (
      command.action === "wait_changes" &&
      this.ticketKey !== "personal_events_ticket"
    )
      return Promise.reject(new PersonalFailure("INVALID_REQUEST"));
    const result = this.queue.then(async () => {
      parsePersonalCommand(Buffer.from(JSON.stringify(command)));
      let response: Buffer;
      if (this.#storeIssuer) {
        const owner = this.owner;
        if (!owner) throw new PersonalFailure("OWNER_DETACHED");
        StoreNodeIssuer.prototype.assertNative.call(
          this.#storeIssuer,
          this.context.native,
        );
        if (!(await this.context.native.isOwnedProcess(owner, owner.identity)))
          throw new PersonalFailure("OWNER_DETACHED");
        const request = Buffer.from(
          JSON.stringify({
            command,
            peer,
            ...(capturedScope !== undefined
              ? { captured_scope: parsePersonalScope(capturedScope) }
              : {}),
          }),
        );
        if (request.length > 4096) throw new PersonalFailure("INVALID_REQUEST");
        response = await StoreNodeIssuer.prototype.requestControl.call(
          this.#storeIssuer,
          "personal",
          request,
          undefined,
          owner,
        );
        StoreNodeIssuer.prototype.assertNative.call(
          this.#storeIssuer,
          this.context.native,
        );
        if (
          this.owner?.nonce !== owner.nonce ||
          !sameConsumerProcess(this.owner.identity, owner.identity) ||
          !(await this.context.native.isOwnedProcess(owner, owner.identity))
        )
          throw new PersonalFailure("OWNER_DETACHED");
      } else {
        let ticket: SessionControlTicket | undefined;
        for (let attempt = 0; attempt < 8; attempt++) {
          const bytes = await this.context.native.vaultRead(
            "account",
            this.ticketKey,
          );
          if (!bytes) throw new PersonalFailure("PREPARE_REQUIRED");
          const current = parsePersonalTicket(
            JSON.parse(bytes.toString("utf8")),
            this.owner,
          );
          if (current.nonce !== this.lastNonce) {
            ticket = current;
            break;
          }
          await delay(100);
        }
        if (!ticket) throw new PersonalFailure("PROCESSING_FAILED");
        if (!this.owner) throw new PersonalFailure("OWNER_DETACHED");
        await this.context.verifyOwnedPeer(this.owner, ticket.server);
        const request = Buffer.from(
          JSON.stringify({
            command,
            peer,
            ...(capturedScope !== undefined
              ? { captured_scope: parsePersonalScope(capturedScope) }
              : {}),
          }),
        );
        if (request.length > 4096) throw new PersonalFailure("INVALID_REQUEST");
        this.lastNonce = ticket.nonce;
        response = await this.context.native.pipeConnect({
          channel: ticket.channel,
          nonce: ticket.nonce,
          peer: ticket.server,
          payload: request,
          timeoutMs: 30000,
        });
      }
      const reply = JSON.parse(response.toString("utf8")) as PersonalReply;
      if (
        reply.version !== 1 ||
        reply.requestId !== command.requestId ||
        typeof reply.ok !== "boolean" ||
        (!reply.ok && typeof reply.error !== "string") ||
        (["idle_proof", "yield_idle"].includes(command.action) &&
          reply.ok &&
          typeof reply.idle !== "boolean")
      )
        throw new PersonalFailure("PROCESSING_FAILED");
      if (!reply.ok)
        throw new PersonalFailure(
          [
            "INVALID_REQUEST",
            "INPUT_UNSUPPORTED",
            "INPUT_CHANGED",
            "INPUT_LIMIT",
            "PREPARE_REQUIRED",
            "GPU_BUSY",
            "GPU_UNSUPPORTED",
            "SOURCE_UNAVAILABLE",
            "SOURCE_BOT_CHALLENGE",
            "ACQUISITION_RATE_LIMITED",
            "ACQUISITION_COOLDOWN",
            "DURATION_LIMIT",
            "OUTPUT_INVALID",
            "PROCESSING_FAILED",
            "CANCELLED",
            "OWNER_DETACHED",
            "SCOPE_CHANGED",
            "STOP_UNCONFIRMED",
          ].includes(reply.error ?? "")
            ? (reply.error as PersonalFailure["code"])
            : "PROCESSING_FAILED",
        );
      if (reply.job) projectWaitReason(reply.job);
      if (reply.jobs !== undefined) {
        if (!Array.isArray(reply.jobs))
          throw new PersonalFailure("PROCESSING_FAILED");
        for (const job of reply.jobs) projectWaitReason(job);
      }
      return reply;
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
export interface PersonalSessionOptions {
  hardware?(): Promise<DirectmlGpuIdentity[]>;
  backendOrigin?: string;
}
/** Readiness is derived from the protected activated receipt, never an account or backend grant. */
export async function createPersonalSessionPort(
  context: SessionRuntimeContext,
  options: PersonalSessionOptions = {},
): Promise<
  PersonalSessionPort & {
    client: PersonalAgentClient;
    idle(): Promise<boolean>;
  }
> {
  const store = context.distribution === "microsoft-store";
  const storeIssuer = store ? context.storeIssuer : undefined;
  if (store) {
    if (!storeIssuer) throw new PersonalFailure("PREPARE_REQUIRED");
    StoreNodeIssuer.prototype.assertNative.call(storeIssuer, context.native);
    if (storeIssuer.nodeRole !== "session-agent")
      throw new PersonalFailure("PREPARE_REQUIRED");
  }
  const native = await context.openNative();
  const admissionNative = store ? native : await context.openNative();
  const eventsNative = store ? native : await context.openNative();
  if (!store) context = { ...context, native };
  const client = storeIssuer
    ? PersonalAgentClient.forStore(storeIssuer, native)
    : new PersonalAgentClient(
        context,
        { ...context, native: admissionNative },
        "personal_ticket",
        { ...context, native: eventsNative },
      );
  let running = false,
    scope: SessionAccountScope | null = null;
  return {
    client,
    prepared: async () => {
      try {
        const identity = await context.native.identity(),
          host = await HostContext.initialize(context.native, "0.1.0", 1);
        if (storeIssuer) {
          const ready = await readStoreRoleReadiness(
            host,
            storeIssuer,
            new AbortController().signal,
          );
          if (
            !ready ||
            ready.binding.inventorySha256 !== context.configuration.release
          )
            return false;
          resolveQualifiedGpuIdentity(
            ready.evidence.gpuIdentity!,
            await (options.hardware?.() ?? native.enumerateGpus()),
          );
          StoreNodeIssuer.prototype.assertNative.call(
            storeIssuer,
            context.native,
          );
          return true;
        }
        const bytes = await context.native.vaultRead(
          "account",
          "ready_receipt",
        );
        if (!bytes) return false;
        const { receipt, evidence } = parseReadyReceipt(
          JSON.parse(bytes.toString("utf8")),
          { sid: identity.sid, identity: context.configuration.release },
          await context.native.bootIdentity(),
        );
        const manifest = await verifyWindowsRelease(
          context.configuration.releaseRoot,
          "windows-user",
        );
        const digest = createHash("sha256")
          .update(
            await readFile(
              win32.join(
                context.configuration.releaseRoot,
                "release-manifest.json",
              ),
            ),
          )
          .digest("hex");
        const helper = manifest.entries.find(
          (e) =>
            e.kind === "file" &&
            e.path === "runtime/native/musicmute-native.exe",
        );
        if (
          digest !== receipt.manifestSha256 ||
          helper?.kind !== "file" ||
          helper.sha256 !== context.configuration.nativeSha256 ||
          JSON.stringify(
            await privateFingerprint(host, `models\\${MODEL.filename}`),
          ) !== JSON.stringify(receipt.modelFingerprint)
        )
          return false;
        resolveQualifiedGpuIdentity(
          evidence.gpuIdentity!,
          await (options.hardware?.() ?? native.enumerateGpus()),
        );
        const configuration: PersonalAgentConfiguration = {
          version: 1,
          kind: "personal",
          installationProfile: "windows-user",
          release: receipt.release,
          releaseRoot: context.configuration.releaseRoot,
          nativeSha256: context.configuration.nativeSha256,
          personalRoot: context.configuration.personalRoot,
          sid: identity.sid,
          manifestSha256: receipt.manifestSha256,
          qualification: receipt.qualification,
          bootIdentity: receipt.bootIdentity,
          modelFingerprint: receipt.modelFingerprint,
          controlPeer: processIdentityFromWire(processIdentityToWire(identity)),
          admissionPeer: processIdentityFromWire(
            processIdentityToWire(await admissionNative.identity()),
          ),
          eventsPeer: processIdentityFromWire(
            processIdentityToWire(await eventsNative.identity()),
          ),
          ...(options.backendOrigin
            ? { backendOrigin: options.backendOrigin }
            : {}),
        };
        parsePersonalAgentConfiguration(configuration);
        await writePrivateAtomic(
          host,
          "personal-config.json",
          Buffer.from(JSON.stringify(configuration)),
        );
        return true;
      } catch {
        return false;
      }
    },
    reconcile: async (owner, signal) => {
      signal.throwIfAborted();
      client.bind(owner);
      await client.waitReady(signal);
      await client.command({
        version: 1,
        requestId: randomUUID(),
        action: "status",
      });
      await client.command({
        version: 1,
        requestId: randomUUID(),
        action: "scope",
        scope,
      });
      running = true;
      signal.throwIfAborted();
    },
    detachOwner: async (ownerId, signal) => {
      signal.throwIfAborted();
      if (running)
        await client.command({
          version: 1,
          requestId: randomUUID(),
          action: "detach",
          ownerId,
        });
    },
    applyAccountScope: async (value: SessionAccountScope | null) => {
      scope = structuredClone(value);
      if (running)
        await client.command({
          version: 1,
          requestId: randomUUID(),
          action: "scope",
          scope,
        });
    },
    idle: async () => {
      if (!running) return false;
      const reply = await client.command({
        version: 1,
        requestId: randomUUID(),
        action: "idle_proof",
      });
      return reply.idle === true;
    },
    gracefulStop: async (owner, signal) => {
      signal.throwIfAborted();
      client.bind(owner);
      try {
        await client.command({
          version: 1,
          requestId: randomUUID(),
          action: "stop",
        });
      } finally {
        running = false;
      }
    },
  };
}
