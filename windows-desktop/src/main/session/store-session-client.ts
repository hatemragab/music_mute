import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { HostContext } from "../host-context.js";
import {
  StoreNativeAuthority,
  StoreWorkerCodeAuthority,
} from "../browser/store-native.js";
import {
  parseStorePrepareLaunch,
  parseStorePrepareLaunchResult,
  parseStorePrepareEvent,
  parseStorePrepareCleanup,
  parseStoreSessionObservation,
  type StorePrepareLaunchRequest,
  type StorePrepareLaunch,
  type StorePrepareCleanup,
  type StoreSessionCommand,
  type StoreSessionObservation,
} from "../../shared/store-prepare-contracts.js";
import type { StorePreparationBinding } from "../prepare/store-model-ready.js";
import { PrepareFailure } from "../prepare/controller.js";
import { randomUUID } from "node:crypto";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  parseSessionCommand,
  type SessionCommand,
  type SessionSnapshot,
} from "../../shared/session-contracts.js";
import { parseSessionSnapshot } from "../../shared/session-snapshot.js";
import {
  storeGuiControlCommand,
  parseStoreControlEvent,
  type StoreControlCommand,
} from "../../shared/store-control-contracts.js";
import type { ConsumerProcessIdentity } from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  parsePersonalCommand,
  parsePersonalScope,
  type PersonalCommand,
} from "../../shared/personal-contracts.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { PersonalReply } from "../personal/session-port.js";
import {
  sameConsumerProcess,
  processIdentityFromWire,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  personalOwnerProofCommand,
  parsePersonalOwnerProof,
  type PersonalPlaybackOwnerRequest,
  type PersonalPlaybackOwnerProof,
} from "./personal-owner-proof.js";
import {
  StoreGuiCpuOperation,
  StoreGuiMediaExecution,
} from "./store-gui-media.js";
import {
  parseStoreMediaRequest,
  storeMediaNativeRequest,
  type StoreMediaLaunch,
} from "../../shared/store-media-request.js";
import type { StoreGuiCpuCommand } from "../../shared/store-gui-cpu-contracts.js";
import { isStoreSessionCleanupCommand } from "../../shared/store-session-cleanup.js";
import {
  parseStoreFleetOwnerObservation,
  parseStoreFleetPeerObservation,
} from "../../shared/store-fleet-control.js";
import type { ConsumerOwnedProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import { storeCpuFields } from "../../shared/store-cpu-operation.js";
import { StoreBenchmarkExecution } from "./store-benchmark-execution.js";
import {
  parseStoreBenchmarkRequest,
  type StoreBenchmarkRequest,
  type StoreBenchmarkRequestCommand,
  type StoreBenchmarkLaunchCommand,
} from "../../shared/store-benchmark-contracts.js";
import { parseStorePreparationBinding } from "../prepare/store-model-ready.js";

const TOKEN = Symbol("genuine-store-session-client");
function denied(): never {
  throw new Error("STORE_SESSION_CLIENT_DENIED");
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
/** A publication observation only; it never certifies a role, Job or Ready. */
export function parseStoreSessionPresence(value: unknown): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 1 ||
    Reflect.ownKeys(value)[0] !== "present"
  )
    denied();
  const property = Object.getOwnPropertyDescriptor(value, "present");
  if (
    !property?.enumerable ||
    !("value" in property) ||
    typeof property.value !== "boolean"
  )
    denied();
  return property.value;
}
interface WaitingPeer {
  authority: StoreNativeAuthority;
  code: StoreWorkerCodeAuthority;
  owner: WaitingOwner;
  close(): Promise<void>;
}
interface WaitingOwner {
  desktopScope?: StoreDesktopControlLifetime;
  cpuOperation?: StoreGuiCpuOperation;
  benchmarkExecution?: StoreBenchmarkExecution;
  authority?: StoreNativeAuthority;
  code?: StoreWorkerCodeAuthority;
  ready?: Promise<WaitingPeer>;
  factoryAttempted: boolean;
  sessionAttempted: boolean;
  retired: boolean;
  closePending?: Promise<void>;
  authorityClosePending?: Promise<void>;
  closeFailures: unknown[];
}
interface BrowserConstruction {
  authority?: StoreNativeAuthority;
  code?: StoreWorkerCodeAuthority;
  client?: StoreSessionClient;
  sessionAttempted: boolean;
  closing?: Promise<void>;
}
interface PreparationRun {
  request: StorePrepareLaunchRequest;
  launch?: StorePrepareLaunch;
  launchPending: Promise<StorePrepareLaunch>;
  cleanupPending?: Promise<StorePrepareCleanup>;
  cleanupFailure?: unknown;
  closed: boolean;
  waiting?: WaitingPeer;
}
interface ControlRun {
  desktopScope?: StoreDesktopControlLifetime;
  dispatched: boolean;
  command: StoreControlCommand;
  peer?: WaitingPeer;
  pending?: Promise<Buffer>;
}
/** Production factory only: original genuine GUI/code owner, independently
 * admitted native Session, and separate genuine GUI helper for blocking events.
 * Public JSON, interfaces and OS activation ACKs cannot construct this class. */
