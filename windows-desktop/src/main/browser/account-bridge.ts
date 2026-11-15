import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { isInstallationCheck } from "../../../../chrome-extension/src/shared/installation-check.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
  sameConsumerProcess,
  ConsumerNativeError,
  type ConsumerAccountAppPin,
  type ConsumerProcessIdentity,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { BrowserAccountAuthority } from "./account-authority.js";
import {
  parseChromeDiagnosticExport,
  type ChromeDiagnosticExport,
} from "../diagnostics/browser-report.js";
import {
  parseBrowserAccountCommand,
  type BrowserAccountCommand,
  type BrowserAccountReply,
  type BrowserDiagnosticReply,
  type BrowserAccountState,
} from "./account-contracts.js";
import type { InstallerMaintenanceHandler } from "./installer-maintenance.js";
import {
  StoreAccountNative,
  type StoreAccountTicket,
} from "./store-account-native.js";
type AccountNative = WindowsConsumerNative | StoreAccountNative;
type AccountTicket = Ticket | StoreAccountTicket;
/** An abort is not proof that every actual listener helper has retired. */
export class BrowserAccountCleanupUnconfirmed extends Error {
  constructor(cause: unknown) {
    super("BROWSER_ACCOUNT_CLEANUP_UNCONFIRMED", { cause });
  }
}
type AccountAuthorityContext =
  | {
      kind?: "legacy";
      native: WindowsConsumerNative;
      openNative(): Promise<WindowsConsumerNative>;
      installerMaintenance?: InstallerMaintenanceHandler;
    }
  | {
      kind: "store";
      native: StoreAccountNative;
      openNative(): Promise<StoreAccountNative>;
      installerMaintenance?: never;
    };
async function assertAccountPublication(
  context: AccountAuthorityContext,
): Promise<void> {
  if (context.kind === "store")
    await StoreAccountNative.prototype.assertSingletonPublication.call(
      context.native,
      "account",
    );
  else await context.native.assertSingletonPublication("account");
}

