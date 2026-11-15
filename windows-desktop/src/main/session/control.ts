import { randomBytes, randomUUID } from "node:crypto";
import { parseSessionSnapshot } from "../../shared/session-snapshot.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  dispatchPersonalOwnerProof,
  parsePersonalOwnerProof,
  personalOwnerProofCommand,
  type PersonalPlaybackOwnerRequest,
  type PersonalPlaybackOwnerProof,
} from "./personal-owner-proof.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  processIdentityFromWire,
  processIdentityToWire,
  sameConsumerProcess,
  type ConsumerOwnedProcess,
  type ConsumerProcessIdentity,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  parseSessionCommand,
  type SessionCommand,
  type SessionAccountScope,
  type SessionReply,
  type SessionSnapshot,
} from "../../shared/session-contracts.js";
import {
  parsePersonalCommand,
  parsePersonalScope,
  type PersonalCommand,
} from "../../shared/personal-contracts.js";
import type {
  PersonalAgentClient,
  PersonalReply,
} from "../personal/session-port.js";
import type { SessionControlTicket, SessionRuntimeContext } from "./context.js";
import type { SessionSupervisor } from "./supervisor.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_COMMAND");
  return value as Record<string, unknown>;
}
export function parseSessionTicket(
  value: unknown,
  now = Date.now(),
): SessionControlTicket {
  const row = object(value),
    owner = object(row.owner);
  if (
    Object.keys(row).sort().join() !==
      ["version", "owner", "server", "channel", "nonce", "expiresAt"]
        .sort()
        .join() ||
    row.version !== 1 ||
    Object.keys(owner).sort().join() !== "identity,nonce,role" ||
    owner.role !== "session-agent" ||
    typeof owner.nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(owner.nonce) ||
    typeof row.channel !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.channel) ||
    typeof row.nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.nonce) ||
    !Number.isSafeInteger(row.expiresAt) ||
    (row.expiresAt as number) <= now ||
    (row.expiresAt as number) > now + 35000
  )
    throw new Error("SESSION_UNAVAILABLE");
  const identity = processIdentityFromWire(
      processIdentityToWire(owner.identity as ConsumerProcessIdentity),
    ),
    server = processIdentityFromWire(
      processIdentityToWire(row.server as ConsumerProcessIdentity),
    );
  if (identity.sid !== server.sid || identity.sessionId !== server.sessionId)
    throw new Error("PEER_DENIED");
  return {
    version: 1,
    owner: { role: "session-agent", nonce: owner.nonce, identity },
    server,
    channel: row.channel,
    nonce: row.nonce,
    expiresAt: row.expiresAt as number,
  };
}
function errorCode(
  error: unknown,
): SessionReply extends { error: { code: infer T } } ? T : string {
  return error instanceof Error &&
    [
      "INVALID_COMMAND",
      "REQUEST_ID_REUSED",
      "PEER_DENIED",
      "SESSION_UNAVAILABLE",
      "STATE_UNAVAILABLE",
      "CHILD_SHUTDOWN_PENDING",
      "FORCE_CONFIRMATION_STALE",
      "UPDATE_BUSY",
    ].includes(error.message)
    ? error.message
    : "SESSION_UNAVAILABLE";
}
export interface SessionDispatcher {
  dispatch(payload: Uint8Array, peer: ConsumerProcessIdentity): Promise<Buffer>;
  afterReply?(payload: Uint8Array): void;
}
export function createSessionDispatcher(
  supervisor: SessionSupervisor,
  personal: PersonalAgentClient,
  gpu: SessionDispatcher,
  native?: Pick<WindowsConsumerNative, "sameParentProcess"> &
    Partial<Pick<WindowsConsumerNative, "verifyPersonalOwnerProofPeers">>,
  onRetire?: () => void,
  verifyRolePeer?: (
    owner: ConsumerOwnedProcess,
    peer: ConsumerProcessIdentity,
  ) => Promise<void>,
): SessionDispatcher {
  const retiring = new Set<string>();
  return {
    afterReply: (payload) => {
      let row;
      try {
        row = JSON.parse(Buffer.from(payload).toString("utf8")) as {
          request_id?: string;
        };
      } catch {
        return;
      }
      if (row.request_id && retiring.delete(row.request_id)) onRetire?.();
    },
    dispatch: async (payload, peer) => {
      if (payload.byteLength > 4096) throw new Error("INVALID_COMMAND");
      const row = object(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(payload),
          4096,
        ),
      );
      if (row.kind === "gpu-admission") return gpu.dispatch(payload, peer);
      if (row.kind === "personal-activity") {
        if (
          Object.keys(row).sort().join() !==
            "kind,ownerReceipt,request_id,version" ||
          row.version !== 1 ||
          typeof row.request_id !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
            row.request_id,
          ) ||
          !verifyRolePeer
        )
          throw new Error("PEER_DENIED");
        const receipt = object(row.ownerReceipt),
          identity = object(receipt.identity);
        if (
          Object.keys(receipt).sort().join() !== "identity,nonce,role" ||
          receipt.role !== "personal" ||
          typeof receipt.nonce !== "string" ||
          !/^[a-f0-9]{64}$/u.test(receipt.nonce) ||
          Object.keys(identity).sort().join() !==
            "creationTime,pid,sessionId,sid"
        )
          throw new Error("PEER_DENIED");
        const owner: ConsumerOwnedProcess = {
          role: "personal",
          nonce: receipt.nonce,
          identity: processIdentityFromWire(
            processIdentityToWire(
              identity as unknown as ConsumerProcessIdentity,
            ),
          ),
        };
        await verifyRolePeer(owner, peer);
        return Buffer.from(
          JSON.stringify({
            version: 1,
            request_id: row.request_id,
            ok: true,
            snapshot: await supervisor.refreshMaintenance(owner),
          }),
        );
      }
      if (row.kind === "personal-owner-proof") {
        if (!native?.verifyPersonalOwnerProofPeers)
          throw new Error("PEER_DENIED");
        return dispatchPersonalOwnerProof(payload, peer, {
          native: {
            verifyPersonalOwnerProofPeers: (authority, owner, kind) =>
              native.verifyPersonalOwnerProofPeers!(authority, owner, kind),
          },
          supervisor,
          personal,
        });
      }
      if (row.kind === "personal-command") {
        const fields = ["command", "kind", "owner_kind", "version"];
        if (row.original_peer !== undefined) fields.push("original_peer");
        if (row.submission_authority !== undefined)
          fields.push("submission_authority");
        if (
          Object.keys(row).sort().join() !== fields.sort().join() ||
          row.version !== 1 ||
          (row.owner_kind !== "desktop" && row.owner_kind !== "chrome")
        )
          throw new Error("INVALID_COMMAND");
        const command = parsePersonalCommand(
          Buffer.from(JSON.stringify(row.command)),
        );
        let submissionScope: SessionAccountScope | null | undefined;
        if (row.submission_authority !== undefined) {
          if (command.action !== "submit") throw new Error("INVALID_COMMAND");
          const authority = object(row.submission_authority);
          if (
            authority.kind === "guest" &&
            Object.keys(authority).sort().join() === "kind"
          )
            submissionScope = null;
          else if (
            authority.kind === "account" &&
            Object.keys(authority).sort().join() === "kind,scope"
          ) {
            submissionScope = parsePersonalScope(authority.scope);
            if (!submissionScope) throw new Error("INVALID_COMMAND");
          } else throw new Error("INVALID_COMMAND");
          if (row.owner_kind === "chrome" && submissionScope !== null)
            throw new Error("PEER_DENIED");
        }
        const assertSubmissionScope = () => {
          if (
            submissionScope &&
            JSON.stringify(submissionScope) !==
              JSON.stringify(supervisor.currentAccountScope())
          )
            throw new Error("SCOPE_CHANGED");
        };
        assertSubmissionScope();
        if (
          ![
            "status",
            "submit",
            "jobs",
            "cancel",
            "detach",
            "wait_changes",
          ].includes(command.action)
        )
          throw new Error("PEER_DENIED");
        if (command.action === "submit" && supervisor.maintenanceActive())
          throw new Error("SESSION_UNAVAILABLE");
        let caller = peer;
        if (row.original_peer !== undefined) {
          if (String(command.action) !== "wait_changes" || !native)
            throw new Error("PEER_DENIED");
          const original = processIdentityFromWire(
            processIdentityToWire(row.original_peer as ConsumerProcessIdentity),
          );
          if (!(await native.sameParentProcess(peer, original)))
            throw new Error("PEER_DENIED");
          caller = original;
        }
        const ownerId =
          command.action === "submit"
            ? command.submission.ownerId
            : "ownerId" in command
              ? command.ownerId
              : null;
        if (ownerId && String(command.action) === "wait_changes")
          await supervisor.authorizePersonalOwner(ownerId, caller);
        else if (ownerId && command.action !== "detach") {
          const snapshot = await supervisor.command(
            {
              version: 1,
              request_id: randomUUID(),
              action: "personal_attach",
              owner_id: ownerId,
              owner_kind: row.owner_kind,
            },
            caller,
          );
          if (snapshot.personal.phase !== "running")
            throw new Error("SESSION_UNAVAILABLE");
        }
        assertSubmissionScope();
        const reply = await personal.command(
          command,
          caller,
          ["submit", "jobs", "wait_changes"].includes(command.action)
            ? row.owner_kind === "desktop"
              ? command.action === "submit" && submissionScope !== undefined
                ? submissionScope
                : supervisor.currentAccountScope()
              : null
            : undefined,
        );
        if (command.action === "detach" && ownerId)
          await supervisor.command(
            {
              version: 1,
              request_id: randomUUID(),
              action: "personal_detach",
              owner_id: ownerId,
            },
            caller,
          );
        return Buffer.from(JSON.stringify(reply));
      }
      let commandPayload = payload;
      let sessionPeer = peer;
      if (row.kind === "session-state") {
        if (
          Object.keys(row).sort().join() !==
            "command,kind,original_peer,version" ||
          row.version !== 1 ||
          !native
        )
          throw new Error("INVALID_COMMAND");
        const original = processIdentityFromWire(
          processIdentityToWire(row.original_peer as ConsumerProcessIdentity),
        );
        if (!(await native.sameParentProcess(peer, original)))
          throw new Error("PEER_DENIED");
        commandPayload = Buffer.from(JSON.stringify(row.command));
        sessionPeer = original;
      }
      const command = parseSessionCommand(commandPayload);
      if (row.kind === "session-state" && command.action !== "wait_state")
        throw new Error("PEER_DENIED");
      let reply: SessionReply;
      try {
        reply = {
          version: 1,
          request_id: command.request_id,
          ok: true,
          snapshot: await supervisor.command(command, sessionPeer),
        };
      } catch (error) {
        reply = {
          version: 1,
          request_id: command.request_id,
          ok: false,
          error: { code: errorCode(error) as "SESSION_UNAVAILABLE" },
        };
      }
      if (reply.ok && command.action === "maintenance_commit")
        retiring.add(command.request_id);
      return Buffer.from(JSON.stringify(reply));
    },
  };
}