export class StoreSessionClient {
  static #browserConstructions = new Set<BrowserConstruction>();
  static #browserClients = new Set<StoreSessionClient>();
  #browserSource: StoreNativeAuthority | undefined;
  #sessionClosed = false;
  #closeRecovering: Promise<void> | undefined;
  #closeFailures: Promise<void>[] = [];
  #host: HostContext;
  #authority: StoreNativeAuthority;
  #code: StoreWorkerCodeAuthority;
  #binding: StorePreparationBinding;
  #observation: StoreSessionObservation;
  #runs = new Map<string, PreparationRun>();
  #ending = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #oldCleanup: Promise<StorePrepareCleanup>[] = [];
  #waitingOwners = new Set<WaitingOwner>();
  #recovering: Promise<void> | undefined;
  #controls = new Map<string, ControlRun>();
  #desktopScopes = new Set<StoreDesktopControlLifetime>();
  #desktopContext = new AsyncLocalStorage<StoreDesktopControlLifetime>();
  #guiCpu = new Map<StoreGuiCpuOperation, StoreGuiMediaExecution>();
  #guiCpuWaiters = new Map<StoreGuiCpuOperation, Promise<WaitingPeer>>();
  #benchmarks = new Set<StoreBenchmarkExecution>();
  #benchmarkWaiters = new Map<StoreBenchmarkExecution, Promise<WaitingPeer>>();
  private constructor(
    token: symbol,
    host: HostContext,
    authority: StoreNativeAuthority,
    code: StoreWorkerCodeAuthority,
    binding: StorePreparationBinding,
    observation: StoreSessionObservation,
  ) {
    if (token !== TOKEN) denied();
    this.#host = host;
    this.#authority = authority;
    this.#code = code;
    this.#binding = binding;
    this.#observation = observation;
    Object.freeze(this);
  }
  static async openBrowser(
    source: StoreNativeAuthority,
  ): Promise<StoreSessionClient> {
    if (
      arguments.length !== 1 ||
      process.platform !== "win32" ||
      process.arch !== "x64"
    )
      denied();
    // Real private source/attachment fields are checked before any helper IO.
    const original =
      StoreNativeAuthority.prototype.browserSourceCreatorProof.call(source);
    StoreNativeAuthority.prototype.browserCreatorProof.call(source);
    const actualSource =
      StoreNativeAuthority.prototype.creatorProof.call(source);
    if (
      !sameConsumerProcess(original.helper, actualSource.helper) ||
      !sameConsumerProcess(original.gui, actualSource.gui) ||
      original.packageFullName !== actualSource.packageFullName
    )
      denied();
    const owner: BrowserConstruction = { sessionAttempted: false };
    this.#browserConstructions.add(owner);
    try {
      owner.authority =
        await StoreNativeAuthority.openBrowserWaitingPeer(source);
      const current =
        StoreNativeAuthority.prototype.browserSourceCreatorProof.call(
          owner.authority,
        );
      if (
        !sameConsumerProcess(current.helper, original.helper) ||
        !sameConsumerProcess(current.gui, original.gui) ||
        current.packageFullName !== original.packageFullName
      )
        denied();
      const host = await HostContext.initialize(
        StoreNativeAuthority.prototype.borrowDataNative.call(owner.authority),
        "0.1.0",
        1,
      );
      owner.code = await StoreNativeAuthority.prototype.openWorkerCode.call(
        owner.authority,
      );
      owner.sessionAttempted = true;
      owner.client = await StoreSessionClient.open(host, owner.code);
      owner.client.#browserSource = source;
      owner.client.personalPeer();
      this.#browserClients.add(owner.client);
      this.#browserConstructions.delete(owner);
      return owner.client;
    } catch (error) {
      owner.closing ??= (async () => {
        if (owner.client)
          await StoreSessionClient.prototype.close.call(owner.client);
        else {
          if (owner.sessionAttempted && owner.authority && owner.code)
            await StoreNativeAuthority.prototype.storeSessionOperation.call(
              owner.authority,
              owner.code,
              "store_session_close",
              {},
            );
          if (owner.code)
            await StoreWorkerCodeAuthority.prototype.close.call(owner.code);
          if (owner.authority)
            await StoreNativeAuthority.prototype.close.call(owner.authority);
        }
        this.#browserConstructions.delete(owner);
      })();
      try {
        await owner.closing;
      } catch {
        throw new Error("CHILD_SHUTDOWN_PENDING", { cause: error });
      }
      throw error;
    }
  }
  static async tryOpen(
    host: HostContext,
    code: StoreWorkerCodeAuthority,
  ): Promise<StoreSessionClient | undefined> {
    if (
      arguments.length !== 2 ||
      process.platform !== "win32" ||
      process.arch !== "x64"
    )
      denied();
    const authority = host.storeAuthority;
    if (!authority) denied();
    StoreWorkerCodeAuthority.prototype.assertDataNative.call(code, host.native);
    await StoreWorkerCodeAuthority.prototype.revalidate.call(code);
    const present = parseStoreSessionPresence(
      await StoreNativeAuthority.prototype.storeSessionOperation.call(
        authority,
        code,
        "store_session_presence",
        {},
      ),
    );
    await StoreWorkerCodeAuthority.prototype.revalidate.call(code);
    if (!present) return undefined;
    // A racing or failed genuine bind is retained by the original native/code
    // owner and propagates; it can never be reinterpreted as absence.
    return StoreSessionClient.open(host, code, { launchIfAbsent: false });
  }
  static async open(
    host: HostContext,
    code: StoreWorkerCodeAuthority,
    options: { launchIfAbsent?: boolean } = {},
  ): Promise<StoreSessionClient> {
    if (
      arguments.length < 2 ||
      arguments.length > 3 ||
      process.platform !== "win32" ||
      process.arch !== "x64" ||
      !options ||
      Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some((k) => k !== "launchIfAbsent") ||
      (options.launchIfAbsent !== undefined &&
        typeof options.launchIfAbsent !== "boolean")
    )
      denied();
    const authority = host.storeAuthority;
    if (!authority) denied();
    StoreWorkerCodeAuthority.prototype.assertDataNative.call(code, host.native);
    await StoreWorkerCodeAuthority.prototype.revalidate.call(code);
    const binding =
      await StoreWorkerCodeAuthority.prototype.preparationBinding.call(code);
    if (options.launchIfAbsent !== false)
      await StoreWorkerCodeAuthority.prototype.activateSession.call(code);
    const raw = await StoreNativeAuthority.prototype.storeSessionOperation.call(
        authority,
        code,
        "store_session_open",
        {},
      ),
      observation = parseStoreSessionObservation(
        bytes(raw),
        binding,
        host.identity.sessionId,
      );
    await StoreWorkerCodeAuthority.prototype.revalidate.call(code);
    return new StoreSessionClient(
      TOKEN,
      host,
      authority,
      code,
      binding,
      observation,
    );
  }
  assertCodeAuthority(code: StoreWorkerCodeAuthority): void {
    if (arguments.length !== 1 || this.#closed || code !== this.#code) denied();
    StoreWorkerCodeAuthority.prototype.assertDataNative.call(
      code,
      this.#host.native,
    );
    if (this.#browserSource) {
      const source =
          StoreNativeAuthority.prototype.browserSourceCreatorProof.call(
            this.#browserSource,
          ),
        current = StoreNativeAuthority.prototype.browserSourceCreatorProof.call(
          this.#authority,
        );
      if (
        !sameConsumerProcess(source.helper, current.helper) ||
        !sameConsumerProcess(source.gui, current.gui) ||
        source.packageFullName !== current.packageFullName
      )
        denied();
    }
  }
  get observation(): StoreSessionObservation {
    if (this.#closed) denied();
    return this.#observation;
  }
  currentAuthority(): ConsumerProcessIdentity | undefined {
    if (arguments.length !== 0 || this.#closed) denied();
    this.assertCodeAuthority(this.#code);
    return structuredClone(this.#observation.owner.identity);
  }
  openDesktopLifetime(): StoreDesktopControlLifetime {
    if (
      arguments.length ||
      this.#ending ||
      this.#closed ||
      this.#recovering ||
      this.#browserSource
    )
      denied();
    this.assertCodeAuthority(this.#code);
    const scope = new StoreDesktopControlLifetime(TOKEN, this);
    this.#desktopScopes.add(scope);
    return scope;
  }
  /** Closed actual-class dispatch only. Caller callbacks/transport/IDs cannot
   * insert a lifetime or select another scope's control owners. */
  async performDesktop(
    scope: StoreDesktopControlLifetime,
    operation: "command" | "personal" | "proof",
    input: unknown,
    signal: AbortSignal,
    accountScope?: SessionAccountScope | null,
  ): Promise<SessionSnapshot | PersonalReply | PersonalPlaybackOwnerProof> {
    if (
      arguments.length < 4 ||
      arguments.length > 5 ||
      !this.#desktopScopes.has(scope) ||
      this.#ending ||
      this.#closed ||
      !(signal instanceof AbortSignal)
    )
      denied();
    scope.assertActive(this);
    return this.#desktopContext.run(scope, () => {
      if (operation === "command" && accountScope === undefined)
        return StoreSessionClient.prototype.command.call(
          this,
          input as SessionCommand,
          signal,
        );
      if (operation === "proof" && accountScope === undefined)
        return StoreSessionClient.prototype.provePersonalOwner.call(
          this,
          input as PersonalPlaybackOwnerRequest,
          signal,
        );
      if (operation !== "personal") denied();
      return StoreSessionClient.prototype.personal.call(
        this,
        input as PersonalCommand,
        "desktop",
        accountScope,
        signal,
      );
    });
  }
  async retireDesktop(scope: StoreDesktopControlLifetime): Promise<void> {
    if (
      arguments.length !== 1 ||
      !this.#desktopScopes.has(scope) ||
      this.#closed
    )
      denied();
    scope.assertClosing(this);
    return this.#desktopContext.run(scope, async () => {
      for (const run of this.#controls.values()) {
        if (run.desktopScope !== scope) continue;
        await run.pending?.catch(() => {});
        if (!this.#controls.has(run.command.requestId)) continue;
        if (run.dispatched) {
          if (!run.peer || run.peer.owner.retired)
            throw new Error("CHILD_SHUTDOWN_PENDING");
          // The original genuine helper alone recovers the original ID/payload.
          // True peer/code/Creator loss retains business uncertainty.
          await this.#forward(run, AbortSignal.timeout(70000), true);
        }
      }
      const owners = [...this.#waitingOwners].filter(
        (owner) => owner.desktopScope === scope,
      );
      const results = await Promise.allSettled(
        owners.map((owner) => this.#recoverWaiting(owner)),
      );
      const failure = results.find((row) => row.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      for (const run of this.#controls.values()) {
        if (run.desktopScope === scope && !run.dispatched)
          this.#controls.delete(run.command.requestId);
      }
      if (
        [...this.#controls.values()].some(
          (run) => run.desktopScope === scope,
        ) ||
        owners.some((owner) => !owner.retired)
      )
        throw new Error("CHILD_SHUTDOWN_PENDING");
      this.#desktopScopes.delete(scope);
    });
  }
  async exchange(
    payload: Uint8Array,
    signal: AbortSignal = AbortSignal.timeout(70000),
  ): Promise<Buffer> {
    if (
      arguments.length < 1 ||
      arguments.length > 2 ||
      this.#closed ||
      this.#ending ||
      this.#recovering ||
      !(signal instanceof AbortSignal) ||
      this.#controls.size >= 16
    )
      denied();
    signal.throwIfAborted();
    const command = storeGuiControlCommand(payload, randomUUID()),
      desktopScope = this.#desktopContext.getStore(),
      run: ControlRun = {
        command,
        dispatched: false,
        ...(desktopScope ? { desktopScope } : {}),
      };
    if (desktopScope && !this.#desktopScopes.has(desktopScope)) denied();
    this.#controls.set(command.requestId, run);
    // Retain the exact request before the first actual helper/Creator write.
    // Lost ACKs recover this original ID/payload; they cannot resubmit work.
    run.pending = this.#forward(run, signal);
    return run.pending;
  }
  async #forward(
    run: ControlRun,
    signal: AbortSignal,
    recovery = false,
  ): Promise<Buffer> {
    const peer = (run.peer ??= await this.#waitingPeer(recovery));
    for (;;) {
      signal.throwIfAborted();
      run.dispatched = true;
      const result = parseStoreControlEvent(
        await this.#command(run.command, peer),
        run.command.requestId,
      );
      signal.throwIfAborted();
      if (result === null) continue; // Renew an actual event wait, never a status read.
      const ack = await this.#command(
        {
          version: 1,
          requestId: run.command.requestId,
          action: "session_forward_ack",
        },
        peer,
      );
      if (
        !ack ||
        typeof ack !== "object" ||
        Array.isArray(ack) ||
        Object.keys(ack).join() !== "acknowledged" ||
        (ack as { acknowledged?: unknown }).acknowledged !== true
      )
        denied();
      this.#controls.delete(run.command.requestId);
      await peer.close();
      return result;
    }
  }
  async command(
    command: SessionCommand,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    const payload = Buffer.from(JSON.stringify(command));
    parseSessionCommand(payload);
    const reply = parseStrictJson(
      new TextDecoder("utf8", { fatal: true }).decode(
        await this.exchange(payload, signal),
      ),
      32768,
    ) as Record<string, unknown>;
    if (
      !reply ||
      typeof reply !== "object" ||
      Array.isArray(reply) ||
      reply.version !== 1 ||
      reply.request_id !== command.request_id ||
      typeof reply.ok !== "boolean"
    )
      denied();
    if (reply.ok !== true) {
      if (Object.keys(reply).sort().join() !== "error,ok,request_id,version")
        denied();
      const error = reply.error as Record<string, unknown>;
      if (
        !error ||
        typeof error !== "object" ||
        Object.keys(error).join() !== "code" ||
        typeof error.code !== "string" ||
        ![
          "INVALID_COMMAND",
          "REQUEST_ID_REUSED",
          "PEER_DENIED",
          "SESSION_UNAVAILABLE",
          "STATE_UNAVAILABLE",
          "CHILD_SHUTDOWN_PENDING",
          "FORCE_CONFIRMATION_STALE",
          "UPDATE_BUSY",
        ].includes(error.code)
      )
        denied();
      throw new Error(error.code);
    }
    if (Object.keys(reply).sort().join() !== "ok,request_id,snapshot,version")
      denied();
    const snapshot = parseSessionSnapshot(reply.snapshot);
    if (snapshot.release !== this.#binding.inventorySha256) denied();
    return snapshot;
  }
  /** The actual GUI parent is supplied by the Creator. A fresh waiter helper
   * cannot select original_peer, impersonate Chrome or borrow another owner. */
  personalPeer(): ConsumerProcessIdentity {
    if (arguments.length || this.#ending || this.#closed) denied();
    this.assertCodeAuthority(this.#code);
    if (this.#browserSource) {
      const original =
          StoreNativeAuthority.prototype.browserSourceCreatorProof.call(
            this.#browserSource,
          ),
        current = StoreNativeAuthority.prototype.browserSourceCreatorProof.call(
          this.#authority,
        );
      if (
        !sameConsumerProcess(original.helper, current.helper) ||
        !sameConsumerProcess(original.gui, current.gui) ||
        original.packageFullName !== current.packageFullName
      )
        denied();
      StoreNativeAuthority.prototype.browserCreatorProof.call(this.#authority);
      return original.helper;
    }
    return StoreNativeAuthority.prototype.creatorProof.call(this.#authority)
      .gui;
  }
  async provePersonalOwner(
    request: PersonalPlaybackOwnerRequest,
    signal?: AbortSignal,
  ): Promise<PersonalPlaybackOwnerProof> {
    if (
      arguments.length < 1 ||
      arguments.length > 2 ||
      this.#ending ||
      this.#closed ||
      request.ownerKind !== (this.#browserSource ? "chrome" : "desktop") ||
      !sameConsumerProcess(request.peer, this.personalPeer())
    )
      denied();
    const expected = {
        ...request,
        ownerKind: (this.#browserSource ? "chrome" : "desktop") as
          "chrome" | "desktop",
        peer: this.personalPeer(),
      },
      command = personalOwnerProofCommand(expected);
    const reply = parseStrictJson(
      new TextDecoder("utf8", { fatal: true }).decode(
        await this.exchange(Buffer.from(JSON.stringify(command)), signal),
      ),
      32768,
    ) as Record<string, unknown>;
    if (
      !reply ||
      typeof reply !== "object" ||
      Array.isArray(reply) ||
      Object.keys(reply).sort().join() !== "ok,proof,request_id,version" ||
      reply.version !== 1 ||
      reply.request_id !== command.request_id ||
      reply.ok !== true
    )
      denied();
    if (!sameConsumerProcess(expected.peer, this.personalPeer())) denied();
    return parsePersonalOwnerProof(reply.proof, expected);
  }
  async personal(
    command: PersonalCommand,
    ownerKind: "desktop" | "chrome" = this.#browserSource
      ? "chrome"
      : "desktop",
    capturedScope?: SessionAccountScope | null,
    signal?: AbortSignal,
  ): Promise<PersonalReply> {
    if (
      arguments.length < 1 ||
      arguments.length > 4 ||
      ownerKind !== (this.#browserSource ? "chrome" : "desktop")
    )
      denied();
    parsePersonalCommand(Buffer.from(JSON.stringify(command)));
    if (capturedScope !== undefined && command.action !== "submit") denied();
    if (this.#browserSource && capturedScope != null) denied();
    const scope =
      command.action === "submit"
        ? parsePersonalScope(capturedScope ?? null)
        : undefined;
    const value = parseStrictJson(
      new TextDecoder("utf8", { fatal: true }).decode(
        await this.exchange(
          Buffer.from(
            JSON.stringify({
              version: 1,
              kind: "personal-command",
              owner_kind: ownerKind,
              command,
              ...(scope !== undefined
                ? {
                    submission_authority: scope
                      ? { kind: "account", scope }
                      : { kind: "guest" },
                  }
                : {}),
            }),
          ),
          signal,
        ),
      ),
      32768,
    ) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1 ||
      value.requestId !== command.requestId ||
      typeof value.ok !== "boolean" ||
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "requestId",
            "ok",
            "jobs",
            "job",
            "error",
            "changeVersion",
            "instanceId",
            "unchanged",
          ].includes(key),
      ) ||
      (!value.ok &&
        (typeof value.error !== "string" ||
          Object.keys(value).sort().join() !== "error,ok,requestId,version"))
    )
      denied();
    return value as unknown as PersonalReply;
  }
  waitState(
    afterRevision: number,
    instanceId?: string,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    return this.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "wait_state",
        after_revision: afterRevision,
        ...(instanceId === undefined ? {} : { instance_id: instanceId }),
      },
      signal,
    );
  }
  async #command(
    command:
      | StoreSessionCommand
      | StoreGuiCpuCommand
      | StoreBenchmarkRequestCommand
      | StoreBenchmarkLaunchCommand
      | {
          version: 1;
          requestId: string;
          action: "fleet_owner";
        }
      | {
          version: 1;
          requestId: string;
          action: "fleet_peer";
          owner: ConsumerOwnedProcess;
          identity: ConsumerProcessIdentity;
        },
    peer?: WaitingPeer,
  ) {
    if (this.#closed) denied();
    this.assertCodeAuthority(this.#code);
    const authority = peer?.authority ?? this.#authority,
      code = peer?.code ?? this.#code;
    const revalidate = isStoreSessionCleanupCommand(command)
      ? StoreWorkerCodeAuthority.prototype.revalidateCleanup
      : StoreWorkerCodeAuthority.prototype.revalidate;
    await revalidate.call(code);
    const result =
      await StoreNativeAuthority.prototype.storeSessionOperation.call(
        authority,
        code,
        "store_session_command",
        {
          command:
            command.action === "cpu_launch" || command.action === "cpu_recover"
              ? {
                  ...command,
                  request: storeMediaNativeRequest(command.request),
                }
              : command.action === "benchmark_launch" ||
                  command.action === "benchmark_recover"
                ? {
                    ...command,
                    request: {
                      version: 1,
                      requestId: command.request.requestId,
                      operation: command.request.operation,
                      binding: command.request.binding,
                      configuration_json: JSON.stringify(
                        command.request.configuration,
                      ),
                    },
                  }
                : command,
        },
      );
    await revalidate.call(code);
    return result;
  }
  assertMediaHost(host: HostContext): void {
    if (
      arguments.length !== 1 ||
      host !== this.#host ||
      this.#browserSource ||
      this.#closed ||
      this.#sessionClosed
    )
      denied();
    this.assertCodeAuthority(this.#code);
  }
  assertBenchmarkHost(host: HostContext): void {
    if (arguments.length !== 1) denied();
    this.assertMediaHost(host);
  }
  async benchmarkCodeView(): Promise<
    Readonly<{
      binding: StorePreparationBinding;
      helperSha256: string;
      engineDigest: string;
    }>
  > {
    if (arguments.length || this.#closed || this.#ending) denied();
    StoreSessionClient.prototype.assertBenchmarkHost.call(this, this.#host);
    const actual =
      await StoreWorkerCodeAuthority.prototype.benchmarkCodeView.call(
        this.#code,
      );
    if (
      this.#closed ||
      this.#ending ||
      actual.inventorySha256 !== this.#binding.inventorySha256 ||
      actual.runtimeManifestSha256 !== this.#binding.runtimeManifestSha256
    )
      denied();
    StoreSessionClient.prototype.assertCodeAuthority.call(this, this.#code);
    return Object.freeze({
      binding: this.#binding,
      helperSha256: actual.helperSha256,
      engineDigest: actual.engineDigest,
    });
  }
  async openBenchmark(
    input: StoreBenchmarkRequest,
  ): Promise<StoreBenchmarkExecution> {
    if (
      arguments.length !== 1 ||
      this.#ending ||
      this.#closed ||
      this.#recovering
    )
      denied();
    this.assertBenchmarkHost(this.#host);
    const request = storeCpuFields(input, [
        "version",
        "requestId",
        "operation",
        "binding",
        "configuration",
      ]),
      optional = ["groupSize", "candidate", "saveAudio"].filter((key) =>
        Object.hasOwn(request.configuration as object, key),
      ),
      config = storeCpuFields(request.configuration, [
        "bootIdentity",
        "version",
        "operation",
        "requestId",
        "release",
        "sid",
        "manifestSha256",
        "helperSha256",
        "gpu",
        "fixture",
        "recipe",
        "warmupRuns",
        "measuredRuns",
        ...optional,
      ]);
    const binding = parseStorePreparationBinding(request.binding);
    config.gpu = storeCpuFields(config.gpu, [
      "source",
      "deviceIndex",
      "name",
      "vendorId",
      "deviceId",
      "subsystemId",
      "revision",
      "driverVersion",
      "luid",
      "dedicatedVideoMemoryBytes",
      "sharedSystemMemoryLimitBytes",
    ]);
    config.fixture = storeCpuFields(config.fixture, [
      "bytes",
      "relativePath",
      "sha256",
    ]);
    if (optional.includes("candidate"))
      config.candidate = storeCpuFields(config.candidate, [
        "release",
        "manifestSha256",
        "engineDigest",
      ]);
    for (const [key, value] of Object.entries(config)) {
      if (["gpu", "fixture", "candidate"].includes(key)) {
        if (
          Object.values(value as Record<string, unknown>).some(
            (item) => !["string", "number"].includes(typeof item),
          )
        )
          denied();
      } else if (!["string", "number", "boolean"].includes(typeof value))
        denied();
    }
    if (
      request.version !== 1 ||
      typeof request.requestId !== "string" ||
      typeof request.operation !== "string"
    )
      denied();
    const parsed = parseStoreBenchmarkRequest(
      bytes({ ...request, binding, configuration: config }),
    );
    if (!isDeepStrictEqual(parsed.binding, this.#binding)) denied();
    await StoreWorkerCodeAuthority.prototype.revalidate.call(this.#code);
    if (this.#ending || this.#closed || this.#recovering) denied();
    for (const original of this.#benchmarks)
      if (
        StoreBenchmarkExecution.prototype.closedForSession.call(original, this)
      ) {
        this.#benchmarks.delete(original);
        this.#benchmarkWaiters.delete(original);
      }
    if (this.#benchmarks.size >= 16) denied();
    const execution = StoreBenchmarkExecution.create(this, this.#host, parsed);
    this.#benchmarks.add(execution);
    return execution;
  }
  async benchmarkOperationCommand(
    execution: StoreBenchmarkExecution,
    action:
      | StoreBenchmarkRequestCommand["action"]
      | StoreBenchmarkLaunchCommand["action"],
  ): Promise<unknown> {
    if (
      arguments.length !== 2 ||
      !this.#benchmarks.has(execution) ||
      this.#closed ||
      ![
        "benchmark_launch",
        "benchmark_recover",
        "benchmark_wait",
        "benchmark_cancel",
      ].includes(action)
    )
      denied();
    const request = StoreBenchmarkExecution.prototype.requestForSession.call(
      execution,
      this,
    );
    this.assertBenchmarkHost(this.#host);
    if (
      action !== "benchmark_recover" &&
      action !== "benchmark_cancel" &&
      (this.#ending || this.#recovering)
    )
      denied();
    let command: StoreBenchmarkRequestCommand | StoreBenchmarkLaunchCommand;
    if (action === "benchmark_launch" || action === "benchmark_recover")
      command = { version: 1, requestId: request.requestId, action, request };
    else {
      const launch = StoreBenchmarkExecution.prototype.launchForSession.call(
        execution,
        this,
      );
      if (!launch) denied();
      command = { version: 1, requestId: request.requestId, action, launch };
    }
    let peer: WaitingPeer | undefined;
    if (action === "benchmark_wait") {
      let pending = this.#benchmarkWaiters.get(execution);
      if (!pending) {
        pending = this.#waitingPeer(false, undefined, execution);
        this.#benchmarkWaiters.set(execution, pending);
        void pending.catch(() => {});
      }
      peer = await pending;
    }
    const response = await this.#command(command, peer);
    if (
      action !== "benchmark_wait" ||
      !response ||
      typeof response !== "object" ||
      (response as { state?: unknown }).state !== "completed"
    )
      return response;
    const row = storeCpuFields(response, [
      "version",
      "requestId",
      "owner",
      "inventorySha256",
      "state",
      "result_json",
    ]);
    if (
      typeof row.result_json !== "string" ||
      Buffer.byteLength(row.result_json) > 4096
    )
      denied();
    const result = parseStrictJson(row.result_json, 4096, 64),
      { result_json: unused, ...event } = row;
    void unused;
    return { ...event, result };
  }
  async retireBenchmarkWaiter(
    execution: StoreBenchmarkExecution,
  ): Promise<void> {
    if (
      arguments.length !== 1 ||
      !this.#benchmarks.has(execution) ||
      this.#closed
    )
      denied();
    await this.#benchmarkWaiters.get(execution)?.catch(() => {});
    const retired = await Promise.allSettled(
      [...this.#waitingOwners]
        .filter((owner) => owner.benchmarkExecution === execution)
        .map((owner) => this.#recoverWaiting(owner)),
    );
    const failure = retired.find((row) => row.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    this.#benchmarkWaiters.delete(execution);
  }
  async currentFleetOwner(): Promise<ConsumerOwnedProcess | null> {
    if (
      arguments.length !== 0 ||
      this.#browserSource ||
      this.#ending ||
      this.#closed
    )
      denied();
    const observed = parseStoreFleetOwnerObservation(
      bytes(
        await this.#command({
          version: 1,
          requestId: randomUUID(),
          action: "fleet_owner",
        }),
      ),
      this.#binding.inventorySha256,
    );
    if (
      observed.owner &&
      (observed.owner.identity.sid !== this.#host.identity.sid ||
        observed.owner.identity.sessionId !== this.#host.identity.sessionId)
    )
      denied();
    return observed.owner;
  }
  async inspectFleetPeer(
    owner: ConsumerOwnedProcess,
    peer: ConsumerProcessIdentity,
  ): Promise<boolean> {
    if (
      arguments.length !== 2 ||
      this.#browserSource ||
      this.#ending ||
      this.#closed
    )
      denied();
    const captured = storeCpuFields(owner, ["role", "nonce", "identity"]);
    captured.identity = storeCpuFields(captured.identity, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]);
    const original = parseStoreFleetOwnerObservation(
      bytes({
        version: 1,
        inventorySha256: this.#binding.inventorySha256,
        owner: captured,
      }),
      this.#binding.inventorySha256,
    ).owner;
    if (
      !original ||
      original.identity.sid !== this.#host.identity.sid ||
      original.identity.sessionId !== this.#host.identity.sessionId
    )
      denied();
    const capturedPeer = storeCpuFields(peer, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]);
    const identity = processIdentityFromWire({
      sid: capturedPeer.sid,
      session_id: capturedPeer.sessionId,
      pid: capturedPeer.pid,
      creation_time: capturedPeer.creationTime,
    });
    if (
      identity.sid !== original.identity.sid ||
      identity.sessionId !== original.identity.sessionId
    )
      denied();
    return parseStoreFleetPeerObservation(
      bytes(
        await this.#command({
          version: 1,
          requestId: randomUUID(),
          action: "fleet_peer",
          owner: original,
          identity,
        }),
      ),
    );
  }
  async openMedia(configuration: unknown): Promise<StoreGuiMediaExecution> {
    if (
      arguments.length !== 1 ||
      this.#ending ||
      this.#closed ||
      this.#recovering ||
      !configuration ||
      typeof configuration !== "object" ||
      Object.getPrototypeOf(configuration) !== Object.prototype ||
      Reflect.ownKeys(configuration).some((key) => typeof key !== "string") ||
      Object.values(Object.getOwnPropertyDescriptors(configuration)).some(
        (property) => !property.enumerable || !("value" in property),
      )
    )
      denied();
    this.assertMediaHost(this.#host);
    const requestId = Object.getOwnPropertyDescriptor(
      configuration,
      "requestId",
    )?.value;
    const request = parseStoreMediaRequest(
      bytes({ version: 1, requestId, binding: this.#binding, configuration }),
    );
    await StoreWorkerCodeAuthority.prototype.revalidate.call(this.#code);
    if (this.#ending || this.#closed || this.#recovering) denied();
    for (const [operation] of this.#guiCpu) {
      if (
        StoreGuiCpuOperation.prototype.closedForSession.call(operation, this)
      ) {
        this.#guiCpu.delete(operation);
        this.#guiCpuWaiters.delete(operation);
      }
    }
    if (this.#guiCpu.size >= 16) denied();
    const execution = StoreGuiMediaExecution.create(this.#host, this, request);
    this.#guiCpu.set(
      StoreGuiMediaExecution.prototype.operation.call(execution),
      execution,
    );
    return execution;
  }
  async mediaOperationCommand(
    operation: StoreGuiCpuOperation,
    action: StoreGuiCpuCommand["action"],
    launch?: StoreMediaLaunch,
  ): Promise<unknown> {
    if (
      (arguments.length !== 2 && arguments.length !== 3) ||
      !this.#guiCpu.has(operation) ||
      this.#closed ||
      ![
        "cpu_launch",
        "cpu_recover",
        "cpu_ready",
        "cpu_start",
        "cpu_wait",
        "cpu_cancel",
      ].includes(action)
    )
      denied();
    const request = StoreGuiCpuOperation.prototype.requestForSession.call(
      operation,
      this,
    );
    this.assertMediaHost(this.#host);
    if (
      action !== "cpu_recover" &&
      action !== "cpu_cancel" &&
      (this.#ending || this.#recovering)
    )
      denied();
    let command: StoreGuiCpuCommand;
    if (action === "cpu_launch" || action === "cpu_recover") {
      if (launch !== undefined) denied();
      command = { version: 1, requestId: request.requestId, action, request };
    } else {
      if (
        !launch ||
        launch !==
          StoreGuiCpuOperation.prototype.launchForSession.call(operation, this)
      )
        denied();
      command = { version: 1, requestId: request.requestId, action, launch };
    }
    let peer: WaitingPeer | undefined;
    if (action === "cpu_ready" || action === "cpu_wait") {
      let pending = this.#guiCpuWaiters.get(operation);
      if (!pending) {
        pending = this.#waitingPeer(false, operation);
        this.#guiCpuWaiters.set(operation, pending);
        void pending.catch(() => {});
      }
      peer = await pending;
    }
    return this.#command(command, peer);
  }
  async retireMediaWaiter(operation: StoreGuiCpuOperation): Promise<void> {
    if (arguments.length !== 1 || !this.#guiCpu.has(operation) || this.#closed)
      denied();
    StoreGuiCpuOperation.prototype.requestForSession.call(operation, this);
    await this.#guiCpuWaiters.get(operation)?.catch(() => {});
    const results = await Promise.allSettled(
      [...this.#waitingOwners]
        .filter((owner) => owner.cpuOperation === operation)
        .map((owner) => this.#recoverWaiting(owner)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    this.#guiCpuWaiters.delete(operation);
  }
  async launchPrepare(
    input: StorePrepareLaunchRequest,
  ): Promise<StorePrepareLaunch> {
    if (
      arguments.length !== 1 ||
      this.#closed ||
      this.#ending ||
      this.#recovering ||
      this.#runs.size >= 16 ||
      [...this.#runs.values()].some((run) => !run.closed)
    )
      denied();
    const request = parseStorePrepareLaunch(bytes(input));
    const current =
      await StoreWorkerCodeAuthority.prototype.preparationBinding.call(
        this.#code,
      );
    if (
      JSON.stringify(request.binding) !== JSON.stringify(this.#binding) ||
      JSON.stringify(current) !== JSON.stringify(this.#binding) ||
      this.#runs.has(request.requestId)
    )
      denied();
    const pending = this.#command({
      version: 1,
      requestId: request.requestId,
      action: "prepare_launch",
      request,
    }).then((raw) => parseStorePrepareLaunchResult(bytes(raw), request));
    const run: PreparationRun = {
      request,
      launchPending: pending,
      closed: false,
    };
    this.#runs.set(request.requestId, run);
    // Retain the pending request after an uncertain launch acknowledgement. The
    // class never marks that state clean or drops its genuine cleanup owner.
    run.launch = await pending;
    return run.launch;
  }
  #run(launch: StorePrepareLaunch): PreparationRun {
    const run = this.#runs.get(launch.requestId);
    if (!run || run.launch !== launch || this.#closed) denied();
    return run;
  }
  async #waitingPeer(
    recovery = false,
    cpuOperation?: StoreGuiCpuOperation,
    benchmarkExecution?: StoreBenchmarkExecution,
  ): Promise<WaitingPeer> {
    if (this.#closed || (!recovery && (this.#ending || this.#recovering)))
      denied();
    const owner: WaitingOwner = {
      factoryAttempted: false,
      sessionAttempted: false,
      retired: false,
      closeFailures: [],
      ...(cpuOperation ? { cpuOperation } : {}),
      ...(benchmarkExecution ? { benchmarkExecution } : {}),
      ...(this.#desktopContext.getStore()
        ? { desktopScope: this.#desktopContext.getStore()! }
        : {}),
    };
    // Track construction before its first asynchronous factory call. A close
    // racing any partial open must join this same actual owner, not lose it.
    this.#waitingOwners.add(owner);
    owner.ready = Promise.resolve().then(() =>
      this.#constructWaitingPeer(owner, recovery),
    );
    try {
      const peer = await owner.ready;
      if (this.#closed || (!recovery && (this.#ending || this.#recovering)))
        denied();
      return peer;
    } catch (error) {
      await this.#closeWaiting(owner);
      throw error;
    }
  }
  async #constructWaitingPeer(
    owner: WaitingOwner,
    recovery = false,
  ): Promise<WaitingPeer> {
    const active = () => {
      if (this.#closed || (!recovery && (this.#ending || this.#recovering)))
        denied();
    };
    active();
    owner.factoryAttempted = true;
    const authority = this.#browserSource
      ? await StoreNativeAuthority.openBrowserWaitingPeer(this.#browserSource)
      : await StoreNativeAuthority.open();
    owner.authority = authority;
    active();
    if (!this.#browserSource) await authority.openGuiDataNative();
    else {
      const expected = this.personalPeer(),
        source =
          StoreNativeAuthority.prototype.browserSourceCreatorProof.call(
            authority,
          );
      if (!sameConsumerProcess(source.helper, expected)) denied();
    }
    active();
    const code =
      await StoreNativeAuthority.prototype.openWorkerCode.call(authority);
    owner.code = code;
    active();
    const binding =
      await StoreWorkerCodeAuthority.prototype.preparationBinding.call(code);
    active();
    if (JSON.stringify(binding) !== JSON.stringify(this.#binding)) denied();
    // A failed or lost bind ACK remains owned. Retirement must cover this
    // attempted native Session registration as well as the held code files.
    owner.sessionAttempted = true;
    const observation = parseStoreSessionObservation(
      bytes(
        await StoreNativeAuthority.prototype.storeSessionOperation.call(
          authority,
          code,
          "store_session_open",
          {},
        ),
      ),
      binding,
      this.#host.identity.sessionId,
    );
    active();
    if (JSON.stringify(observation) !== JSON.stringify(this.#observation))
      denied();
    return {
      authority,
      code,
      owner,
      close: () => this.#closeWaiting(owner),
    };
  }
  #closeWaiting(owner: WaitingOwner): Promise<void> {
    if (owner.closePending) return owner.closePending;
    const closing = (async () => {
      try {
        await owner.ready;
      } catch (error) {
        // Before a factory publishes an actual authority, no successful helper
        // retirement proof is available to this owner. Keep that uncertainty.
        if (!owner.authority && owner.factoryAttempted)
          owner.closeFailures.push(error);
      }
      if (owner.authority) {
        try {
          if (owner.sessionAttempted && owner.code)
            await StoreNativeAuthority.prototype.storeSessionOperation.call(
              owner.authority,
              owner.code,
              "store_session_close",
              {},
            );
        } catch (error) {
          owner.closeFailures.push(error);
        }
        try {
          if (owner.code)
            await StoreWorkerCodeAuthority.prototype.close.call(owner.code);
        } catch (error) {
          owner.closeFailures.push(error);
        } finally {
          try {
            owner.authorityClosePending ??=
              StoreNativeAuthority.prototype.close.call(owner.authority);
            await owner.authorityClosePending;
          } catch (error) {
            owner.closeFailures.push(error);
          }
        }
      }
      if (owner.closeFailures.length) throw owner.closeFailures[0];
      owner.retired = true;
      this.#waitingOwners.delete(owner);
    })();
    owner.closePending = closing;
    // Retirement can be initiated by another closing path while construction
    // still awaits its factory. Observe its original rejection immediately.
    void closing.catch(() => undefined);
    return closing;
  }
  async #recoverWaiting(owner: WaitingOwner): Promise<void> {
    if (owner.retired) return;
    try {
      await this.#closeWaiting(owner);
    } catch (error) {
      if (!owner.authorityClosePending) throw error;
      // A successful close of this exact original authority proves helper
      // death released its held files. It does not make the old bind/close ACK
      // or the memoized failed close promise successful.
      await owner.authorityClosePending;
      owner.retired = true;
    }
  }
  async awaitPrepareResult(
    launch: StorePrepareLaunch,
    options: { signal: AbortSignal },
  ) {
    if (
      arguments.length !== 2 ||
      !options ||
      Object.keys(options).join() !== "signal" ||
      !(options.signal instanceof AbortSignal)
    )
      denied();
    const run = this.#run(launch);
    if (run.waiting || run.closed || this.#recovering) denied();
    options.signal.throwIfAborted();
    const peer = await this.#waitingPeer();
    run.waiting = peer;
    const abort = () => {
      void this.cancelPrepare(launch).catch((error) => {
        run.cleanupFailure = error;
      });
    };
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        options.signal.throwIfAborted();
        const event = parseStorePrepareEvent(
          bytes(
            await this.#command(
              {
                version: 1,
                requestId: launch.requestId,
                action: "prepare_wait",
                launch,
              },
              peer,
            ),
          ),
          run.request,
          launch,
        );
        options.signal.throwIfAborted();
        if (event.state === "failed") throw new PrepareFailure(event.errorCode);
        if (event.state === "completed")
          return {
            result: event.result,
            ...(event.evidence ? { evidence: event.evidence } : {}),
          };
        // Each native call blocks on the actual result event/owned process. A
        // bounded wait expiry renews that event wait; it never reads status.
      }
    } finally {
      options.signal.removeEventListener("abort", abort);
      await peer.close();
      delete run.waiting;
    }
  }
  cancelPrepare(launch: StorePrepareLaunch): Promise<StorePrepareCleanup> {
    if (arguments.length !== 1) denied();
    const run = this.#run(launch);
    return (run.cleanupPending ??= this.#command({
      version: 1,
      requestId: launch.requestId,
      action: "prepare_cancel",
      launch,
    })
      .then((raw) => {
        const cleanup = parseStorePrepareCleanup(
          bytes(raw),
          run.request,
          launch,
        );
        run.closed = true;
        return cleanup;
      })
      .catch((error) => {
        run.cleanupFailure = error;
        throw error;
      }));
  }
  cleanupPending(): boolean {
    return (
      [...this.#runs.values()].some((run) => !run.closed) ||
      this.#controls.size !== 0 ||
      [...this.#waitingOwners].some((owner) => !owner.retired)
    );
  }
  /** Explicit retry retains the old failed cleanup promises and original
   * native/code ownership; failure never becomes a successful close. */
  recoverCleanup(): Promise<void> {
    if (this.#closed) denied();
    if (this.#recovering) return this.#recovering;
    const recovering = this.#recoverOwned();
    this.#recovering = recovering;
    const completed = () => {
      if (this.#recovering === recovering) this.#recovering = undefined;
    };
    void recovering.then(completed, completed);
    return recovering;
  }
  async #recoverOwned(): Promise<void> {
    let failure: unknown;
    let failed = false;
    try {
      for (const run of this.#controls.values()) {
        await run.pending?.catch(() => {});
        if (!this.#controls.has(run.command.requestId)) continue;
        // A still-live original helper remains the recovery owner. If it
        // positively retired, another genuine same-GUI helper recovers only
        // the Creator's original request; it never receives caller receipts.
        if (run.peer?.owner.retired) delete run.peer;
        await this.#forward(run, AbortSignal.timeout(70000), true);
      }
      for (const run of this.#runs.values()) {
        if (run.closed) continue;
        let launch = run.launch;
        if (!launch) {
          try {
            launch = await run.launchPending;
          } catch {
            // Resolve only the actual Creator-owned request in this genuine
            // client scope. Caller nonces/private receipts are never imported.
            const recovered = await this.#command({
              version: 1,
              requestId: run.request.requestId,
              action: "prepare_recover",
              request: run.request,
            });
            launch = parseStorePrepareLaunchResult(
              bytes(recovered),
              run.request,
            );
          }
          run.launch = launch;
        }
        if (run.cleanupFailure !== undefined && run.cleanupPending) {
          this.#oldCleanup.push(run.cleanupPending);
          delete run.cleanupPending;
          delete run.cleanupFailure;
        }
        await this.cancelPrepare(launch);
      }
    } catch (error) {
      failure = error;
      failed = true;
    }
    const retired = await Promise.allSettled(
      [...this.#waitingOwners].map((owner) => this.#recoverWaiting(owner)),
    );
    for (const run of this.#runs.values())
      if (run.waiting?.owner.retired) delete run.waiting;
    if (failed) throw failure;
    const unconfirmed = retired.find((result) => result.status === "rejected");
    if (unconfirmed?.status === "rejected") throw unconfirmed.reason;
  }
  close(): Promise<void> {
    if (arguments.length !== 0) denied();
    if (this.#closing) return this.#closing;
    this.#ending = true;
    this.#closing = this.#close();
    void this.#closing.catch(() => {});
    return this.#closing;
  }
  recoverClose(): Promise<void> {
    if (arguments.length || !this.#ending || !this.#closing)
      return Promise.reject(new Error("STORE_SESSION_CLIENT_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#closeRecovering ??= (async () => {
      const original = this.#closing!;
      this.#closeFailures.push(original);
      await original.catch(() => {});
      if (!this.#closed) {
        this.#closing = this.#close();
        await this.#closing;
      }
    })().finally(() => {
      this.#closeRecovering = undefined;
    });
    void this.#closeRecovering.catch(() => {});
    return this.#closeRecovering;
  }
  async #close(): Promise<void> {
    const benchmarks = await Promise.allSettled(
      [...this.#benchmarks].map(async (execution) => {
        try {
          await StoreBenchmarkExecution.prototype.close.call(execution);
        } catch {
          await StoreBenchmarkExecution.prototype.recoverClose.call(execution);
        }
      }),
    );
    const failedBenchmark = benchmarks.find((row) => row.status === "rejected");
    if (failedBenchmark?.status === "rejected") throw failedBenchmark.reason;
    const cpu = await Promise.allSettled(
      [...this.#guiCpu.values()].map(async (execution) => {
        try {
          await StoreGuiMediaExecution.prototype.close.call(execution);
        } catch {
          await StoreGuiMediaExecution.prototype.recoverClose.call(execution);
        }
      }),
    );
    const failedCpu = cpu.find((result) => result.status === "rejected");
    if (failedCpu?.status === "rejected") throw failedCpu.reason;
    await this.recoverCleanup();
    if (!this.#sessionClosed) {
      await StoreNativeAuthority.prototype.storeSessionOperation.call(
        this.#authority,
        this.#code,
        "store_session_close",
        {},
      );
      this.#sessionClosed = true;
    }
    if (this.#browserSource) {
      await StoreWorkerCodeAuthority.prototype.close.call(this.#code);
      await StoreNativeAuthority.prototype.close.call(this.#authority);
      StoreSessionClient.#browserClients.delete(this);
    }
    this.#closed = true;
  }
}
/** A GUI window owns only the control requests admitted through this exact
 * private scope. Closing it never closes the borrowed Prepare client or code. */
export class StoreDesktopControlLifetime {
  #client: StoreSessionClient;
  #intake = new AbortController();
  #ending = false;
  #closed = false;
  #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #retirements: Promise<void>[] = [];
  constructor(token: symbol, client: StoreSessionClient) {
    if (token !== TOKEN || !(client instanceof StoreSessionClient)) denied();
    this.#client = client;
    Object.freeze(this);
  }
  assertActive(client: StoreSessionClient): void {
    if (
      arguments.length !== 1 ||
      client !== this.#client ||
      this.#ending ||
      this.#closed
    )
      denied();
  }
  assertClosing(client: StoreSessionClient): void {
    if (
      arguments.length !== 1 ||
      client !== this.#client ||
      !this.#ending ||
      this.#closed
    )
      denied();
  }
  #invoke(
    operation: "command" | "personal" | "proof",
    input: unknown,
    signal?: AbortSignal,
    accountScope?: SessionAccountScope | null,
  ): Promise<SessionSnapshot | PersonalReply | PersonalPlaybackOwnerProof> {
    this.assertActive(this.#client);
    if (signal !== undefined && !(signal instanceof AbortSignal)) denied();
    const lifetime = AbortSignal.any([
      this.#intake.signal,
      signal ?? AbortSignal.timeout(70000),
    ]);
    lifetime.throwIfAborted();
    const pending = StoreSessionClient.prototype.performDesktop.call(
      this.#client,
      this,
      operation,
      input,
      lifetime,
      accountScope,
    );
    this.#pending.add(pending);
    const settled = () => this.#pending.delete(pending);
    void pending.then(settled, settled);
    return pending;
  }
  command(
    command: SessionCommand,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    if (arguments.length < 1 || arguments.length > 2) denied();
    return this.#invoke("command", command, signal) as Promise<SessionSnapshot>;
  }
  personal(
    command: PersonalCommand,
    ownerKind: "desktop" = "desktop",
    capturedScope?: SessionAccountScope | null,
    signal?: AbortSignal,
  ): Promise<PersonalReply> {
    if (arguments.length < 1 || arguments.length > 4 || ownerKind !== "desktop")
      denied();
    return this.#invoke(
      "personal",
      command,
      signal,
      capturedScope,
    ) as Promise<PersonalReply>;
  }
  waitState(
    afterRevision: number,
    instanceId?: string,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    if (arguments.length < 1 || arguments.length > 3) denied();
    return this.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "wait_state",
        after_revision: afterRevision,
        ...(instanceId === undefined ? {} : { instance_id: instanceId }),
      },
      signal,
    );
  }
  provePersonalOwner(
    request: PersonalPlaybackOwnerRequest,
    signal?: AbortSignal,
  ): Promise<PersonalPlaybackOwnerProof> {
    if (arguments.length < 1 || arguments.length > 2) denied();
    return this.#invoke(
      "proof",
      request,
      signal,
    ) as Promise<PersonalPlaybackOwnerProof>;
  }
  currentAuthority(): ConsumerProcessIdentity | undefined {
    if (arguments.length) denied();
    this.assertActive(this.#client);
    return StoreSessionClient.prototype.currentAuthority.call(this.#client);
  }
  personalPeer(): ConsumerProcessIdentity {
    if (arguments.length) denied();
    this.assertActive(this.#client);
    return StoreSessionClient.prototype.personalPeer.call(this.#client);
  }
  close(): Promise<void> {
    if (arguments.length) denied();
    if (this.#closing) return this.#closing;
    this.#ending = true;
    this.#intake.abort(new Error("STORE_DESKTOP_CONTROL_CLOSING"));
    return (this.#closing = this.#retire());
  }
  recoverClose(): Promise<void> {
    if (arguments.length || !this.#ending) denied();
    if (this.#closed) return Promise.resolve();
    if (this.#recovering) return this.#recovering;
    const recovering = (async () => {
      await this.#closing?.catch(() => {});
      await this.#retire();
    })();
    this.#recovering = recovering;
    const settled = () => {
      if (this.#recovering === recovering) this.#recovering = undefined;
    };
    void recovering.then(settled, settled);
    return recovering;
  }
  async #retire(): Promise<void> {
    await Promise.allSettled(this.#pending);
    const retirement = StoreSessionClient.prototype.retireDesktop.call(
      this.#client,
      this,
    );
    this.#retirements.push(retirement);
    await retirement;
    this.#closed = true;
  }
}
export function openStoreDesktopSessionClient(
  host: HostContext,
  code: StoreWorkerCodeAuthority,
  options: { launchIfAbsent?: boolean } = {},
) {
  return StoreSessionClient.open(host, code, options);
}