interface Ticket {
  version: 1;
  owner: ConsumerProcessIdentity;
  server: ConsumerProcessIdentity;
  instance_id: string;
  channel: string;
  nonce: string;
  expires_at: number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
  return value as Record<string, unknown>;
}
function identity(value: unknown): ConsumerProcessIdentity {
  const row = record(value);
  if (Object.keys(row).sort().join() !== "creationTime,pid,sessionId,sid")
    throw new Error("PEER_DENIED");
  return processIdentityFromWire(
    processIdentityToWire(row as unknown as ConsumerProcessIdentity),
  );
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function parseBrowserAccountTicket(
  value: unknown,
  now = Date.now(),
): Ticket {
  const row = record(value);
  if (
    Object.keys(row).sort().join() !==
      "channel,expires_at,instance_id,nonce,owner,server,version" ||
    row.version !== 1 ||
    typeof row.instance_id !== "string" ||
    !UUID.test(row.instance_id) ||
    typeof row.channel !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.channel) ||
    typeof row.nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.nonce) ||
    !Number.isSafeInteger(row.expires_at) ||
    (row.expires_at as number) <= now ||
    (row.expires_at as number) > now + 35000
  )
    throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
  const owner = identity(row.owner),
    server = identity(row.server);
  if (owner.sid !== server.sid || owner.sessionId !== server.sessionId)
    throw new Error("PEER_DENIED");
  return {
    version: 1,
    owner,
    server,
    instance_id: row.instance_id,
    channel: row.channel,
    nonce: row.nonce,
    expires_at: row.expires_at as number,
  };
}
/** Native private control only: safe cloud state/media, never a bearer token or raw realtime grant. */
export async function serveBrowserAccountAuthority(
  context: AccountAuthorityContext,
  authority: BrowserAccountAuthority,
  signal: AbortSignal,
): Promise<void> {
  await assertAccountPublication(context);
  const owner = processIdentityFromWire(
      processIdentityToWire(
        context.kind === "store"
          ? await StoreAccountNative.prototype.identity.call(context.native)
          : await context.native.identity(),
      ),
    ),
    servers = new Set<AccountNative>(),
    handlers = new Set<Promise<void>>(),
    retiring = new Set<Promise<void>>(),
    retirementByServer = new WeakMap<AccountNative, Promise<void>>();
  let cleanupFailure: BrowserAccountCleanupUnconfirmed | undefined,
    storeTicketPublished = false;
  const retire = (server: AccountNative): Promise<void> => {
    const existing = retirementByServer.get(server);
    if (existing) return existing;
    const retirement = Promise.resolve()
      .then(() => server.close())
      .then(() => {
        servers.delete(server);
        retiring.delete(retirement);
      });
    retirementByServer.set(server, retirement);
    retiring.add(retirement);
    // Observe failures immediately, including closes initiated by the abort
    // event. Keep the original promise/owner until the final join proves exit.
    void retirement.catch((error) => {
      cleanupFailure ??= new BrowserAccountCleanupUnconfirmed(error);
      abort();
    });
    return retirement;
  };
  const abort = () => {
    for (const server of servers) void retire(server);
  };
  const joinRetirement = async () => {
    const results = await Promise.allSettled([...handlers, ...retiring]);
    const failure = results.find((result) => result.status === "rejected");
    // Cleanup uncertainty takes precedence over a cancelled request. The exact
    // original owners stay retained instead of publishing a successful abort.
    if (cleanupFailure) throw cleanupFailure;
    if (failure?.status === "rejected")
      throw new BrowserAccountCleanupUnconfirmed(failure.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      if (cleanupFailure) throw cleanupFailure;
      if (handlers.size >= 64) {
        await Promise.race(handlers);
        continue;
      }
      const server = await context.openNative();
      servers.add(server);
      if (signal.aborted) {
        await retire(server);
        break;
      }
      let accepted: Awaited<ReturnType<WindowsConsumerNative["pipeAccept"]>>;
      try {
        const ticket: AccountTicket =
          context.kind === "store"
            ? await StoreAccountNative.prototype.publishTicket.call(
                server as StoreAccountNative,
                owner,
                authority.instanceId,
              )
            : {
                version: 1,
                owner,
                server: processIdentityFromWire(
                  processIdentityToWire(await server.identity()),
                ),
                instance_id: authority.instanceId,
                channel: randomBytes(32).toString("hex"),
                nonce: randomBytes(32).toString("hex"),
                expires_at: Date.now() + 30000,
              };
        if (context.kind === "store") storeTicketPublished = true;
        await assertAccountPublication(context);
        if (context.kind !== "store")
          await context.native.vaultWrite(
            "account",
            "browser_ticket",
            Buffer.from(JSON.stringify(ticket)),
          );
        if (signal.aborted) throw new Error("PIPE_TIMEOUT");
        accepted = await server.pipeAccept({
          channel: ticket.channel,
          nonce: ticket.nonce,
          peer: null,
          timeoutMs: 30000,
        });
      } catch (error) {
        await retire(server);
        if (cleanupFailure) throw cleanupFailure;
        if (signal.aborted) break;
        if (
          context.kind === "store" &&
          error instanceof ConsumerNativeError &&
          error.code === "TIMEOUT"
        )
          continue;
        if (error instanceof Error && error.message === "PIPE_TIMEOUT")
          continue;
        throw error;
      }
      let handler!: Promise<void>;
      handler = (async () => {
        let releaseReply: (() => void) | undefined;
        try {
          if (accepted.payload.length > 4096)
            throw new Error("INVALID_COMMAND");
          const envelope = record(
            parseStrictJson(
              new TextDecoder("utf-8", { fatal: true }).decode(
                accepted.payload,
              ),
            ),
          );
          if (envelope.kind === "installer-maintenance") {
            if (
              Object.keys(envelope).sort().join() !== "command,kind,version" ||
              envelope.version !== 1 ||
              !context.installerMaintenance
            )
              throw new Error("PEER_DENIED");
            const response = await context.installerMaintenance.execute(
              envelope.command,
              accepted.connection.peer,
              signal,
            );
            const bytes = Buffer.from(JSON.stringify(response));
            if (bytes.length > 4096) throw new Error("INVALID_COMMAND");
            await server.pipeReply(accepted.connection, bytes);
            await context.installerMaintenance.acknowledged(response);
            return;
          }
          releaseReply = authority.holdReply();
          if (
            Object.keys(envelope).sort().join() !==
              [
                "command",
                "kind",
                "version",
                ...(envelope.original_peer === undefined
                  ? []
                  : ["original_peer"]),
                ...(envelope.publication_peer === undefined
                  ? []
                  : ["publication_peer"]),
              ]
                .sort()
                .join() ||
            envelope.version !== 1 ||
            envelope.kind !== "browser-account"
          )
            throw new Error("INVALID_COMMAND");
          const command = parseBrowserAccountCommand(envelope.command);
          let peer = accepted.connection.peer;
          if (envelope.original_peer !== undefined) {
            if (command.action !== "wait") throw new Error("PEER_DENIED");
            const original = identity(envelope.original_peer);
            if (!(await context.native.sameParentProcess(peer, original)))
              throw new Error("PEER_DENIED");
            peer = original;
          }
          let publicationPeer: ConsumerProcessIdentity | undefined;
          if (envelope.publication_peer !== undefined) {
            if (
              command.action !== "playback_started" ||
              envelope.original_peer !== undefined
            )
              throw new Error("PEER_DENIED");
            publicationPeer = identity(envelope.publication_peer);
            if (
              !(await context.native.sameParentProcess(
                accepted.connection.peer,
                publicationPeer,
              ))
            )
              throw new Error("PEER_DENIED");
          }
          const reply = Buffer.from(
            JSON.stringify(
              command.action === "diagnostics"
                ? await authority.diagnostics(command, peer, signal)
                : await authority.execute(
                    command,
                    peer,
                    publicationPeer,
                    signal,
                  ),
            ),
          );
          if (reply.length > 32768) throw new Error("INVALID_COMMAND");
          await server.pipeReply(accepted.connection, reply);
        } catch {
          await server.pipeClose(accepted.connection).catch(() => {});
        } finally {
          await retire(server);
          handlers.delete(handler);
          releaseReply?.();
        }
      })();
      handlers.add(handler);
      // A handler may fail while the next listener is blocked accepting. Close
      // only this transport's exact helpers and preserve the cleanup error.
      void handler.catch((error) => {
        cleanupFailure ??= new BrowserAccountCleanupUnconfirmed(error);
        abort();
      });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    abort();
    await joinRetirement();
    if (context.kind === "store") {
      // A failed fresh listener does not own a ticket left by an older app
      // instance. Keep cleanup for any publication this invocation proved,
      // including a prior listener that retired before a later open failed.
      if (storeTicketPublished)
        await StoreAccountNative.prototype.removeTicket.call(
          context.native,
          authority.instanceId,
        );
    } else {
      const bytes = await context.native
        .vaultRead("account", "browser_ticket")
        .catch(() => null);
      if (bytes) {
        try {
          const ticket = parseBrowserAccountTicket(
            parseStrictJson(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              4096,
            ),
          );
          if (
            ticket.instance_id === authority.instanceId &&
            sameConsumerProcess(ticket.owner, owner)
          )
            await context.native.vaultDelete("account", "browser_ticket");
        } catch {
        } finally {
          bytes.fill(0);
        }
      }
    }
  }
}
function parseState(value: unknown): BrowserAccountState {
  const row = record(value),
    selection = record(row.selection);
  if (
    Object.keys(row).sort().join() !==
      [
        "instance_id",
        "job",
        "revision",
        "selection",
        "unchanged",
        "version",
        ...(row.publication === undefined ? [] : ["publication"]),
        ...(row.installation_check === undefined ? [] : ["installation_check"]),
      ]
        .sort()
        .join() ||
    row.version !== 1 ||
    typeof row.instance_id !== "string" ||
    !UUID.test(row.instance_id) ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    typeof row.unchanged !== "boolean" ||
    Object.keys(selection).sort().join() !==
      "cache_reuse_supported,cloud_ready,error_code,processing_provider,processing_scope,publication_supported" ||
    !["LOCAL_WINDOWS", "ONLINE_MUSICMUTE"].includes(
      String(selection.processing_provider),
    ) ||
    typeof selection.cloud_ready !== "boolean" ||
    typeof selection.cache_reuse_supported !== "boolean" ||
    typeof selection.publication_supported !== "boolean" ||
    (selection.processing_scope !== null &&
      (typeof selection.processing_scope !== "string" ||
        !/^[a-f0-9]{64}$/u.test(selection.processing_scope))) ||
    (selection.error_code !== null &&
      (typeof selection.error_code !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]{1,63}$/u.test(selection.error_code)))
  )
    throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
  if (row.installation_check !== undefined) {
    const check = record(row.installation_check);
    if (
      Object.keys(check).sort().join() !== "request_id,status" ||
      typeof check.request_id !== "string" ||
      !UUID.test(check.request_id) ||
      !isInstallationCheck(check.status)
    )
      throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
  }
  if (row.publication !== undefined) {
    const publication = record(row.publication);
    if (
      Object.keys(publication).sort().join() !== "job_id,state,video_id" ||
      typeof publication.job_id !== "string" ||
      !UUID.test(publication.job_id) ||
      typeof publication.video_id !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/u.test(publication.video_id) ||
      !["pending", "saving", "saved"].includes(String(publication.state))
    )
      throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
  }
  if (row.job !== null) {
    const job = record(row.job);
    if (
      typeof job.job_id !== "string" ||
      !UUID.test(job.job_id) ||
      typeof job.video_id !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/u.test(job.video_id) ||
      !["ONLINE_MUSICMUTE", "LOCAL_WINDOWS"].includes(String(job.provider)) ||
      ![
        "DOWNLOADING",
        "PROCESSING",
        "VALIDATING",
        "READY",
        "FAILED",
        "CANCELLED",
      ].includes(String(job.state)) ||
      typeof job.stage !== "string" ||
      job.stage.length > 80
    )
      throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
    if (
      Object.keys(job).some(
        (key) =>
          ![
            "job_id",
            "video_id",
            "provider",
            "state",
            "stage",
            "error_code",
            "media",
            "cache_hit",
            "save_state",
          ].includes(key),
      ) ||
      (job.cache_hit !== undefined && typeof job.cache_hit !== "boolean") ||
      (job.save_state !== undefined &&
        !["pending", "saving", "saved"].includes(String(job.save_state)))
    )
      throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
    if (
      job.error_code !== undefined &&
      (typeof job.error_code !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]{1,63}$/u.test(job.error_code))
    )
      throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
    if (job.media !== undefined) {
      const media = record(job.media),
        url = typeof media.url === "string" ? new URL(media.url) : null;
      if (
        Object.keys(media).sort().join() !==
          "duration_seconds,model_id,trim_enabled,url" ||
        !url ||
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password ||
        url.hash ||
        typeof media.duration_seconds !== "number" ||
        !Number.isFinite(media.duration_seconds) ||
        media.duration_seconds <= 0 ||
        media.duration_seconds > 1200 ||
        media.trim_enabled !== false ||
        typeof media.model_id !== "string" ||
        !/^[a-f0-9]{64}$/u.test(media.model_id)
      )
        throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
    }
  }
  return structuredClone(row) as unknown as BrowserAccountState;
}
export class BrowserAccountClient {
  readonly ownerId: string;
  private lastNonce: string | undefined;
  private events: Promise<BrowserAccountClient> | undefined;
  private closed = false;
  constructor(
    private readonly native: AccountNative,
    private readonly pin: ConsumerAccountAppPin | undefined,
    private readonly openEvents?: () => Promise<AccountNative>,
    ownerId: string = randomUUID(),
  ) {
    if (
      native instanceof StoreAccountNative
        ? pin !== undefined
        : pin === undefined
    )
      throw new Error("STORE_ACCOUNT_DENIED");
    this.ownerId = ownerId;
  }
  async healthy(): Promise<boolean> {
    try {
      const ticket = await this.ticket();
      return ticket !== null;
    } catch {
      return false;
    }
  }
  private async ticket(): Promise<AccountTicket | null> {
    if (this.native instanceof StoreAccountNative) {
      return StoreAccountNative.prototype.readTicket.call(this.native);
    }
    const bytes = await this.native.vaultRead("account", "browser_ticket");
    if (!bytes) return null;
    try {
      const ticket = parseBrowserAccountTicket(
          parseStrictJson(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            4096,
          ),
        ),
        own = await this.native.identity();
      if (
        ticket.owner.sid !== own.sid ||
        ticket.owner.sessionId !== own.sessionId ||
        !sameConsumerProcess(
          (await this.native.processIdentity(ticket.owner.pid)) ?? {
            ...own,
            pid: 0,
          },
          ticket.owner,
        ) ||
        !sameConsumerProcess(
          (await this.native.processIdentity(ticket.server.pid)) ?? {
            ...own,
            pid: 0,
          },
          ticket.server,
        ) ||
        !(await this.native.sameParentProcess(ticket.owner, ticket.server)) ||
        !(await this.native.verifyAccountPeer(
          ticket.owner,
          "authority",
          this.pin!,
        ))
      )
        throw new Error("PEER_DENIED");
      return ticket;
    } finally {
      bytes.fill(0);
    }
  }
  async connect(): Promise<BrowserAccountState> {
    if (!(await this.healthy())) {
      if (this.native instanceof StoreAccountNative)
        await StoreAccountNative.prototype.launchAccountAuthority.call(
          this.native,
        );
      else await this.native.launchAccountAuthority(this.pin!);
    }
    return this.command({ action: "selection" });
  }
  async command(
    input:
      | Omit<BrowserAccountCommand, "version" | "request_id" | "owner_id">
      | Record<string, unknown>,
    signal: AbortSignal = AbortSignal.timeout(35000),
  ): Promise<BrowserAccountState> {
    if (this.closed) throw new Error("OWNER_DETACHED");
    const command = parseBrowserAccountCommand({
      ...input,
      version: 1,
      request_id: randomUUID(),
      owner_id: this.ownerId,
    });
    if (command.action === "diagnostics") throw new Error("INVALID_COMMAND");
    return this.exchange(command, signal);
  }
  async diagnostics(
    requestId: string,
    signal: AbortSignal = AbortSignal.timeout(35000),
  ): Promise<ChromeDiagnosticExport> {
    if (this.closed) throw new Error("OWNER_DETACHED");
    const reply = await this.exchangeReply(
      parseBrowserAccountCommand({
        version: 1,
        request_id: requestId,
        owner_id: this.ownerId,
        action: "diagnostics",
      }),
      signal,
    );
    if (!("diagnostics" in reply))
      throw new Error("DIAGNOSTICS_REPORT_INVALID");
    return parseChromeDiagnosticExport(reply.diagnostics);
  }
  async start(
    videoId: string,
    duration: number,
    scope: string,
    requestId: string,
  ): Promise<BrowserAccountState> {
    return this.exchange(
      parseBrowserAccountCommand({
        version: 1,
        request_id: requestId,
        owner_id: this.ownerId,
        action: "start",
        video_id: videoId,
        duration_seconds: duration,
        processing_scope: scope,
      }),
      AbortSignal.timeout(35000),
    );
  }
  async wait(
    afterRevision: number,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<BrowserAccountState> {
    if (!this.openEvents) throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
    const events = await (this.events ??= this.openEvents().then(
      (native) =>
        new BrowserAccountClient(native, this.pin, undefined, this.ownerId),
    ));
    return events.exchange(
      parseBrowserAccountCommand({
        version: 1,
        request_id: randomUUID(),
        owner_id: this.ownerId,
        action: "wait",
        after_revision: afterRevision,
        instance_id: instanceId,
      }),
      signal ?? AbortSignal.timeout(35000),
      await this.native.identity(),
    );
  }
  async playbackStarted(
    jobId: string,
    videoId: string,
    personalPeer?: ConsumerProcessIdentity,
  ): Promise<BrowserAccountState> {
    return this.exchange(
      parseBrowserAccountCommand({
        version: 1,
        request_id: randomUUID(),
        owner_id: this.ownerId,
        action: "playback_started",
        job_id: jobId,
        video_id: videoId,
      }),
      AbortSignal.timeout(35000),
      undefined,
      personalPeer,
    );
  }
  private async exchange(
    command: BrowserAccountCommand,
    signal: AbortSignal,
    original?: ConsumerProcessIdentity,
    publicationPeer?: ConsumerProcessIdentity,
  ): Promise<BrowserAccountState> {
    const reply = await this.exchangeReply(
      command,
      signal,
      original,
      publicationPeer,
    );
    if (!("state" in reply)) throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
    return parseState(reply.state);
  }
  private async exchangeReply(
    command: BrowserAccountCommand,
    signal: AbortSignal,
    original?: ConsumerProcessIdentity,
    publicationPeer?: ConsumerProcessIdentity,
  ): Promise<
    Extract<BrowserAccountReply | BrowserDiagnosticReply, { ok: true }>
  > {
    for (let attempt = 0; attempt < 100; attempt++) {
      signal.throwIfAborted();
      let ticket: AccountTicket | null = null;
      try {
        ticket = await this.ticket();
      } catch {}
      if (!ticket || ticket.nonce === this.lastNonce) {
        await delay(100, undefined, { signal });
        continue;
      }
      this.lastNonce = ticket.nonce;
      if (!(await this.native.claimBrowserAccountTicket(ticket.nonce))) {
        await delay(100, undefined, { signal });
        continue;
      }
      const body = Buffer.from(
        JSON.stringify({
          version: 1,
          kind: "browser-account",
          command,
          ...(original ? { original_peer: original } : {}),
          ...(publicationPeer ? { publication_peer: publicationPeer } : {}),
        }),
      );
      if (body.length > 4096) throw new Error("INVALID_COMMAND");
      // No retry after connecting: a missing reply could follow an accepted paid intake.
      const bytes = await this.native.pipeConnect({
        channel: ticket.channel,
        nonce: ticket.nonce,
        peer: ticket.server,
        payload: body,
        timeoutMs: 30000,
      });
      if (bytes.length > 32768) throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
      const reply = record(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          32768,
        ),
      ) as unknown as BrowserAccountReply | BrowserDiagnosticReply;
      if (
        Object.keys(reply).sort().join() !==
          (reply.ok === true
            ? command.action === "diagnostics"
              ? "diagnostics,ok,request_id,version"
              : "ok,request_id,state,version"
            : "error_code,ok,request_id,version") ||
        reply.version !== 1 ||
        reply.request_id !== command.request_id ||
        typeof reply.ok !== "boolean"
      )
        throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
      if (!reply.ok) {
        if (
          typeof reply.error_code !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_]{1,63}$/u.test(reply.error_code)
        )
          throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
        throw new Error(reply.error_code);
      }
      return reply;
    }
    throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command({ action: "detach" });
    } finally {
      this.closed = true;
      await (await this.events?.catch(() => undefined))?.native.close();
    }
  }
}