/** Each listener is single-use. Accepted dispatches run independently of the next authenticated listener. */
export async function serveSessionControl(
  context: SessionRuntimeContext,
  dispatcher: SessionDispatcher,
  signal: AbortSignal,
): Promise<void> {
  await context.native.assertSingletonPublication("session");
  const identity = await context.native.processIdentity(process.pid);
  if (!identity) throw new Error("SESSION_UNAVAILABLE");
  const owner: ConsumerOwnedProcess = {
    role: "session-agent",
    nonce: randomBytes(32).toString("hex"),
    identity,
  };
  const handlers = new Set<Promise<void>>();
  const servers = new Set<WindowsConsumerNative>();
  const abort = () => {
    for (const server of servers) void server.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      if (handlers.size >= 16) {
        await Promise.race(handlers);
        continue;
      }
      const server = await context.openNative();
      servers.add(server);
      let accepted: Awaited<ReturnType<WindowsConsumerNative["pipeAccept"]>>;
      try {
        const ticket: SessionControlTicket = {
          version: 1,
          owner,
          server: await server.identity(),
          channel: randomBytes(32).toString("hex"),
          nonce: randomBytes(32).toString("hex"),
          expiresAt: Date.now() + 30000,
        };
        await context.native.assertSingletonPublication("session");
        await context.native.vaultWrite(
          "fleet",
          "session_ticket",
          Buffer.from(JSON.stringify(ticket)),
        );
        accepted = await server.pipeAccept({
          channel: ticket.channel,
          nonce: ticket.nonce,
          peer: null,
          timeoutMs: 30000,
        });
      } catch (error) {
        servers.delete(server);
        await server.close();
        if (signal.aborted) break;
        if (error instanceof Error && error.message === "PIPE_TIMEOUT")
          continue;
        throw error;
      }
      let handler!: Promise<void>;
      handler = (async () => {
        try {
          const response = await dispatcher.dispatch(
            accepted.payload,
            accepted.connection.peer,
          );
          if (response.length > 32768) throw new Error("INVALID_COMMAND");
          await server.pipeReply(accepted.connection, response);
          dispatcher.afterReply?.(accepted.payload);
        } catch {
          // A malformed request cannot receive an invented successful acknowledgment.
          try {
            await server.pipeClose(accepted.connection);
          } catch {}
        } finally {
          servers.delete(server);
          await server.close();
          handlers.delete(handler);
        }
      })();
      handlers.add(handler);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    abort();
    await Promise.allSettled(handlers);
    // Delete only our own still-published endpoint after independent agent replacement races.
    const bytes = await context.native
      .vaultRead("fleet", "session_ticket")
      .catch(() => null);
    if (bytes) {
      try {
        const ticket = parseSessionTicket(JSON.parse(bytes.toString("utf8")));
        if (ticket.owner.nonce === owner.nonce)
          await context.native.vaultDelete("fleet", "session_ticket");
      } catch {
      } finally {
        bytes.fill(0);
      }
    }
  }
}

/** Stable client native identity keeps personal owner fences valid across commands. */
export class SessionClient {
  private authority: ConsumerProcessIdentity | undefined;
  currentAuthority(): ConsumerProcessIdentity | undefined {
    return this.authority ? structuredClone(this.authority) : undefined;
  }
  private lastNonce: string | null = null;
  private eventClient: Promise<SessionClient> | undefined;
  constructor(
    private readonly native: WindowsConsumerNative,
    private readonly openEvents?: () => Promise<WindowsConsumerNative>,
  ) {}
  async exchange(
    payload: Uint8Array,
    signal: AbortSignal = AbortSignal.timeout(35000),
  ): Promise<Buffer> {
    if (payload.byteLength > 4096) throw new Error("INVALID_COMMAND");
    const current = await this.native.identity();
    for (let attempt = 0; attempt < 40; attempt++) {
      signal.throwIfAborted();
      const bytes = await this.native.vaultRead("fleet", "session_ticket");
      let ticket: SessionControlTicket | null = null;
      try {
        if (bytes)
          ticket = parseSessionTicket(JSON.parse(bytes.toString("utf8")));
      } catch {
      } finally {
        bytes?.fill(0);
      }
      if (!ticket || ticket.nonce === this.lastNonce) {
        await delay(100, undefined, { signal });
        continue;
      }
      if (
        ticket.owner.identity.sid !== current.sid ||
        ticket.owner.identity.sessionId !== current.sessionId ||
        !sameConsumerProcess(
          (await this.native.processIdentity(ticket.owner.identity.pid)) ?? {
            ...current,
            pid: 0,
          },
          ticket.owner.identity,
        )
      )
        throw new Error("SESSION_UNAVAILABLE");
      this.lastNonce = ticket.nonce;
      this.authority = structuredClone(ticket.owner.identity);
      if (!(await this.native.claimSessionTicket(ticket.nonce))) {
        await delay(100, undefined, { signal });
        continue;
      }
      return this.native.pipeConnect({
        channel: ticket.channel,
        nonce: ticket.nonce,
        peer: ticket.server,
        payload,
        timeoutMs: 30000,
      });
    }
    throw new Error("SESSION_UNAVAILABLE");
  }
  async command(
    command: SessionCommand,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    const bytes = Buffer.from(JSON.stringify(command));
    parseSessionCommand(bytes);
    const reply = object(
      JSON.parse((await this.exchange(bytes, signal)).toString("utf8")),
    ) as unknown as SessionReply;
    if (
      reply.version !== 1 ||
      reply.request_id !== command.request_id ||
      typeof reply.ok !== "boolean"
    )
      throw new Error("SESSION_UNAVAILABLE");
    if (!reply.ok) throw new Error(errorCode(new Error(reply.error.code)));
    return parseSessionSnapshot(reply.snapshot);
  }
  async notifyPersonalActivity(
    owner: ConsumerOwnedProcess,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    if (owner.role !== "personal") throw new Error("PEER_DENIED");
    const requestId = randomUUID(),
      reply = object(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await this.exchange(
              Buffer.from(
                JSON.stringify({
                  version: 1,
                  kind: "personal-activity",
                  request_id: requestId,
                  ownerReceipt: owner,
                }),
              ),
              signal,
            ),
          ),
          32768,
        ),
      );
    if (
      Object.keys(reply).sort().join() !== "ok,request_id,snapshot,version" ||
      reply.version !== 1 ||
      reply.request_id !== requestId ||
      reply.ok !== true
    )
      throw new Error("SESSION_UNAVAILABLE");
    return parseSessionSnapshot(reply.snapshot);
  }
  async waitState(
    afterRevision: number,
    instanceId?: string,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    if (!this.openEvents) throw new Error("SESSION_UNAVAILABLE");
    const client = await (this.eventClient ??= (async () =>
      new SessionClient(await this.openEvents!()))());
    const command: SessionCommand = {
      version: 1,
      request_id: randomUUID(),
      action: "wait_state",
      after_revision: afterRevision,
      ...(instanceId ? { instance_id: instanceId } : {}),
    };
    parseSessionCommand(Buffer.from(JSON.stringify(command)));
    const reply = object(
      JSON.parse(
        (
          await client.exchange(
            Buffer.from(
              JSON.stringify({
                version: 1,
                kind: "session-state",
                command,
                original_peer: await this.native.identity(),
              }),
            ),
            signal,
          )
        ).toString("utf8"),
      ),
    ) as unknown as SessionReply;
    if (
      reply.version !== 1 ||
      reply.request_id !== command.request_id ||
      typeof reply.ok !== "boolean"
    )
      throw new Error("SESSION_UNAVAILABLE");
    if (!reply.ok) throw new Error(errorCode(new Error(reply.error.code)));
    return parseSessionSnapshot(reply.snapshot);
  }
  async provePersonalOwner(
    request: PersonalPlaybackOwnerRequest,
  ): Promise<PersonalPlaybackOwnerProof> {
    const command = personalOwnerProofCommand(request);
    const reply = object(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await this.exchange(Buffer.from(JSON.stringify(command))),
        ),
        32768,
      ),
    );
    if (
      Object.keys(reply).sort().join() !== "ok,proof,request_id,version" ||
      reply.version !== 1 ||
      reply.request_id !== command.request_id ||
      reply.ok !== true
    )
      throw new Error("PEER_DENIED");
    return parsePersonalOwnerProof(reply.proof, request);
  }
  async personal(
    command: PersonalCommand,
    ownerKind: "desktop" | "chrome" = "desktop",
    capturedScope?: SessionAccountScope | null,
  ): Promise<PersonalReply> {
    parsePersonalCommand(Buffer.from(JSON.stringify(command)));
    if (capturedScope !== undefined && command.action !== "submit")
      throw new Error("INVALID_COMMAND");
    const submissionScope =
      command.action === "submit"
        ? parsePersonalScope(capturedScope ?? null)
        : undefined;
    if (ownerKind === "chrome" && submissionScope)
      throw new Error("PEER_DENIED");
    const wait = String(command.action) === "wait_changes";
    if (wait && !this.openEvents) throw new Error("SESSION_UNAVAILABLE");
    const client = wait
      ? await (this.eventClient ??= (async () =>
          new SessionClient(await this.openEvents!()))())
      : this;
    const originalPeer = wait ? await this.native.identity() : undefined;
    const reply = object(
      JSON.parse(
        (
          await client.exchange(
            Buffer.from(
              JSON.stringify({
                version: 1,
                kind: "personal-command",
                owner_kind: ownerKind,
                command,
                ...(submissionScope !== undefined
                  ? {
                      submission_authority: submissionScope
                        ? { kind: "account", scope: submissionScope }
                        : { kind: "guest" },
                    }
                  : {}),
                ...(originalPeer ? { original_peer: originalPeer } : {}),
              }),
            ),
          )
        ).toString("utf8"),
      ),
    ) as unknown as PersonalReply;
    if (
      reply.version !== 1 ||
      reply.requestId !== command.requestId ||
      typeof reply.ok !== "boolean"
    )
      throw new Error("SESSION_UNAVAILABLE");
    return reply;
  }
}
