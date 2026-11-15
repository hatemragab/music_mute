import { createHash, randomBytes } from "node:crypto";
import { parseStoreNodeRotation } from "../../shared/store-node-rotation.js";
import { createConnection, type Socket } from "node:net";
import { win32 } from "node:path";
import { Readable } from "node:stream";
import { types } from "node:util";
import {
  assertStoreFixedTool,
  parseStoreToolStarted,
  parseStoreToolToken,
  parseStoreToolChunk,
  parseStoreToolCleanup,
  type StoreFixedToolKind,
} from "../../shared/store-tool-contracts.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  parseStoreCodeInventoryBytes,
  type StoreCodeInventory,
} from "../../../packaging/store/inventory.js";
import { createStoreConsumerNativeTransport } from "../../../../worker/src/platform/windows/consumer-native-transport.js";
import {
  WindowsConsumerNative,
  sameConsumerProcess,
  processIdentityToWire,
  processIdentityFromWire,
  parseConsumerGpu,
  type ConsumerOwnedProcess,
  type ConsumerOwnedRole,
  type ConsumerProcessIdentity,
  type ConsumerNativeTransport,
  type PrivateWritable,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  parseStoreBootReceipt,
  type StoreBootReceipt,
} from "../../shared/store-boot-receipt.js";
import {
  parseStoreRoleOwner,
  parseStoreLaunchedOwner,
} from "./store-role-owner.js";
import { readStoreProtectedBytes } from "./store-protected-read.js";
import { parseStoreWorkerRuntimeManifest } from "../browser/store-worker-code.js";
import type { WindowsReleaseManifest } from "../../../../worker/src/platform/windows/release-manifest.js";
import {
  parseStoreInstalledPackage,
  type StoreInstalledPackage,
} from "../../shared/store-contracts.js";
import type { StorePreparationBinding } from "../prepare/store-model-ready.js";
import { PERSONAL_RECIPE_DIGESTS } from "../personal/timeline.js";
import {
  parseStorePrepareLaunch,
  STORE_PREPARE_FAILURE_CODES,
  type StorePrepareLaunchRequest,
} from "../../shared/store-prepare-contracts.js";
import { randomUUID } from "node:crypto";
import {
  parseStoreControlEvent,
  parseStoreControlReceived,
  storeControlReplyBytes,
  parseStoreControlDelivery,
  type StoreControlReceived,
} from "../../shared/store-control-contracts.js";
import type { SessionDispatcher } from "./control.js";
import {
  ChildFrameDecoder,
  encodeChildFrame,
  type ChildRequestCommand,
  type ChildResponse,
} from "../../../../worker/src/agent/ipc/child-protocol.js";
import {
  parseChildProgress,
  CHILD_PROGRESS_STAGES,
  type ChildProgress,
} from "../../../../worker/src/agent/ipc/child-progress.js";
import { ChildCommandError } from "../../../../worker/src/agent/ipc/child-command-error.js";
import { sanitizeDiagnostic } from "../../../../worker/src/agent/diagnostic-redaction.js";
import type { HostContext } from "../host-context.js";
import {
  parseStoreTransferRequest,
  snapshotStoreTransferBytes,
} from "../../../../worker/src/runtime/store-transfer-contracts.js";
import {
  parseStoreBenchmarkRequest,
  type StoreBenchmarkRequest,
} from "../../shared/store-benchmark-contracts.js";
import { StoreFleetAttemptLease } from "./store-fleet-attempt.js";
export { StoreFleetAttemptLease } from "./store-fleet-attempt.js";
import {
  parseStoreMediaNativeRequest,
  type StoreMediaConfiguration,
  type StoreMediaRequest,
} from "../../shared/store-media-request.js";
import type { StoreMediaExecution } from "./store-media-runner.js";
import { StoreCpuOperation } from "./store-cpu-operation.js";
import { storeCpuFields } from "../../shared/store-cpu-operation.js";
import {
  parseStoreCpuOperationExpectation,
  type StoreCpuOperationExpectation,
} from "../../../../worker/src/platform/windows/consumer-store-cpu.js";

export type StorePreparePublication =
  | {
      readonly requestId: string;
      readonly rawSha256: string;
      readonly rawBytes: number;
    }
  | {
      readonly requestId: string;
      readonly errorCode: (typeof STORE_PREPARE_FAILURE_CODES)[number];
    };
export type StoreCpuPreparePublication =
  | {
      readonly requestId: string;
      readonly bytes: number;
      readonly sha256: string;
    }
  | {
      readonly requestId: string;
      readonly errorCode: (typeof STORE_PREPARE_FAILURE_CODES)[number];
    };

export type StoreNodeRole =
  "session-agent" | "login-worker" | "personal" | "fleet" | "prepare";
export interface StoreNodeBootstrap {
  readonly version: 1;
  readonly role: StoreNodeRole;
  readonly creator_pid: number;
  readonly creator_creation_time: string;
  readonly creator_channel: string;
  readonly capability: string;
}
const TOKEN = Symbol("live-store-node-issuer"),
  HASH = /^[a-f0-9]{64}$/u,
  ROLES = new Set<StoreNodeRole>([
    "session-agent",
    "login-worker",
    "personal",
    "fleet",
    "prepare",
  ]);
function deny(): never {
  throw new Error("STORE_NODE_ISSUER_DENIED");
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      value,
    )
  )
    deny();
  return value;
}
function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny();
  const prototype = Object.getPrototypeOf(value),
    descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    deny();
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !("value" in descriptor)) deny();
    result[name] = descriptor.value;
  }
  return result;
}
function pid(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2147483647
  )
    deny();
  return value as number;
}
function secret(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) deny();
  return value;
}
function birth(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    deny();
  return value;
}
function role(value: unknown): StoreNodeRole {
  if (typeof value !== "string" || !ROLES.has(value as StoreNodeRole)) deny();
  return value as StoreNodeRole;
}
/** Receiving policy only. This cannot create a live role or native authority. */
export function parseStoreNodeBootstrap(bytes: Uint8Array): StoreNodeBootstrap {
  try {
    if (bytes.byteLength < 1 || bytes.byteLength > 4096) deny();
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (
      text.charCodeAt(0) === 0xfeff ||
      !text.endsWith("\n") ||
      text.indexOf("\n") !== text.length - 1 ||
      text.includes("\r")
    )
      deny();
    const value = exact(parseStrictJson(text, 4096, 64), [
      "version",
      "role",
      "creator_pid",
      "creator_creation_time",
      "creator_channel",
      "capability",
    ]);
    if (value.version !== 1) deny();
    return Object.freeze({
      version: 1,
      role: role(value.role),
      creator_pid: pid(value.creator_pid),
      creator_creation_time: birth(value.creator_creation_time),
      creator_channel: secret(value.creator_channel),
      capability: secret(value.capability),
    });
  } catch {
    return deny();
  }
}
/** Full protected-code inventory receiving policy. Keep the ordinary IPC
 * parser's small node limit; the shared inventory parser bounds each row. */
export function parseStoreNodeInventory(bytes: Uint8Array): StoreCodeInventory {
  try {
    const inventory = parseStoreCodeInventoryBytes(bytes);
    if (inventory.role !== "worker") deny();
    return inventory;
  } catch {
    return deny();
  }
}
/** Receiving bytes only. The caller must already hold the creator-bound live
 * Node issuer whose native role owner confirmed this outer inventory digest. */
export function parseStoreNodeManifestBytes(
  bytes: Uint8Array,
  inventory: StoreCodeInventory,
  installed: StoreInstalledPackage,
  inventorySha256: string,
): WindowsReleaseManifest {
  try {
    if (inventory.role !== "worker" || !HASH.test(inventorySha256)) deny();
    const pin = inventory.entries.find(
      (entry) => entry.path === "worker/release-manifest.json",
    );
    if (!pin || pin.bytes < 1 || pin.bytes > 8 * 1024 ** 2) deny();
    return parseStoreWorkerRuntimeManifest(bytes, {
      version: 1,
      package: parseStoreInstalledPackage("worker", installed),
      inventorySha256,
      manifest: {
        path: "worker/release-manifest.json",
        bytes: pin.bytes,
        sha256: pin.sha256,
      },
    });
  } catch {
    return deny();
  }
}
export interface StoreNodeCodeView {
  readonly binding: StorePreparationBinding;
  readonly manifest: WindowsReleaseManifest;
}
function inheritedBootstrap(): Promise<StoreNodeBootstrap> {
  return new Promise((resolve, reject) => {
    const input = process.stdin,
      chunks: Buffer[] = [];
    let total = 0,
      finished = false;
    const retire = () => {
      clearTimeout(timer);
      input.off("data", data);
      input.off("end", end);
      input.off("error", fail);
      for (const chunk of chunks) chunk.fill(0);
    };
    const fail = () => {
      if (finished) return;
      finished = true;
      retire();
      input.destroy();
      reject(new Error("STORE_NODE_ISSUER_DENIED"));
    };
    const data = (value: Buffer | string) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += bytes.length;
      if (total > 4096) {
        bytes.fill(0);
        fail();
        return;
      }
      chunks.push(Buffer.from(bytes));
      bytes.fill(0);
    };
    const end = () => {
      if (finished) return;
      const bytes = Buffer.concat(chunks);
      try {
        const value = parseStoreNodeBootstrap(bytes);
        finished = true;
        retire();
        resolve(value);
      } catch {
        fail();
      } finally {
        bytes.fill(0);
      }
    };
    const timer = setTimeout(fail, 10000);
    input.on("data", data);
    input.once("end", end);
    input.once("error", fail);
    input.resume();
  });
}
// This class is intentionally module-private and requires the private factory
// token. No caller-supplied transport, receipt or JSON can construct this actor.
class StoreRoleNative extends WindowsConsumerNative {
  #wire: ConsumerNativeTransport;
  #boot: StoreBootReceipt;
  #actor: ConsumerOwnedProcess;
  #generation: string;
  #issuer: StoreNodeIssuer;
  #retired: (native: WindowsConsumerNative) => void;
  constructor(
    token: symbol,
    transport: ConsumerNativeTransport,
    boot: StoreBootReceipt,
    actor: ConsumerOwnedProcess,
    generation: string,
    issuer: StoreNodeIssuer,
    retired: (native: WindowsConsumerNative) => void,
  ) {
    if (token !== TOKEN || issuer.nodeRole !== actor.role) deny();
    super(StoreRoleNative.#mappedTransport(transport, boot, actor));
    this.#wire = transport;
    this.#boot = boot;
    this.#actor = actor;
    this.#generation = generation;
    this.#issuer = issuer;
    this.#retired = retired;
  }
  override async close(): Promise<void> {
    await super.close();
    this.#retired(this);
  }
  async transferOperation(
    operation: "start" | "write" | "read" | "stop" | "inspect",
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (arguments.length !== 2 || this.#actor.role !== "fleet") deny();
    const opcode = (
      {
        start: "store_transfer_start",
        write: "store_transfer_write",
        read: "store_transfer_read",
        stop: "store_transfer_stop",
        inspect: "store_transfer_inspect",
      } as const
    )[operation];
    if (!opcode) deny();
    return this.#wire.request(opcode, input, 35000);
  }
  async fleetWorkspaceOperation(
    operation: "open" | "recover" | "inspect" | "retire",
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (arguments.length !== 2 || this.#actor.role !== "fleet") deny();
    const opcode =
      operation === "open"
        ? "store_fleet_workspace_open"
        : operation === "recover"
          ? "store_fleet_workspace_recover"
          : operation === "inspect"
            ? "store_fleet_workspace_inspect"
            : operation === "retire"
              ? "store_fleet_workspace_retire"
              : undefined;
    if (!opcode) deny();
    return this.#wire.request(opcode, input, 35000);
  }
  async controlRequest(
    requestId: string,
    target: "session" | "personal" | "fleet",
    payload: Uint8Array,
    expectedTarget?: ConsumerOwnedProcess,
  ): Promise<Buffer | null> {
    const value = await this.#wire.request(
      "store_control_request",
      {
        requestId,
        target,
        payload_base64: Buffer.from(payload).toString("base64"),
        ...(expectedTarget
          ? {
              expected_target: {
                role: expectedTarget.role,
                nonce: expectedTarget.nonce,
                identity: processIdentityToWire(expectedTarget.identity),
              },
            }
          : {}),
      },
      35000,
    );
    if (!expectedTarget) return parseStoreControlEvent(value, requestId);
    const row = exact(
      value,
      value &&
        typeof value === "object" &&
        (value as { state?: unknown }).state === "waiting"
        ? ["version", "requestId", "state", "target_owner"]
        : ["version", "requestId", "state", "payload_base64", "target_owner"],
    );
    const actual = parseStoreLaunchedOwner(
      row.target_owner,
      this.#boot,
      expectedTarget.role === "fleet" ? "fleet" : "personal",
    );
    if (
      actual.nonce !== expectedTarget.nonce ||
      !sameConsumerProcess(actual.identity, expectedTarget.identity)
    )
      deny();
    const { target_owner: unused, ...event } = row;
    void unused;
    return parseStoreControlEvent(event, requestId);
  }
  async controlAck(requestId: string): Promise<void> {
    const result = exact(
      await this.#wire.request("store_control_ack", { requestId }),
      ["acknowledged"],
    );
    if (result.acknowledged !== true) deny();
  }
  async controlAccept(): Promise<StoreControlReceived | null> {
    return parseStoreControlReceived(
      await this.#wire.request("store_control_accept", {}, 35000),
    );
  }
  async controlReply(
    received: StoreControlReceived,
    payload: Uint8Array,
  ): Promise<boolean> {
    const raw = await this.#wire.request(
      "store_control_reply",
      {
        token: received.token,
        payload_base64: storeControlReplyBytes(payload),
      },
      35000,
    );
    return parseStoreControlDelivery(raw);
  }
  async controlPeer(
    token: string,
    peer: ConsumerProcessIdentity,
    kind: "gui" | "chrome" | "session-agent" | "personal" | "fleet",
  ): Promise<boolean> {
    const result = exact(
      await this.#wire.request(
        "store_control_peer",
        { token, kind, identity: processIdentityToWire(peer) },
        35000,
      ),
      ["verified"],
    );
    if (typeof result.verified !== "boolean") deny();
    return result.verified;
  }
  async toolStart(
    kind: StoreFixedToolKind,
    requestId: string,
    incarnation: string,
    configurationSha256: string,
    operationToken: string,
  ) {
    return this.#wire.request(
      "store_tool_start",
      {
        kind,
        request_id: requestId,
        incarnation,
        configuration_sha256: configurationSha256,
        operation_token: operationToken,
      },
      35000,
    );
  }
  async cpuOperationOpen(
    args: {
      request_id: string;
      incarnation: string;
      operation: string;
      configuration_sha256: string;
    },
    recovery: boolean,
  ) {
    return this.#wire.request(
      recovery ? "store_cpu_operation_recover" : "store_cpu_operation_open",
      args,
      35000,
    );
  }
  async cpuOperationBindData(token: string): Promise<void> {
    const row = storeCpuFields(
      await this.#wire.request(
        "store_cpu_operation_bind_data",
        { token },
        35000,
      ),
      ["bound"],
    );
    if (row.bound !== true) deny();
  }
  async cpuOperationInspect(
    expectation: import("../../shared/store-cpu-operation.js").StoreCpuOperationExpectation,
  ) {
    return this.#wire.request(
      "store_cpu_operation_inspect",
      { token: expectation.token, expectation },
      35000,
    );
  }
  async cpuOperationRetire(token: string) {
    return this.#wire.request("store_cpu_operation_retire", { token }, 35000);
  }
  async toolRead(token: string) {
    return this.#wire.request("store_tool_read", { token }, 35000);
  }
  async fixedStopBeforeToken(
    kind: StoreFixedToolKind | "qualification" | "benchmark",
    input: Record<string, unknown>,
  ): Promise<void> {
    const opcode =
      kind === "qualification"
        ? "store_qualification_stop"
        : kind === "benchmark"
          ? "store_benchmark_stop"
          : "store_tool_stop";
    parseStoreToolCleanup(await this.#wire.request(opcode, input, 35000));
  }
  async toolStop(token: string): Promise<void> {
    parseStoreToolCleanup(
      await this.#wire.request("store_tool_stop", { token }, 35000),
    );
  }
  async benchmarkRequest(): Promise<StoreBenchmarkRequest> {
    const row = storeCpuFields(
      await this.#wire.request("store_benchmark_request", {}, 35000),
      ["version", "requestId", "operation", "binding", "configuration_json"],
    );
    if (
      typeof row.configuration_json !== "string" ||
      Buffer.byteLength(row.configuration_json) > 16384
    )
      deny();
    const configuration = parseStrictJson(row.configuration_json, 16384, 4096);
    return parseStoreBenchmarkRequest(
      Buffer.from(
        JSON.stringify({
          version: row.version,
          requestId: row.requestId,
          operation: row.operation,
          binding: row.binding,
          configuration,
        }),
      ),
    );
  }
  async benchmarkStart(incarnation: string) {
    return this.#wire.request("store_benchmark_start", { incarnation }, 35000);
  }
  async benchmarkRead(token: string) {
    return this.#wire.request("store_benchmark_read", { token }, 35000);
  }
  async benchmarkStop(token: string): Promise<void> {
    parseStoreToolCleanup(
      await this.#wire.request("store_benchmark_stop", { token }, 35000),
    );
  }
  async benchmarkResult(input: Record<string, unknown>): Promise<void> {
    const row = storeCpuFields(
      await this.#wire.request("store_benchmark_result", input, 35000),
      ["accepted"],
    );
    if (row.accepted !== true) deny();
  }
  async qualificationStart(incarnation: string) {
    return this.#wire.request(
      "store_qualification_start",
      { incarnation },
      35000,
    );
  }
  async qualificationRead(token: string) {
    return this.#wire.request("store_qualification_read", { token }, 35000);
  }
  async qualificationStop(token: string): Promise<void> {
    parseStoreToolCleanup(
      await this.#wire.request("store_qualification_stop", { token }, 35000),
    );
  }
  async childStart(relative: string, incarnation: string) {
    return this.#wire.request(
      "store_child_start",
      { config_relative: relative, incarnation },
      35000,
    );
  }
  async childRead(token: string) {
    return this.#wire.request("store_child_read", { token }, 35000);
  }
  async childWrite(token: string, bytes: Uint8Array): Promise<void> {
    const result = exact(
      await this.#wire.request(
        "store_child_write",
        { token, bytes_base64: Buffer.from(bytes).toString("base64") },
        35000,
      ),
      ["written"],
    );
    if (result.written !== bytes.byteLength) deny();
  }
  async childStopOriginal(
    relative: string,
    incarnation: string,
  ): Promise<void> {
    parseStoreToolCleanup(
      await this.#wire.request(
        "store_child_stop",
        { config_relative: relative, incarnation },
        35000,
      ),
    );
  }
  async childStop(token: string): Promise<void> {
    const result = exact(
      await this.#wire.request("store_child_stop", { token }, 35000),
      ["job", "stopped"],
    );
    if (result.job !== "confirmed" || result.stopped !== true) deny();
  }
  /** Reuse the SDK's real nonce/lease/retained-engine receiving checks while
   * routing only these fixed operations to the native Store actor. Raw legacy
   * launch/GPU operations are never admitted by the Store helper itself. */
  static #mappedTransport(
    wire: ConsumerNativeTransport,
    boot: StoreBootReceipt,
    actor: ConsumerOwnedProcess,
  ): ConsumerNativeTransport {
    return {
      request: async (operation, args, timeout) => {
        if (operation === "bind_role_job") {
          const row = exact(args, ["owner"]),
            owner = exact(row.owner, ["role", "nonce", "identity"]);
          if (
            owner.role !== actor.role ||
            owner.nonce !== actor.nonce ||
            !sameConsumerProcess(
              processIdentityFromWire(owner.identity),
              actor.identity,
            )
          )
            deny();
          return wire.request("store_gpu_bind", {}, timeout);
        }
        if (operation === "acquire_gpu_guard") {
          const row = exact(args, ["luid"]),
            current = exact(await wire.request("gpu_inventory", {}), ["gpus"]);
          if (!Array.isArray(current.gpus) || current.gpus.length > 16) deny();
          const selected = current.gpus
            .map(parseConsumerGpu)
            .filter((gpu) => gpu.luid === row.luid);
          if (selected.length !== 1) deny();
          return wire.request(
            "store_gpu_acquire",
            { gpu: selected[0] },
            timeout,
          );
        }
        if (operation === "release_gpu_guard") {
          const row = exact(args, ["luid", "nonce", "identity"]);
          if (
            !sameConsumerProcess(
              processIdentityFromWire(row.identity),
              boot.helper,
            )
          )
            deny();
          return wire.request(
            "store_gpu_release",
            { luid: row.luid, nonce: row.nonce },
            timeout,
          );
        }
        if (operation === "inference_idle")
          return wire.request("store_inference_idle", args, timeout);
        if (operation === "retained_engine_register")
          return wire.request("store_retained_engine_register", args, timeout);
        if (operation === "retained_engine_begin")
          return wire.request("store_retained_engine_begin", args, timeout);
        if (operation === "retained_engine_complete")
          return wire.request("store_retained_engine_complete", args, timeout);
        if (operation === "retained_engine_idle")
          return wire.request("store_retained_engine_idle", args, timeout);
        if (operation === "retained_engine_forget")
          return wire.request("store_retained_engine_forget", args, timeout);
        return wire.request(operation, args, timeout);
      },
      close: wire.close.bind(wire),
      ...(wire.onEvent ? { onEvent: wire.onEvent.bind(wire) } : {}),
      ...(wire.onClosed ? { onClosed: wire.onClosed.bind(wire) } : {}),
    };
  }
  override async verifyPersonalOwnerProofPeers(
    authority: ConsumerProcessIdentity,
    owner: ConsumerProcessIdentity,
    ownerKind: "desktop" | "chrome",
  ): Promise<boolean> {
    if (
      arguments.length !== 3 ||
      this.#actor.role !== "session-agent" ||
      (ownerKind !== "desktop" && ownerKind !== "chrome")
    )
      deny();
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this);
    if (!sameConsumerProcess(authority, owner)) return false;
    // Only the real active Creator delivery scope can verify the stable GUI
    // peer. Legacy tickets/selected PPID/receiving JSON never grant this.
    return StoreNodeIssuer.prototype.verifyControlPeer.call(
      this.#issuer,
      authority,
      ownerKind === "chrome" ? "chrome" : "gui",
    );
  }
  override async launchOwned(role: ConsumerOwnedRole, generation: string) {
    if (
      this.#actor.role !== "session-agent" ||
      !["personal", "fleet", "prepare"].includes(role) ||
      generation !== this.#generation
    )
      deny();
    const value = await this.#wire.request(
      "store_role_launch",
      { role },
      35000,
    );
    return parseStoreLaunchedOwner(
      value,
      this.#boot,
      role as "personal" | "fleet" | "prepare",
    );
  }
  #ownerWire(owner: ConsumerOwnedProcess, historicalInspection = false) {
    if (
      !["personal", "fleet", "prepare"].includes(owner.role) ||
      !HASH.test(owner.nonce) ||
      owner.identity.sid !== this.#boot.parent.sid ||
      owner.identity.sessionId !== this.#boot.parent.sessionId ||
      (this.#actor.role !== "session-agent" &&
        !(
          historicalInspection &&
          this.#actor.role === "personal" &&
          owner.role === "personal"
        ) &&
        (owner.role !== this.#actor.role ||
          owner.nonce !== this.#actor.nonce ||
          !sameConsumerProcess(owner.identity, this.#actor.identity)))
    )
      deny();
    return {
      role: owner.role,
      nonce: owner.nonce,
      identity: processIdentityToWire(owner.identity),
    };
  }
  override async stopOwned(owner: ConsumerOwnedProcess) {
    if (this.#actor.role !== "session-agent") deny();
    const value = exact(
      await this.#wire.request(
        "store_role_stop",
        { owner: this.#ownerWire(owner) },
        35000,
      ),
      ["stopped", "cleanup"],
    );
    if (value.stopped !== true || value.cleanup !== "confirmed") deny();
  }
  override async ownedTreeExited(owner: ConsumerOwnedProcess) {
    const value = exact(
      await this.#wire.request(
        "store_role_inspect",
        { owner: this.#ownerWire(owner, true) },
        35000,
      ),
      ["exited"],
    );
    if (typeof value.exited !== "boolean") deny();
    return value.exited;
  }
  override async isOwnedProcess(
    owner: ConsumerOwnedProcess,
    peer: ConsumerProcessIdentity,
  ) {
    const value = exact(
      await this.#wire.request("store_role_peer", {
        owner: this.#ownerWire(owner),
        identity: processIdentityToWire(peer),
      }),
      ["owned"],
    );
    if (typeof value.owned !== "boolean") deny();
    return value.owned;
  }
  override async inspectStartup() {
    const reply = exact(
      await this.#wire.request("store_startup", { intent: "inspect" }),
      ["before", "after", "action"],
    );
    if (
      reply.action !== "none" ||
      reply.before !== reply.after ||
      ![
        "disabled",
        "disabled-by-user",
        "enabled",
        "disabled-by-policy",
        "enabled-by-policy",
      ].includes(reply.after as string)
    )
      deny();
    return reply.after === "enabled" || reply.after === "enabled-by-policy"
      ? ("registered" as const)
      : ("disabled" as const);
  }
  async publishSession(): Promise<void> {
    if (arguments.length !== 0 || this.#actor.role !== "session-agent") deny();
    const reply = exact(
      await this.#wire.request("store_session_publish", {}, 35000),
      ["published"],
    );
    if (reply.published !== true) deny();
  }
  override async legacyWorkerConflict(): Promise<boolean> {
    if (this.#actor.role !== "session-agent") deny();
    const result = exact(
      await this.#wire.request("store_legacy_worker_conflict", {}),
      ["conflict"],
    );
    if (typeof result.conflict !== "boolean") deny();
    return result.conflict;
  }
  async retireSessionChildren(): Promise<void> {
    if (arguments.length !== 0 || this.#actor.role !== "session-agent") deny();
    const reply = exact(
      await this.#wire.request("store_session_retire_children", {}, 35000),
      ["cleanup"],
    );
    if (reply.cleanup !== "confirmed") deny();
  }
  async prepareRequest(): Promise<StorePrepareLaunchRequest> {
    if (arguments.length !== 0 || this.#actor.role !== "prepare") deny();
    return parseStorePrepareLaunch(
      Buffer.from(
        JSON.stringify(await this.#wire.request("store_prepare_request", {})),
      ),
    );
  }
  async publishPrepareResult(value: StorePreparePublication): Promise<void> {
    if (arguments.length !== 1 || this.#actor.role !== "prepare") deny();
    const reply = exact(
      await this.#wire.request(
        "store_prepare_result",
        parsePreparePublication(value),
      ),
      ["accepted"],
    );
    if (reply.accepted !== true) deny();
  }
  async cpuPrepareRequest(): Promise<StoreMediaRequest> {
    if (arguments.length !== 0 || this.#actor.role !== "prepare") deny();
    return parseStoreMediaNativeRequest(
      await this.#wire.request("store_cpu_prepare_request", {}),
    );
  }
  async publishCpuPrepareReady(value: {
    requestId: string;
    expectation: StoreCpuOperationExpectation;
  }): Promise<void> {
    if (arguments.length !== 1 || this.#actor.role !== "prepare") deny();
    const row = exact(value, ["requestId", "expectation"]);
    const expectation = parseStoreCpuOperationExpectation(row.expectation);
    if (
      uuid(row.requestId) !== expectation.requestId ||
      expectation.nodeOwner.role !== "prepare" ||
      expectation.nodeOwner.nonce !== this.#actor.nonce ||
      !sameConsumerProcess(expectation.nodeOwner.identity, this.#actor.identity)
    )
      deny();
    const reply = exact(
      await this.#wire.request("store_cpu_prepare_ready", {
        requestId: expectation.requestId,
        expectation,
      }),
      ["accepted"],
    );
    if (reply.accepted !== true) deny();
  }
  async waitCpuPrepareStart(): Promise<boolean> {
    if (arguments.length !== 0 || this.#actor.role !== "prepare") deny();
    const reply = exact(
      await this.#wire.request("store_cpu_prepare_start", {}, 35000),
      ["started"],
    );
    if (typeof reply.started !== "boolean") deny();
    return reply.started;
  }
  async publishCpuPrepareResult(
    value: StoreCpuPreparePublication,
  ): Promise<void> {
    if (arguments.length !== 1 || this.#actor.role !== "prepare") deny();
    const error = Object.getOwnPropertyDescriptor(value, "errorCode"),
      row = exact(
        value,
        error ? ["requestId", "errorCode"] : ["requestId", "bytes", "sha256"],
      );
    uuid(row.requestId);
    if (error) {
      if (!STORE_PREPARE_FAILURE_CODES.includes(row.errorCode as never)) deny();
    } else if (
      !Number.isSafeInteger(row.bytes) ||
      (row.bytes as number) < 2 ||
      (row.bytes as number) > 1024 ** 2 ||
      typeof row.sha256 !== "string" ||
      !HASH.test(row.sha256)
    )
      deny();
    const reply = exact(
      await this.#wire.request("store_cpu_prepare_result", row),
      ["accepted"],
    );
    if (reply.accepted !== true) deny();
  }
}
function parsePreparePublication(value: unknown): Record<string, unknown> {
  const error = Object.hasOwn(value ?? {}, "errorCode"),
    row = exact(
      value,
      error
        ? ["requestId", "errorCode"]
        : ["requestId", "rawSha256", "rawBytes"],
    );
  if (
    typeof row.requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      row.requestId,
    )
  )
    deny();
  if (error) {
    if (
      !(STORE_PREPARE_FAILURE_CODES as readonly unknown[]).includes(
        row.errorCode,
      )
    )
      deny();
  } else if (
    typeof row.rawSha256 !== "string" ||
    !HASH.test(row.rawSha256) ||
    !Number.isSafeInteger(row.rawBytes) ||
    (row.rawBytes as number) < 1 ||
    (row.rawBytes as number) > 16384
  )
    deny();
  return row;
}
/** Only this actual Node role factory can mint instances. It retains a private
 * inherited capability and registers actual OS spawned helper PIDs before boot.
 * Native independently proves the live creator, fixed JS role and actual Job. */
interface NativeOpening {
  ready?: Promise<WindowsConsumerNative>;
  transport?: Awaited<ReturnType<typeof createStoreConsumerNativeTransport>>;
  retirement?: Promise<void>;
  failure?: unknown;
  transfer?: StoreFleetTransferChild;
}
interface PrivateWriteOwner {
  ready?: Promise<void>;
  file?: PrivateWritable;
  closing?: Promise<void>;
  failure?: unknown;
}
export class StoreNodeIssuer {
  static #owners = new Set<StoreNodeIssuer>();
  static #failedOpenRetirement: Promise<void> | undefined;
  #failedOpen = false;
  #cpuMode: boolean;
  #closed = false;
  #ending = false;
  #closing?: Promise<void>;
  #recoveringClose: Promise<void> | undefined;
  #closeFailures: Promise<void>[] = [];
  #dispatchScopes = new Set<{
    native: StoreRoleNative;
    received: StoreControlReceived;
  }>();
  #bootstrap: StoreNodeBootstrap;
  #nodeCapability: string;
  #nodeAttempts = 0;
  #nodeQueue: Promise<void> = Promise.resolve();
  #nodeRotation: { previous: string; nonce: string } | undefined;
  #helperPin: { bytes: number; sha256: string };
  #helperPath: string;
  #sockets = new Set<Socket>();
  #helpers = new Set<WindowsConsumerNative>();
  #openingHelpers = new Set<NativeOpening>();
  #children = new Set<StorePersonalEngineChild | StoreFixedToolChild>();
  #media = new Set<StoreMediaExecution>();
  #privateWrites = new Set<PrivateWriteOwner>();
  #fleetAttempts = new Map<string, StoreFleetAttemptLease>();
  #fleetTransfers = new Map<string, StoreFleetTransferChild>();
  #first: WindowsConsumerNative | undefined;
  #receipt: StoreBootReceipt | undefined;
  #owner: ConsumerOwnedProcess | undefined;
  #inventory: StoreCodeInventory;
  readonly workerRoot: string;
  readonly inventorySha256: string;
  private constructor(
    token: symbol,
    bootstrap: StoreNodeBootstrap,
    workerRoot: string,
    inventorySha256: string,
    inventory: StoreCodeInventory,
    helperPin: { bytes: number; sha256: string },
  ) {
    if (token !== TOKEN) deny();
    this.#bootstrap = bootstrap;
    this.#cpuMode =
      bootstrap.role === "prepare" && process.argv[2] === "--store-cpu";
    this.#nodeCapability = bootstrap.capability;
    this.workerRoot = workerRoot;
    this.inventorySha256 = inventorySha256;
    this.#inventory = inventory;
    this.#helperPin = Object.freeze(helperPin);
    this.#helperPath = win32.join(
      workerRoot,
      "runtime",
      "native",
      "musicmute-native.exe",
    );
    Object.freeze(this);
  }
  static async open(): Promise<StoreNodeIssuer> {
    if (
      arguments.length !== 0 ||
      process.platform !== "win32" ||
      process.arch !== "x64" ||
      process.argv.length !== 3 ||
      (process.argv[2] !== "--store-session" &&
        process.argv[2] !== "--store-cpu")
    )
      deny();
    const bootstrap = await inheritedBootstrap(),
      workerRoot = win32.dirname(
        win32.dirname(win32.dirname(process.execPath)),
      ),
      expectedNode = win32.join(workerRoot, "runtime", "node", "node.exe"),
      entryName =
        bootstrap.role === "session-agent" ? "session-agent" : bootstrap.role;
    if (process.argv[2] === "--store-cpu" && bootstrap.role !== "prepare")
      deny();
    if (
      process.execPath.toLowerCase() !== expectedNode.toLowerCase() ||
      (process.argv[1] ?? "").toLowerCase() !==
        win32.join(workerRoot, "agent", `${entryName}.cjs`).toLowerCase()
    )
      deny();
    const indexBytes = await readStoreProtectedBytes(
        win32.join(win32.dirname(workerRoot), "store-code-inventory.json"),
        8 * 1024 ** 2,
      ),
      index = parseStoreNodeInventory(indexBytes);
    const helper = index.entries.find(
      (entry) => entry.path === "worker/runtime/native/musicmute-native.exe",
    );
    if (!helper || helper.bytes < 1) deny();
    const result = new StoreNodeIssuer(
      TOKEN,
      bootstrap,
      workerRoot,
      createHash("sha256").update(indexBytes).digest("hex"),
      index,
      { bytes: helper.bytes, sha256: helper.sha256 },
    );
    // Retain the actual issuer before its first Creator/native helper IO.
    // A rejected factory with uncertain original cleanup must remain owned.
    StoreNodeIssuer.#owners.add(result);
    try {
      const reply = exact(await result.#exchange("node-bind"), [
        "version",
        "accepted",
        "request_nonce",
        "role",
        "pid",
        "creation_time",
      ]);
      if (
        reply.version !== 1 ||
        reply.accepted !== true ||
        role(reply.role) !== bootstrap.role ||
        pid(reply.pid) !== process.pid
      )
        deny();
      birth(reply.creation_time);
      // No instance is returned until the genuine native Store role and shared
      // namespace bootstrap have actually succeeded. Creator JSON alone is not
      // an accepted authority or a usable runtime.
      result.#first = await result.#openNative();
      return result;
    } catch (error) {
      result.#failedOpen = true;
      try {
        await result.close();
      } catch (cleanup) {
        throw new Error("CHILD_SHUTDOWN_PENDING", {
          cause: new AggregateError(
            [error, cleanup],
            "STORE_ISSUER_OPEN_CLEANUP_PENDING",
          ),
        });
      }
      throw error;
    }
  }
  /** Cleanup only: never returns an issuer or grants failed admission rights. */
  static retireFailedOpen(): Promise<void> {
    if (arguments.length !== 0)
      return Promise.reject(new Error("STORE_NODE_ISSUER_DENIED"));
    this.#failedOpenRetirement ??= (async () => {
      const retired = await Promise.allSettled(
        [...StoreNodeIssuer.#owners]
          .filter((owner) => owner.#failedOpen)
          .map((owner) =>
            owner.#closing
              ? StoreNodeIssuer.prototype.recoverClose.call(owner)
              : StoreNodeIssuer.prototype.close.call(owner),
          ),
      );
      const failure = retired.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })().finally(() => {
      StoreNodeIssuer.#failedOpenRetirement = undefined;
    });
    void this.#failedOpenRetirement.catch(() => {});
    return this.#failedOpenRetirement;
  }
  get nodeRole(): StoreNodeRole {
    return this.#bootstrap.role;
  }
  get receipt(): StoreBootReceipt {
    if (!this.#receipt || this.#closed) deny();
    return this.#receipt;
  }
  /** Observed owner data from this live creator-bound helper. It cannot be
   * supplied to the factory or replace native role/Job authority. */
  get owner(): ConsumerOwnedProcess {
    if (!this.#owner || this.#closed) deny();
    return this.#owner;
  }
  #ownedNative(native: object): StoreRoleNative {
    if (this.#ending) deny();
    return this.#ownedCleanupNative(native);
  }
  #ownedCleanupNative(native: object): StoreRoleNative {
    if (
      this.#closed ||
      !(native instanceof StoreRoleNative) ||
      !this.#helpers.has(native)
    )
      deny();
    return native;
  }
  async requestControl(
    target: "session" | "personal" | "fleet",
    payload: Uint8Array,
    signal: AbortSignal = AbortSignal.timeout(70000),
    expectedTarget?: ConsumerOwnedProcess,
  ): Promise<Buffer> {
    if (arguments.length < 2 || arguments.length > 4) deny();
    const native = this.#ownedNative(await this.openNative());
    const result =
      target !== "session"
        ? await this.requestControlWithNative(
            native,
            target,
            payload,
            signal,
            expectedTarget,
          )
        : await this.requestControlWithNative(native, target, payload, signal);
    await native.close();
    return result;
  }
  /** A live issuer accepts only its exact privately held helper. The caller
   * retains that real transport until positive helper cleanup, including any
   * uncertain request; JSON, a base SDK or an injected transport cannot bind. */
  async requestControlWithNative(
    nativeInput: object,
    target: "session" | "personal" | "fleet",
    payload: Uint8Array,
    signal: AbortSignal = AbortSignal.timeout(70000),
    expectedTarget?: ConsumerOwnedProcess,
  ): Promise<Buffer> {
    const native = this.#ownedNative(nativeInput);
    if (
      (target !== "session" && target !== "personal" && target !== "fleet") ||
      !(payload instanceof Uint8Array) ||
      payload.byteLength < 1 ||
      payload.byteLength > 4096 ||
      !(signal instanceof AbortSignal) ||
      this.#ending
    )
      deny();
    if (target !== "session") {
      if (
        arguments.length !== 5 ||
        this.nodeRole !== "session-agent" ||
        !expectedTarget
      )
        deny();
      const owner = exact(expectedTarget, ["role", "nonce", "identity"]);
      const peer = exact(owner.identity, [
        "sid",
        "sessionId",
        "pid",
        "creationTime",
      ]);
      const identity = processIdentityFromWire({
        sid: peer.sid,
        session_id: peer.sessionId,
        pid: peer.pid,
        creation_time: peer.creationTime,
      });
      if (
        owner.role !== target ||
        typeof owner.nonce !== "string" ||
        !HASH.test(owner.nonce) ||
        identity.sid !== this.owner.identity.sid ||
        identity.sessionId !== this.owner.identity.sessionId ||
        sameConsumerProcess(identity, this.owner.identity)
      )
        deny();
      expectedTarget = Object.freeze({
        role: target,
        nonce: owner.nonce,
        identity: Object.freeze(identity),
      });
    } else if (
      expectedTarget !== undefined ||
      arguments.length > 4 ||
      !["personal", "fleet"].includes(this.nodeRole)
    )
      deny();
    signal.throwIfAborted();
    const requestId = randomUUID();
    // The exact helper stays retained on an uncertain native ACK/dispatch.
    // Closing the role still joins this original helper through #helpers.
    for (;;) {
      signal.throwIfAborted();
      const result = await StoreRoleNative.prototype.controlRequest.call(
        native,
        requestId,
        target,
        payload,
        expectedTarget,
      );
      signal.throwIfAborted();
      if (result === null) continue;
      await StoreRoleNative.prototype.controlAck.call(native, requestId);
      return result;
    }
  }
  async serveControl(
    dispatcher: SessionDispatcher,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      !(signal instanceof AbortSignal) ||
      !dispatcher ||
      typeof dispatcher.dispatch !== "function" ||
      !["session-agent", "personal", "fleet"].includes(this.nodeRole) ||
      this.#ending
    )
      deny();
    const handlers = new Set<Promise<void>>(),
      servers = new Set<StoreRoleNative>();
    let deliveryFailure: unknown;
    let loopFailure: unknown;
    const abort = () => {
      for (const server of servers) void server.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (!signal.aborted) {
        if (deliveryFailure !== undefined) throw deliveryFailure;
        if (handlers.size >= 8) {
          await Promise.race(handlers);
          continue;
        }
        const server = this.#ownedNative(await this.openNative());
        servers.add(server);
        if (signal.aborted) {
          servers.delete(server);
          await server.close();
          break;
        }
        let received: StoreControlReceived | null;
        try {
          received = await StoreRoleNative.prototype.controlAccept.call(server);
        } catch (error) {
          servers.delete(server);
          await server.close();
          if (signal.aborted) break;
          throw error;
        }
        if (!received) {
          servers.delete(server);
          await server.close();
          continue;
        }
        let handler!: Promise<void>;
        const scope = { native: server, received };
        this.#dispatchScopes.add(scope);
        handler = (async () => {
          try {
            const response = await dispatcher.dispatch(
              received.payload,
              received.peer,
            );
            const delivered = await StoreRoleNative.prototype.controlReply.call(
              server,
              received,
              response,
            );
            if (delivered) dispatcher.afterReply?.(received.payload);
          } finally {
            this.#dispatchScopes.delete(scope);
            servers.delete(server);
            await server.close();
            handlers.delete(handler);
          }
        })();
        handlers.add(handler);
        // The genuine Node must stop on a failed delivery; it cannot report
        // success or silently leave an unknown command owner behind.
        void handler.catch((error: unknown) => {
          deliveryFailure = error;
          abort();
        });
      }
    } catch (error) {
      loopFailure = error;
    } finally {
      signal.removeEventListener("abort", abort);
      abort();
      const retired = await Promise.allSettled(handlers);
      const failure = retired.find((row) => row.status === "rejected");
      if (failure?.status === "rejected") deliveryFailure ??= failure.reason;
    }
    if (loopFailure !== undefined) throw loopFailure;
    if (deliveryFailure !== undefined) throw deliveryFailure;
  }
  async verifyControlPeer(
    peer: ConsumerProcessIdentity,
    kind: "gui" | "chrome" | "session-agent" | "personal" | "fleet",
  ): Promise<boolean> {
    if (
      arguments.length !== 2 ||
      this.#ending ||
      !["gui", "chrome", "session-agent", "personal", "fleet"].includes(kind)
    )
      deny();
    const actual = processIdentityFromWire(processIdentityToWire(peer));
    for (const scope of this.#dispatchScopes) {
      if (!sameConsumerProcess(scope.received.peer, actual)) continue;
      this.#ownedNative(scope.native);
      return StoreRoleNative.prototype.controlPeer.call(
        scope.native,
        scope.received.token,
        actual,
        kind,
      );
    }
    deny();
  }
  /** Verify this exact genuine issuer's live helper, never a borrowed base SDK
   * object, supplied transport, receipt or structural lookalike. */
  assertNative(native: object): void {
    if (arguments.length !== 1) deny();
    this.#ownedNative(native);
  }
  async writeNewPrivateFile(
    nativeInput: object,
    relative: string,
    bytes: Uint8Array,
  ): Promise<void> {
    if (
      arguments.length !== 3 ||
      !["personal", "prepare", "fleet"].includes(this.nodeRole) ||
      this.#ending ||
      this.#closed ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 1024 ** 2 ||
      typeof relative !== "string" ||
      !(
        this.nodeRole === "fleet"
          ? /^fleet\\engine-session\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\engine-config\.json$/u
          : /^(?:(?:cloud\\work\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\(?:store-tool-config|media-result|doctor-result|youtube-check-result)\.json)|(?:prepare\\work\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\(?:store-tool-config|store-qualification-request|store-benchmark-config|silence-map)\.json)|(?:prepare\\results\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json))$/u
      ).test(relative)
    )
      deny();
    const native = this.#ownedNative(nativeInput),
      payload = Buffer.from(bytes);
    const owner: PrivateWriteOwner = {};
    this.#privateWrites.add(owner);
    owner.ready = (async () => {
      const errors: unknown[] = [];
      try {
        owner.file = await native.openPrivateFile(
          relative,
          "create-new",
          payload.byteLength,
        );
        let position = 0;
        while (position < payload.byteLength) {
          if (this.#ending) deny();
          const count = await owner.file.write(
            payload,
            position,
            Math.min(24576, payload.byteLength - position),
            position,
          );
          if (
            !Number.isSafeInteger(count.bytesWritten) ||
            count.bytesWritten < 1 ||
            count.bytesWritten > Math.min(24576, payload.byteLength - position)
          )
            deny();
          position += count.bytesWritten;
        }
        await owner.file.sync();
        if ((await owner.file.info()).bytes !== payload.byteLength) deny();
      } catch (error) {
        owner.failure = error;
        errors.push(error);
      } finally {
        payload.fill(0);
      }
      if (owner.file) {
        owner.closing ??= owner.file.close();
        try {
          await owner.closing;
          this.#privateWrites.delete(owner);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 1)
        throw new AggregateError(errors, "STORE_PRIVATE_WRITE_CLEANUP_PENDING");
      if (errors.length) throw errors[0];
    })();
    void owner.ready.catch(() => {});
    return owner.ready;
  }
  async cpuOperationOpen(
    native: WindowsConsumerNative,
    args: {
      request_id: string;
      incarnation: string;
      operation: string;
      configuration_sha256: string;
    },
    recovery: boolean,
  ) {
    if (arguments.length !== 3 || typeof recovery !== "boolean") deny();
    return StoreRoleNative.prototype.cpuOperationOpen.call(
      this.#ownedNative(native),
      args,
      recovery,
    );
  }
  async cpuOperationBindData(
    native: WindowsConsumerNative,
    token: string,
  ): Promise<void> {
    if (arguments.length !== 2) deny();
    await StoreRoleNative.prototype.cpuOperationBindData.call(
      this.#ownedNative(native),
      token,
    );
  }
  async cpuOperationInspect(
    native: WindowsConsumerNative,
    expectation: import("../../shared/store-cpu-operation.js").StoreCpuOperationExpectation,
  ) {
    if (arguments.length !== 2) deny();
    return StoreRoleNative.prototype.cpuOperationInspect.call(
      this.#ownedCleanupNative(native),
      expectation,
    );
  }
  async cpuOperationRetire(native: WindowsConsumerNative, token: string) {
    if (arguments.length !== 2) deny();
    return StoreRoleNative.prototype.cpuOperationRetire.call(
      this.#ownedCleanupNative(native),
      token,
    );
  }
  async openMedia(
    host: HostContext,
    configuration: StoreMediaConfiguration,
  ): Promise<StoreMediaExecution> {
    if (
      arguments.length !== 2 ||
      this.#ending ||
      this.#closed ||
      (this.nodeRole !== "personal" && this.nodeRole !== "prepare")
    )
      deny();
    StoreNodeIssuer.prototype.assertNative.call(this, host.native);
    const { StoreMediaExecution } = await import("./store-media-runner.js");
    const execution = await StoreMediaExecution.open(host, this, configuration);
    this.#media.add(execution);
    return execution;
  }
  mediaRetired(execution: StoreMediaExecution): void {
    if (
      arguments.length !== 1 ||
      !this.#media.has(execution) ||
      !execution.closedForIssuer(this)
    )
      deny();
    this.#media.delete(execution);
  }
  async runMedia(
    host: HostContext,
    configuration: StoreMediaConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      arguments.length !== 3 ||
      !(signal instanceof AbortSignal) ||
      this.#ending ||
      this.#closed ||
      (this.nodeRole !== "personal" && this.nodeRole !== "prepare")
    )
      deny();
    StoreNodeIssuer.prototype.assertNative.call(this, host.native);
    signal.throwIfAborted();
    const { StoreMediaExecution } = await import("./store-media-runner.js");
    const execution = await StoreNodeIssuer.prototype.openMedia.call(
      this,
      host,
      configuration,
    );
    try {
      signal.throwIfAborted();
      await StoreMediaExecution.prototype.run.call(execution, signal);
    } finally {
      await StoreMediaExecution.prototype.close.call(execution);
    }
  }
  async createFixedTool(
    kind: StoreFixedToolKind,
    requestId: string,
    configurationSha256: string,
    operation: StoreCpuOperation,
  ): Promise<StoreFixedToolChild> {
    if (
      arguments.length !== 4 ||
      this.#ending ||
      this.#closed ||
      typeof configurationSha256 !== "string" ||
      !HASH.test(configurationSha256) ||
      (this.nodeRole !== "personal" && this.nodeRole !== "prepare")
    )
      deny();
    assertStoreFixedTool(kind, requestId);
    const token = StoreCpuOperation.prototype.tokenForIssuer.call(
        operation,
        this,
      ),
      expected = StoreCpuOperation.prototype.expectation.call(operation);
    if (
      expected.requestId !== requestId ||
      expected.configurationSha256 !== configurationSha256
    )
      deny();
    // This is a synchronous no-IO construction inside the async API. Helpers
    // and the actual child are admitted only by start(), after this retained
    // genuine child object has been returned and registered.
    const child = new StoreFixedToolChild(
      TOKEN,
      this,
      kind,
      requestId,
      configurationSha256,
      token,
    );
    this.#children.add(child);
    return child;
  }
  async createPersonalEngine(
    relative: string,
  ): Promise<StorePersonalEngineChild> {
    if (
      arguments.length !== 1 ||
      this.nodeRole !== "personal" ||
      typeof relative !== "string" ||
      !/^personal\\engine-session\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\engine-config\.json$/u.test(
        relative,
      )
    )
      deny();
    const writer = this.#ownedNative(await this.openNative()),
      reader = this.#ownedNative(await this.openNative());
    const child = new StorePersonalEngineChild(
      TOKEN,
      this,
      writer,
      reader,
      relative,
    );
    this.#children.add(child);
    return child;
  }
  async benchmarkRequest(native: object): Promise<StoreBenchmarkRequest> {
    if (arguments.length !== 1 || this.nodeRole !== "prepare") deny();
    return StoreRoleNative.prototype.benchmarkRequest.call(
      this.#ownedNative(native),
    );
  }
  async createBenchmark(): Promise<StoreFixedToolChild> {
    if (
      arguments.length ||
      this.nodeRole !== "prepare" ||
      this.#ending ||
      this.#closed ||
      this.#children.size >= 16
    )
      deny();
    const child = new StoreFixedToolChild(
      TOKEN,
      this,
      "benchmark",
      randomUUID(),
      undefined,
    );
    this.#children.add(child);
    return child;
  }
  async publishBenchmarkResult(
    native: object,
    input:
      | Readonly<{
          requestId: string;
          configurationSha256: string;
          rawBytes: number;
          rawSha256: string;
          wallSeconds_json: string;
        }>
      | Readonly<{
          requestId: string;
          errorCode: (typeof STORE_PREPARE_FAILURE_CODES)[number];
        }>,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      this.nodeRole !== "prepare" ||
      !input ||
      typeof input !== "object" ||
      types.isProxy(input)
    )
      deny();
    const row = storeCpuFields(
      input,
      "errorCode" in input
        ? ["requestId", "errorCode"]
        : [
            "requestId",
            "configurationSha256",
            "rawBytes",
            "rawSha256",
            "wallSeconds_json",
          ],
    );
    uuid(row.requestId);
    if (
      "errorCode" in row &&
      !STORE_PREPARE_FAILURE_CODES.some((code) => code === row.errorCode)
    )
      deny();
    await StoreRoleNative.prototype.benchmarkResult.call(
      this.#ownedNative(native),
      row,
    );
  }
  async createQualification(): Promise<StoreFixedToolChild> {
    if (
      arguments.length ||
      this.#ending ||
      this.#closed ||
      this.nodeRole !== "prepare"
    )
      deny();
    const child = new StoreFixedToolChild(
      TOKEN,
      this,
      "qualification",
      randomUUID(),
      undefined,
    );
    this.#children.add(child);
    return child;
  }
  async openFleetAttempt(
    nativeInput: object,
    attemptId: string,
    extension: string,
  ): Promise<StoreFleetAttemptLease> {
    if (
      arguments.length !== 3 ||
      this.nodeRole !== "fleet" ||
      this.#ending ||
      this.#closed ||
      typeof attemptId !== "string" ||
      typeof extension !== "string"
    )
      deny();
    const native = this.#ownedNative(nativeInput),
      original = this.#fleetAttempts.get(attemptId);
    if (original) {
      if (
        !StoreFleetAttemptLease.prototype.matches.call(
          original,
          this,
          native,
          attemptId,
          extension,
        )
      )
        deny();
      try {
        await StoreFleetAttemptLease.prototype.prepare.call(original);
      } catch {
        await StoreFleetAttemptLease.prototype.recoverOpen.call(original);
      }
      return original;
    }
    if (this.#fleetAttempts.size >= 4096) deny();
    const lease = StoreFleetAttemptLease.create(
      this,
      native,
      attemptId,
      extension,
    );
    this.#fleetAttempts.set(attemptId, lease);
    await StoreFleetAttemptLease.prototype.prepare.call(lease);
    return lease;
  }
  async fleetWorkspaceCommand(
    lease: StoreFleetAttemptLease,
    operation: "open" | "recover" | "inspect" | "retire",
  ): Promise<unknown> {
    if (
      arguments.length !== 2 ||
      this.nodeRole !== "fleet" ||
      this.#closed ||
      !["open", "recover", "inspect", "retire"].includes(operation)
    )
      deny();
    const request = StoreFleetAttemptLease.prototype.requestForIssuer.call(
      lease,
      this,
    );
    if (
      this.#fleetAttempts.get(request.attempt_id) !== lease ||
      (operation === "open" && this.#ending)
    )
      deny();
    const originalNative =
      StoreFleetAttemptLease.prototype.nativeForIssuer.call(lease, this);
    const native =
      operation === "open"
        ? this.#ownedNative(originalNative)
        : this.#ownedCleanupNative(originalNative);
    return StoreRoleNative.prototype.fleetWorkspaceOperation.call(
      native,
      operation,
      operation === "open" || operation === "recover"
        ? request
        : {
            expectation:
              StoreFleetAttemptLease.prototype.expectationForIssuer.call(
                lease,
                this,
              ),
          },
    );
  }
  async createFleetTransfer(
    input: Readonly<{
      requestId: string;
      operation: "download" | "upload";
      attemptId: string;
      relativePath: string;
    }>,
  ): Promise<StoreFleetTransferChild> {
    if (
      arguments.length !== 1 ||
      this.nodeRole !== "fleet" ||
      this.#ending ||
      this.#closed
    )
      deny();
    const row = storeCpuFields(input, [
      "requestId",
      "operation",
      "attemptId",
      "relativePath",
    ]);
    if (
      (row.operation !== "download" && row.operation !== "upload") ||
      typeof row.attemptId !== "string" ||
      uuid(row.attemptId) !== row.attemptId ||
      typeof row.relativePath !== "string"
    )
      deny();
    const lease = this.#fleetAttempts.get(row.attemptId);
    if (
      !lease ||
      StoreFleetAttemptLease.prototype.retiredForIssuer.call(lease, this)
    )
      deny();
    const request = StoreFleetAttemptLease.prototype.requestForIssuer.call(
      lease,
      this,
    );
    if (
      row.relativePath !==
      `work\\${row.attemptId}\\${row.operation === "download" ? `input.${request.extension}` : "output\\vocals.mp3"}`
    )
      deny();
    uuid(row.requestId);
    const key = `${row.attemptId}:${row.operation}:${row.requestId}`,
      original = this.#fleetTransfers.get(key);
    if (original) {
      if (
        !StoreFleetTransferChild.prototype.matches.call(original, this, input)
      )
        deny();
      return original;
    }
    if (
      [...this.#fleetTransfers.values()].some((child) =>
        StoreFleetTransferChild.prototype.blocksAttempt.call(
          child,
          this,
          row.attemptId as string,
        ),
      )
    )
      deny();
    if (this.#fleetTransfers.size >= 4096) deny();
    const child = new StoreFleetTransferChild(
      TOKEN,
      this,
      Object.freeze({
        requestId: row.requestId as string,
        operation: row.operation,
        attemptId: row.attemptId,
        relativePath: row.relativePath,
      }),
      lease,
    );
    this.#fleetTransfers.set(key, child);
    return child;
  }
  openTransferNative(
    child: StoreFleetTransferChild,
  ): Promise<WindowsConsumerNative> {
    if (
      arguments.length !== 1 ||
      this.#ending ||
      this.#closed ||
      ![...this.#fleetTransfers.values()].includes(child)
    )
      return Promise.reject(new Error("STORE_FLEET_TRANSFER_DENIED"));
    return this.#openNative(child);
  }
  async retireTransferOpenings(
    child: StoreFleetTransferChild,
    recovery: boolean,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      ![...this.#fleetTransfers.values()].includes(child) ||
      typeof recovery !== "boolean"
    )
      deny();
    const results = await Promise.allSettled(
      [...this.#openingHelpers]
        .filter((owner) => owner.transfer === child)
        .map(async (owner) => {
          await owner.ready?.catch(() => {});
          if (!this.#openingHelpers.has(owner)) return;
          if (!owner.transport)
            throw (
              owner.failure ?? new Error("STORE_FLEET_TRANSFER_CLEANUP_PENDING")
            );
          if (recovery) owner.retirement = owner.transport.close();
          else owner.retirement ??= owner.transport.close();
          await owner.retirement;
          this.#openingHelpers.delete(owner);
        }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async createFleetEngine(
    relative: string,
    onStage?: (stage: "loading" | "warming") => void,
  ): Promise<StorePersonalEngineChild> {
    if (
      arguments.length < 1 ||
      arguments.length > 2 ||
      this.nodeRole !== "fleet" ||
      this.#ending ||
      this.#closed ||
      typeof relative !== "string" ||
      !/^fleet\\engine-session\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\engine-config\.json$/u.test(
        relative,
      ) ||
      (onStage !== undefined && typeof onStage !== "function")
    )
      deny();
    const writer = this.#ownedNative(await this.openNative()),
      reader = this.#ownedNative(await this.openNative());
    const child = new StorePersonalEngineChild(
      TOKEN,
      this,
      writer,
      reader,
      relative,
      onStage,
    );
    this.#children.add(child);
    return child;
  }
  /** Removes only a real originally registered child after its actual stop
   * joined the original child Job and both helper retirements. */
  childRetired(child: StorePersonalEngineChild | StoreFixedToolChild): void {
    if (arguments.length !== 1 || !this.#children.has(child)) deny();
    const closed =
      child instanceof StoreFixedToolChild
        ? StoreFixedToolChild.prototype.closedForIssuer.call(child, this)
        : StorePersonalEngineChild.prototype.closedForIssuer.call(child, this);
    if (!closed) deny();
    this.#children.delete(child);
  }
  /** The exact held singleton helper must publish; opening a replacement
   * helper cannot borrow the original helper's mutex/namespace ownership. */
  async publishSession(native: WindowsConsumerNative): Promise<void> {
    if (arguments.length !== 1 || this.nodeRole !== "session-agent") deny();
    await StoreRoleNative.prototype.publishSession.call(
      this.#ownedNative(native),
    );
  }
  async retireSessionChildren(native: WindowsConsumerNative): Promise<void> {
    if (arguments.length !== 1 || this.nodeRole !== "session-agent") deny();
    await StoreRoleNative.prototype.retireSessionChildren.call(
      this.#ownedCleanupNative(native),
    );
  }
  async prepareRequest(
    native: WindowsConsumerNative,
  ): Promise<StorePrepareLaunchRequest> {
    if (arguments.length !== 1 || this.nodeRole !== "prepare" || this.#cpuMode)
      deny();
    const request = await StoreRoleNative.prototype.prepareRequest.call(
      this.#ownedNative(native),
    );
    const view = await this.codeView();
    const expected = view.binding,
      actual = request.binding;
    if (
      actual.inventorySha256 !== expected.inventorySha256 ||
      actual.runtimeManifestSha256 !== expected.runtimeManifestSha256 ||
      actual.sid !== expected.sid ||
      actual.bootIdentity !== expected.bootIdentity ||
      JSON.stringify(parseStoreInstalledPackage("worker", actual.package)) !==
        JSON.stringify(expected.package) ||
      (["kim-vocals-v2", "kim-vocals-v2-trim"] as const).some(
        (id) => actual.recipeDigests[id] !== expected.recipeDigests[id],
      )
    )
      deny();
    return request;
  }
  async publishPrepareResult(
    native: WindowsConsumerNative,
    value: StorePreparePublication,
  ): Promise<void> {
    if (arguments.length !== 2 || this.nodeRole !== "prepare" || this.#cpuMode)
      deny();
    await StoreRoleNative.prototype.publishPrepareResult.call(
      this.#ownedNative(native),
      value,
    );
  }
  async cpuPrepareRequest(
    native: WindowsConsumerNative,
  ): Promise<StoreMediaRequest> {
    if (arguments.length !== 1 || this.nodeRole !== "prepare" || !this.#cpuMode)
      deny();
    const request = await StoreRoleNative.prototype.cpuPrepareRequest.call(
      this.#ownedNative(native),
    );
    const view = await this.codeView();
    if (JSON.stringify(request.binding) !== JSON.stringify(view.binding))
      deny();
    return request;
  }
  async publishCpuPrepareReady(
    native: WindowsConsumerNative,
    value: { requestId: string; expectation: StoreCpuOperationExpectation },
  ): Promise<void> {
    if (arguments.length !== 2 || this.nodeRole !== "prepare" || !this.#cpuMode)
      deny();
    await StoreRoleNative.prototype.publishCpuPrepareReady.call(
      this.#ownedNative(native),
      value,
    );
  }
  async waitCpuPrepareStart(native: WindowsConsumerNative): Promise<boolean> {
    if (arguments.length !== 1 || this.nodeRole !== "prepare" || !this.#cpuMode)
      deny();
    return StoreRoleNative.prototype.waitCpuPrepareStart.call(
      this.#ownedNative(native),
    );
  }
  async publishCpuPrepareResult(
    native: WindowsConsumerNative,
    value: StoreCpuPreparePublication,
  ): Promise<void> {
    if (arguments.length !== 2 || this.nodeRole !== "prepare" || !this.#cpuMode)
      deny();
    await StoreRoleNative.prototype.publishCpuPrepareResult.call(
      this.#ownedNative(native),
      value,
    );
  }
  assertChildrenRetired(native: WindowsConsumerNative): void {
    if (
      arguments.length !== 1 ||
      this.nodeRole !== "prepare" ||
      this.#children.size ||
      this.#media.size
    )
      deny();
    this.#ownedNative(native);
  }
  /** This live actor revalidates its native held code/generation on both sides
   * of the fixed protected read. The returned view is data, never a launcher. */
  async codeView(): Promise<StoreNodeCodeView> {
    if (arguments.length !== 0 || this.#closed || !this.#receipt) deny();
    const native = await this.openNative();
    try {
      const identity = await native.identity(),
        bootIdentity = await native.bootIdentity();
      if (
        identity.sid !== this.#receipt.parent.sid ||
        identity.sessionId !== this.#receipt.parent.sessionId
      )
        deny();
      const bytes = await readStoreProtectedBytes(
          win32.join(this.workerRoot, "release-manifest.json"),
          8 * 1024 ** 2,
        ),
        manifest = parseStoreNodeManifestBytes(
          bytes,
          this.#inventory,
          this.#receipt.package,
          this.inventorySha256,
        );
      await native.identity();
      if ((await native.bootIdentity()) !== bootIdentity) deny();
      return Object.freeze({
        binding: Object.freeze({
          package: this.#receipt.package,
          inventorySha256: this.inventorySha256,
          runtimeManifestSha256: createHash("sha256")
            .update(bytes)
            .digest("hex"),
          sid: identity.sid,
          bootIdentity,
          recipeDigests: Object.freeze({ ...PERSONAL_RECIPE_DIGESTS }),
        }),
        manifest,
      });
    } finally {
      await native.close();
    }
  }
  async openNative(): Promise<WindowsConsumerNative> {
    if (arguments.length !== 0 || this.#closed || this.#ending) deny();
    if (this.#first) {
      const first = this.#first;
      this.#first = undefined;
      return first;
    }
    return this.#openNative();
  }
  #openNative(
    transfer?: StoreFleetTransferChild,
  ): Promise<WindowsConsumerNative> {
    if (
      this.#closed ||
      this.#ending ||
      this.#helpers.size + this.#openingHelpers.size >= 16
    )
      return Promise.reject(new Error("STORE_NODE_ISSUER_DENIED"));
    const owner: NativeOpening = transfer ? { transfer } : {};
    this.#openingHelpers.add(owner);
    const pending = this.#constructNative(owner);
    owner.ready = pending;
    void pending.catch(() => undefined);
    return pending;
  }
  async #constructNative(opening: NativeOpening) {
    if (this.#closed || this.#ending) deny();
    let transport:
      | Awaited<ReturnType<typeof createStoreConsumerNativeTransport>>
      | undefined;
    try {
      transport = await createStoreConsumerNativeTransport(
        this.#helperPath,
        this.#helperPin.sha256,
      );
      opening.transport = transport;
      const actualPid = pid(transport.spawnedProcessId),
        registration = exact(
          await this.#exchange("register-helper", actualPid),
          [
            "version",
            "accepted",
            "request_nonce",
            "pid",
            "creation_time",
            "capability",
            "creator_pid",
            "creator_creation_time",
            "creator_channel",
            "role",
          ],
        );
      if (
        registration.version !== 1 ||
        registration.accepted !== true ||
        pid(registration.pid) !== actualPid ||
        pid(registration.creator_pid) !== this.#bootstrap.creator_pid ||
        birth(registration.creator_creation_time) !==
          this.#bootstrap.creator_creation_time ||
        secret(registration.creator_channel) !==
          this.#bootstrap.creator_channel ||
        role(registration.role) !== this.nodeRole
      )
        deny();
      const helperBirth = birth(registration.creation_time),
        raw = await transport.request(
          "store_boot",
          {
            role: "worker",
            parent_role: "worker-node",
            creator_pid: this.#bootstrap.creator_pid,
            creator_creation_time: this.#bootstrap.creator_creation_time,
            creator_channel: this.#bootstrap.creator_channel,
            creator_capability: secret(registration.capability),
          },
          35000,
        ),
        receipt = parseStoreBootReceipt("worker", raw, process.pid, actualPid);
      if (
        receipt.helper.creationTime !== helperBirth ||
        (this.#receipt &&
          (this.#receipt.package.fullName !== receipt.package.fullName ||
            this.#receipt.parent.creationTime !== receipt.parent.creationTime))
      )
        deny();
      const namespace = exact(
        await transport.request("store_private_boot", {}),
        ["authorized", "namespace"],
      );
      if (
        namespace.authorized !== true ||
        namespace.namespace !== "unvirtualized-v1"
      )
        deny();
      if (this.nodeRole === "login-worker") deny();
      const owner = parseStoreRoleOwner(
        await transport.request("store_role_owner", {}),
        receipt,
        this.nodeRole,
        this.inventorySha256,
      );
      if (
        this.#owner &&
        (this.#owner.nonce !== owner.nonce ||
          !sameConsumerProcess(this.#owner.identity, owner.identity))
      )
        deny();
      if (this.#closed || this.#ending) deny();
      const helper = new StoreRoleNative(
        TOKEN,
        transport,
        receipt,
        owner,
        this.inventorySha256,
        this,
        (native) => this.#helpers.delete(native),
      );
      this.#helpers.add(helper);
      this.#receipt ??= receipt;
      this.#owner ??= owner;
      this.#openingHelpers.delete(opening); // ownership transferred to #helpers
      return helper;
    } catch (error) {
      opening.failure = error;
      if (transport) {
        opening.retirement ??= transport.close();
        await opening.retirement;
        this.#openingHelpers.delete(opening);
      }
      // A rejected factory without a published actual transport has no
      // independent cleanup proof here. Keep that original failure reachable.
      throw error;
    }
  }
  #exchange(
    operation: "node-bind" | "register-helper",
    child?: number,
  ): Promise<unknown> {
    const previous = this.#nodeQueue;
    const current = previous.then(async () => {
      if (this.#closed || this.#ending) deny();
      if (operation === "register-helper") await this.#rotateNodeIfNeeded();
      // Count before any IO. A lost ACK cannot become an uncounted request or
      // an automatic replay of helper registration/business work.
      ++this.#nodeAttempts;
      return this.#exchangeFrame(
        operation,
        this.#nodeCapability,
        randomBytes(32).toString("hex"),
        child,
      );
    });
    this.#nodeQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
  async #rotateNodeIfNeeded(): Promise<void> {
    if (!this.#nodeRotation && this.#nodeAttempts < 2048) return;
    if (!this.#receipt) deny();
    this.#nodeRotation ??= {
      previous: this.#nodeCapability,
      nonce: randomBytes(32).toString("hex"),
    };
    const original = this.#nodeRotation;
    const result = parseStoreNodeRotation(
      await this.#exchangeFrame(
        "node-rotate",
        original.previous,
        original.nonce,
      ),
      {
        nonce: original.nonce,
        previous: original.previous,
        node: this.#receipt.parent,
        creator: {
          pid: this.#bootstrap.creator_pid,
          creationTime: this.#bootstrap.creator_creation_time,
        },
      },
    );
    this.#nodeCapability = result.capability;
    this.#nodeAttempts = 2048 - result.remaining;
    this.#nodeRotation = undefined;
  }
  #exchangeFrame(
    operation: "node-bind" | "register-helper" | "node-rotate",
    capability: string,
    nonce: string,
    child?: number,
  ): Promise<unknown> {
    if (this.#closed || this.#ending)
      return Promise.reject(new Error("STORE_NODE_ISSUER_DENIED"));
    const request = Buffer.from(
        JSON.stringify({
          version: 1,
          operation,
          request_nonce: nonce,
          capability,
          ...(child === undefined ? {} : { pid: pid(child) }),
        }) + "\n",
      ),
      name = `\\\\.\\pipe\\MusicMuteStoreRole-${this.#bootstrap.creator_pid}-${this.#bootstrap.creator_channel}`;
    return new Promise((resolve, reject) => {
      const socket = createConnection(name);
      this.#sockets.add(socket);
      let bytes = Buffer.alloc(0),
        reply: unknown,
        finished = false,
        eof = false;
      const fail = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          socket.destroy();
          bytes.fill(0);
          reject(new Error("STORE_NODE_ISSUER_DENIED"));
        }
      };
      const timer = setTimeout(fail, 10000);
      socket.once("connect", () =>
        socket.write(request, (error) => {
          request.fill(0);
          if (error) fail();
        }),
      );
      socket.on("data", (chunk: Buffer) => {
        try {
          if (reply !== undefined || bytes.length + chunk.length > 4096) deny();
          bytes = Buffer.concat([bytes, chunk]);
          const lf = bytes.indexOf(10);
          if (lf < 0) return;
          if (lf !== bytes.length - 1 || bytes.includes(13)) deny();
          const text = new TextDecoder("utf8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
          const parsed = parseStrictJson(text, 4096, 64) as Record<
            string,
            unknown
          >;
          if (!parsed || parsed.request_nonce !== nonce) deny();
          reply = parsed;
          socket.end();
        } catch {
          fail();
        }
      });
      socket.once("end", () => {
        eof = true;
      });
      socket.once("error", fail);
      socket.once("close", (hadError) => {
        this.#sockets.delete(socket);
        request.fill(0);
        bytes.fill(0);
        if (!finished && !hadError && eof && reply !== undefined) {
          finished = true;
          clearTimeout(timer);
          resolve(reply);
        } else fail();
      });
    });
  }
  close(): Promise<void> {
    if (arguments.length !== 0)
      return Promise.reject(new Error("STORE_NODE_ISSUER_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#ending = true;
    return (this.#closing ??= this.#close());
  }
  recoverClose(): Promise<void> {
    if (arguments.length !== 0 || !this.#ending)
      return Promise.reject(new Error("STORE_NODE_ISSUER_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#recoveringClose ??= (async () => {
      if (this.#closing) {
        this.#closeFailures.push(this.#closing);
        await this.#closing.catch(() => {});
      }
      if (!this.#closed) {
        this.#closing = this.#close(true);
        await this.#closing;
      }
    })().finally(() => {
      this.#recoveringClose = undefined;
    });
    void this.#recoveringClose.catch(() => {});
    return this.#recoveringClose;
  }
  async #close(recovery = false): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await this.#nodeQueue;
    const writes = await Promise.allSettled(
      [...this.#privateWrites].map(async (owner) => {
        await owner.ready?.catch(() => {});
        if (!this.#privateWrites.has(owner)) return;
        if (!owner.file)
          throw (
            owner.failure ?? new Error("STORE_PRIVATE_WRITE_CLEANUP_PENDING")
          );
        // Explicit recovery retries the exact original file capability only.
        if (recovery) owner.closing = owner.file.close();
        else owner.closing ??= owner.file.close();
        await owner.closing;
        this.#privateWrites.delete(owner);
      }),
    );
    if (writes.some((row) => row.status === "rejected"))
      throw new Error("CHILD_SHUTDOWN_PENDING");
    if (this.#media.size) {
      const { StoreMediaExecution } = await import("./store-media-runner.js");
      const media = await Promise.allSettled(
        [...this.#media].map(async (execution) => {
          await StoreMediaExecution.prototype.retireForIssuer.call(
            execution,
            this,
            recovery,
          );
          this.#media.delete(execution);
        }),
      );
      if (media.some((row) => row.status === "rejected"))
        throw new Error("CHILD_SHUTDOWN_PENDING");
    }
    const children = await Promise.allSettled(
      [...this.#children].map((child) =>
        child instanceof StoreFixedToolChild
          ? StoreFixedToolChild.prototype.retireForIssuer.call(
              child,
              this,
              recovery,
            )
          : StorePersonalEngineChild.prototype.retireForIssuer.call(
              child,
              this,
              recovery,
            ),
      ),
    );
    if (children.some((row) => row.status === "rejected"))
      throw new Error("CHILD_SHUTDOWN_PENDING");
    const transfers = await Promise.allSettled(
      [...this.#fleetTransfers.values()].map((child) =>
        StoreFleetTransferChild.prototype.retireForIssuer.call(
          child,
          this,
          recovery,
        ),
      ),
    );
    if (transfers.some((row) => row.status === "rejected"))
      throw new Error("CHILD_SHUTDOWN_PENDING");
    const attempts = await Promise.allSettled(
      [...this.#fleetAttempts.values()].map(async (lease) => {
        if (recovery) {
          await StoreFleetAttemptLease.prototype.retire
            .call(lease)
            .catch(() => {});
          await StoreFleetAttemptLease.prototype.recoverRetire.call(lease);
        } else await StoreFleetAttemptLease.prototype.retire.call(lease);
      }),
    );
    if (attempts.some((row) => row.status === "rejected"))
      throw new Error("CHILD_SHUTDOWN_PENDING");
    const constructing = await Promise.allSettled(
      [...this.#openingHelpers].map(async (owner) => {
        await owner.ready?.catch(() => undefined);
        if (!this.#openingHelpers.has(owner)) return;
        if (!owner.transport)
          throw owner.failure ?? new Error("STORE_NODE_ISSUER_DENIED");
        owner.retirement ??= owner.transport.close();
        await owner.retirement;
        this.#openingHelpers.delete(owner);
      }),
    );
    const results = [
      ...constructing,
      ...(await Promise.allSettled(
        [...this.#helpers].map((helper) => helper.close()),
      )),
    ];
    if (results.some((result) => result.status === "rejected"))
      throw new Error("CHILD_SHUTDOWN_PENDING");
    this.#helpers.clear();
    this.#bootstrap = Object.freeze({
      ...this.#bootstrap,
      capability: "",
      creator_channel: "",
    });
    this.#nodeCapability = "";
    this.#nodeRotation = undefined;
    this.#first = undefined;
    this.#closed = true;
    StoreNodeIssuer.#owners.delete(this);
  }
}

interface EnginePending {
  command: ChildRequestCommand;
  resolve(value: ChildResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  progress?: (value: ChildProgress) => void;
  lastProgress?: ChildProgress;
}
function engineBytes(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4)
    deny();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) deny();
  return bytes;
}
/** A real Creator-owned protected Python guardian, using the unchanged
 * Worker IPC codec. It exposes no spawn callback, executable path or env. */
export class StorePersonalEngineChild {
  readonly incarnation = randomUUID();
  #issuer: StoreNodeIssuer;
  #writer: StoreRoleNative;
  #reader: StoreRoleNative;
  #relative: string;
  #token?: string;
  #guardian?: ConsumerProcessIdentity;
  #startPending?: Promise<ChildResponse>;
  #admissionPending?: Promise<void>;
  #launchAttempted = false;
  #readyResolve: ((value: ChildResponse) => void) | undefined;
  #readyReject: ((error: Error) => void) | undefined;
  #readyComplete = false;
  #failed: Error | undefined;
  #decoder = new ChildFrameDecoder();
  #pending = new Map<string, EnginePending>();
  #writing = new Set<Promise<void>>();
  #writeFailures: Promise<void>[] = [];
  #reading?: Promise<void>;
  #stopping = false;
  #closed = false;
  #stopPending?: Promise<void>;
  #stopFailures: Promise<void>[] = [];
  #stderr = "";
  #onStage: ((stage: "loading" | "warming") => void) | undefined;
  constructor(
    token: symbol,
    issuer: StoreNodeIssuer,
    writer: StoreRoleNative,
    reader: StoreRoleNative,
    relative: string,
    onStage?: (stage: "loading" | "warming") => void,
  ) {
    if (token !== TOKEN || !["personal", "fleet"].includes(issuer.nodeRole))
      deny();
    StoreNodeIssuer.prototype.assertNative.call(issuer, writer);
    StoreNodeIssuer.prototype.assertNative.call(issuer, reader);
    this.#issuer = issuer;
    this.#writer = writer;
    this.#reader = reader;
    this.#relative = relative;
    this.#onStage = onStage;
    Object.freeze(this);
  }
  getPid(): number | undefined {
    return this.#closed ? undefined : this.#guardian?.pid;
  }
  diagnosticTail(): string {
    return this.#stderr;
  }
  #assert(): void {
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this.#writer);
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this.#reader);
    if (this.#closed) deny();
  }
  async #admit(): Promise<void> {
    this.#assert();
    this.#launchAttempted = true;
    const result = exact(
      await StoreRoleNative.prototype.childStart.call(
        this.#writer,
        this.#relative,
        this.incarnation,
      ),
      ["token", "started", "guardian"],
    );
    const token = secret(result.token);
    if (this.#token && token !== this.#token) deny();
    this.#token = token;
    if (result.started !== true) deny();
    const guardian = processIdentityFromWire(result.guardian),
      owner = this.#issuer.owner;
    if (
      guardian.pid === owner.identity.pid ||
      guardian.sid !== owner.identity.sid ||
      guardian.sessionId !== owner.identity.sessionId ||
      (this.#guardian && !sameConsumerProcess(this.#guardian, guardian))
    )
      deny();
    this.#guardian = guardian;
  }
  start(): Promise<ChildResponse> {
    if (
      arguments.length !== 0 ||
      this.#startPending ||
      this.#stopping ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_NODE_ISSUER_DENIED"));
    return (this.#startPending = this.#start());
  }
  async #start(): Promise<ChildResponse> {
    const ready = new Promise<ChildResponse>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    // Native admission can fail before the read pump awaits this promise.
    // Observe that same promise immediately; its original rejection is still
    // delivered by start(), and cleanup retains the actual native owner.
    void ready.catch(() => {});
    const timer = setTimeout(
      () => this.#fail(new Error("Worker child startup timed out")),
      60000,
    );
    try {
      this.#admissionPending = this.#admit();
      await this.#admissionPending;
      if (this.#stopping) throw new Error("Worker child stopped");
      this.#reading = this.#pump();
      void this.#reading.catch((error) =>
        this.#fail(
          error instanceof Error ? error : new Error("Worker child failed"),
        ),
      );
      return await ready;
    } catch (error) {
      this.#fail(
        error instanceof Error ? error : new Error("Worker child failed"),
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async #pump(): Promise<void> {
    while (!this.#stopping) {
      this.#assert();
      if (!this.#token) deny();
      const row = exact(
        await StoreRoleNative.prototype.childRead.call(
          this.#reader,
          this.#token,
        ),
        ["bytes_base64", "stderr_base64", "eof"],
      );
      if (typeof row.eof !== "boolean") deny();
      const bytes = engineBytes(row.bytes_base64, 24576),
        diagnostics = engineBytes(row.stderr_base64, 16384);
      this.#stderr = (
        this.#stderr + sanitizeDiagnostic(diagnostics.toString("utf8"))
      ).slice(-16384);
      for (const message of this.#decoder.push(bytes)) {
        if (
          message.type === "request" ||
          message.incarnation !== this.incarnation
        )
          deny();
        if (message.type === "startup-progress") {
          if (
            !this.#readyComplete &&
            Object.keys(message.payload).length === 1 &&
            (message.payload.stage === "loading" ||
              message.payload.stage === "warming")
          ) {
            try {
              this.#onStage?.(message.payload.stage);
            } catch {
              /* Observers cannot admit a child. */
            }
          }
          continue;
        }
        if (message.type === "accepted") continue;
        if (message.type === "ready") {
          if (!this.#readyResolve) deny();
          this.#readyComplete = true;
          this.#readyResolve(message);
          this.#readyResolve = undefined;
          this.#readyReject = undefined;
          continue;
        }
        const pending = this.#pending.get(message.requestId);
        if (!pending) deny();
        if (message.type === "progress") {
          const progress = parseChildProgress(message.payload);
          if (!progress) continue;
          if (pending.lastProgress) {
            const rank = CHILD_PROGRESS_STAGES.indexOf(progress.stage),
              lastRank = CHILD_PROGRESS_STAGES.indexOf(
                pending.lastProgress.stage,
              );
            if (
              rank < lastRank ||
              (rank === lastRank &&
                (progress.work === undefined ||
                  (pending.lastProgress.work !== undefined &&
                    progress.work.completed <=
                      pending.lastProgress.work.completed)))
            )
              continue;
          }
          pending.lastProgress = progress;
          try {
            pending.progress?.(progress);
          } catch {
            /* Observers do not change processing. */
          }
          continue;
        }
        clearTimeout(pending.timer);
        this.#pending.delete(message.requestId);
        if (message.type === "error")
          pending.reject(
            new ChildCommandError(
              typeof message.payload.code === "string"
                ? message.payload.code.slice(0, 100)
                : "CHILD_ERROR",
              typeof message.payload.summary === "string"
                ? message.payload.summary.slice(0, 200)
                : undefined,
            ),
          );
        else pending.resolve(message);
      }
      if (row.eof) {
        this.#decoder.finish();
        if (!this.#stopping) this.#fail(new Error("Worker child exited"));
        return;
      }
    }
  }
  request(
    command: "process" | "ping",
    payload: Record<string, unknown>,
    timeoutMs = 3600000,
    progress?: (value: ChildProgress) => void,
  ): Promise<ChildResponse> {
    if (
      (command !== "process" &&
        !(command === "ping" && this.#issuer.nodeRole === "fleet")) ||
      this.#stopping ||
      this.#pending.size !== 0
    )
      return Promise.reject(new Error("STORE_NODE_ISSUER_DENIED"));
    return this.#send(command, payload, timeoutMs, progress);
  }
  #send(
    command: ChildRequestCommand,
    payload: Record<string, unknown>,
    timeoutMs: number,
    progress?: (value: ChildProgress) => void,
  ): Promise<ChildResponse> {
    this.#assert();
    if (
      !this.#token ||
      !this.#readyComplete ||
      this.#failed ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 7200000
    )
      deny();
    const id = randomUUID(),
      frame = encodeChildFrame({
        protocolVersion: 1,
        type: "request",
        command,
        requestId: id,
        incarnation: this.incarnation,
        sentAt: new Date().toISOString(),
        payload,
      });
    const response = new Promise<ChildResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Worker child ${command} timed out`));
        void this.stop().catch(() => {});
      }, timeoutMs);
      this.#pending.set(id, {
        command,
        resolve,
        reject,
        timer,
        ...(progress ? { progress } : {}),
      });
    });
    const writing = (async () => {
      for (let position = 0; position < frame.length; position += 24576) {
        if (this.#stopping) throw new Error("Worker child stopped");
        await StoreRoleNative.prototype.childWrite.call(
          this.#writer,
          this.#token!,
          frame.subarray(position, position + 24576),
        );
      }
    })();
    this.#writing.add(writing);
    void writing.then(
      () => this.#writing.delete(writing),
      (error: unknown) => {
        this.#writeFailures.push(writing);
        this.#writing.delete(writing);
        this.#fail(
          error instanceof Error
            ? error
            : new Error("Worker child pipe write failed"),
        );
      },
    );
    return response;
  }
  #fail(error: Error): void {
    this.#failed ??= error;
    this.#readyReject?.(error);
    this.#readyReject = undefined;
    this.#readyResolve = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (!this.#stopping && !this.#closed) void this.stop().catch(() => {});
  }
  stop(): Promise<void> {
    if (arguments.length !== 0)
      return Promise.reject(new Error("STORE_NODE_ISSUER_DENIED"));
    if (this.#closed) return Promise.resolve();
    // Fence intake in this same turn, before joining an uncertain admission.
    this.#stopping = true;
    this.#fail(new Error("Worker child stopped"));
    return (this.#stopPending ??= this.#stop());
  }
  isAlive(): boolean {
    return (
      this.#readyComplete &&
      !this.#stopping &&
      !this.#closed &&
      !this.#failed &&
      this.#token !== undefined
    );
  }
  isProcessing(): boolean {
    return [...this.#pending.values()].some(
      (pending) => pending.command === "process",
    );
  }
  terminateActive(): void {
    if (this.isProcessing()) void this.stop().catch(() => {});
  }
  async #stop(): Promise<void> {
    // Join an uncertain start and recover only this original Creator request.
    await this.#admissionPending?.catch(() => {});
    if (!this.#token && this.#launchAttempted)
      await StoreRoleNative.prototype.childStopOriginal.call(
        this.#writer,
        this.#relative,
        this.incarnation,
      );
    this.#stopping = true;
    this.#fail(new Error("Worker child stopped"));
    if (this.#token)
      await StoreRoleNative.prototype.childStop.call(this.#writer, this.#token);
    await this.#startPending?.catch(() => {});
    await this.#reading?.catch(() => {});
    await Promise.allSettled([...this.#writing, ...this.#writeFailures]);
    await this.#reader.close();
    await this.#writer.close();
    this.#closed = true;
    StoreNodeIssuer.prototype.childRetired.call(this.#issuer, this);
  }
  closedForIssuer(issuer: StoreNodeIssuer): boolean {
    if (arguments.length !== 1 || issuer !== this.#issuer) deny();
    return this.#closed;
  }
  async retireForIssuer(
    issuer: StoreNodeIssuer,
    recovery: boolean,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      issuer !== this.#issuer ||
      typeof recovery !== "boolean"
    )
      deny();
    if (this.#closed) return;
    if (recovery && this.#stopPending) return this.recoverStop();
    return this.stop();
  }
  async recoverStop(): Promise<void> {
    if (arguments.length !== 0 || !this.#stopPending || this.#closed) deny();
    this.#stopFailures.push(this.#stopPending);
    await this.#stopPending.catch(() => {});
    this.#stopPending = this.#stop();
    return this.#stopPending;
  }
}

/** A finite Creator-owned child. CPU utilities require no model/GPU grant;
 * qualification separately requires the original Prepare/GPU/model authority.
 * Only the actual Node issuer can construct either fixed mode. */
export class StoreFixedToolChild {
  readonly incarnation = randomUUID();
  #issuer: StoreNodeIssuer;
  #writer: StoreRoleNative | undefined;
  #reader: StoreRoleNative | undefined;
  #opening: Promise<void> | undefined;
  #launchAttempted = false;
  #kind: StoreFixedToolKind | "qualification" | "benchmark";
  #requestId: string;
  #configurationSha256: string | undefined;
  #operationToken: string | undefined;
  #token?: string;
  #process?: ConsumerProcessIdentity;
  #admission?: Promise<void>;
  #started?: Promise<void>;
  #reading?: Promise<number>;
  #stopping = false;
  #closed = false;
  #stop?: Promise<void>;
  #failedStops: Promise<void>[] = [];
  #wakeRead: (() => void) | undefined;
  #stdout: Readable;
  #diagnostics = "";
  #outputComplete = false;
  constructor(
    token: symbol,
    issuer: StoreNodeIssuer,
    kind: StoreFixedToolKind | "qualification" | "benchmark",
    requestId: string,
    configurationSha256: string | undefined,
    operationToken?: string,
  ) {
    if (
      token !== TOKEN ||
      (kind === "qualification" || kind === "benchmark"
        ? issuer.nodeRole !== "prepare" ||
          configurationSha256 !== undefined ||
          operationToken !== undefined
        : typeof configurationSha256 !== "string" ||
          !HASH.test(configurationSha256) ||
          typeof operationToken !== "string" ||
          !HASH.test(operationToken)) ||
      (issuer.nodeRole !== "personal" && issuer.nodeRole !== "prepare")
    )
      deny();
    if (kind !== "qualification" && kind !== "benchmark")
      assertStoreFixedTool(kind, requestId);
    this.#issuer = issuer;
    this.#kind = kind;
    this.#requestId = requestId;
    this.#configurationSha256 = configurationSha256;
    this.#operationToken = operationToken;
    this.#stdout = new Readable({
      highWaterMark: 65536,
      read: () => {
        this.#wakeRead?.();
        this.#wakeRead = undefined;
      },
    });
    this.#stdout.on("error", () => {});
    Object.freeze(this);
  }
  get stdout(): Readable {
    return this.#stdout;
  }
  diagnosticTail(): string {
    return this.#diagnostics;
  }
  getPid(): number | undefined {
    return this.#closed ? undefined : this.#process?.pid;
  }
  #assert() {
    if (this.#closed) deny();
    if (!this.#writer || !this.#reader) deny();
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this.#writer);
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this.#reader);
  }
  async #admit() {
    this.#opening ??= this.#openHelpers();
    await this.#opening;
    this.#assert();
    if (!this.#writer) deny();
    this.#launchAttempted = true;
    const raw =
      this.#kind === "benchmark"
        ? await StoreRoleNative.prototype.benchmarkStart.call(
            this.#writer,
            this.incarnation,
          )
        : this.#kind === "qualification"
          ? await StoreRoleNative.prototype.qualificationStart.call(
              this.#writer,
              this.incarnation,
            )
          : await StoreRoleNative.prototype.toolStart.call(
              this.#writer,
              this.#kind,
              this.#requestId,
              this.incarnation,
              this.#configurationSha256!,
              this.#operationToken!,
            );
    const token = parseStoreToolToken(raw);
    if (this.#token && this.#token !== token) deny();
    this.#token = token;
    const started = parseStoreToolStarted(
      raw,
      this.#issuer.owner.identity,
      this.#process ? { token, process: this.#process } : undefined,
    );
    this.#process = started.process;
  }
  async #openHelpers(): Promise<void> {
    this.#writer = (await this.#issuer.openNative()) as StoreRoleNative;
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this.#writer);
    if (this.#stopping) throw new Error("STORE_TOOL_STOPPED");
    this.#reader = (await this.#issuer.openNative()) as StoreRoleNative;
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this.#reader);
  }
  start(): Promise<void> {
    if (arguments.length || this.#started || this.#stopping || this.#closed)
      return Promise.reject(new Error("STORE_TOOL_INVALID"));
    return (this.#started = this.#start());
  }
  async #start() {
    this.#admission = this.#admit();
    await this.#admission;
    if (this.#stopping) throw new Error("STORE_TOOL_STOPPED");
    this.#reading = this.#pump();
    void this.#reading.catch((error) => {
      this.#stdout.destroy(
        error instanceof Error ? error : new Error("STORE_TOOL_INVALID"),
      );
      void this.stop().catch(() => {});
    });
  }
  async #pump(): Promise<number> {
    while (!this.#stopping) {
      this.#assert();
      if (!this.#token || !this.#reader) deny();
      const chunk = parseStoreToolChunk(
        this.#kind === "benchmark"
          ? await StoreRoleNative.prototype.benchmarkRead.call(
              this.#reader,
              this.#token,
            )
          : this.#kind === "qualification"
            ? await StoreRoleNative.prototype.qualificationRead.call(
                this.#reader,
                this.#token,
              )
            : await StoreRoleNative.prototype.toolRead.call(
                this.#reader,
                this.#token,
              ),
      );
      if (this.#stopping) throw new Error("STORE_TOOL_STOPPED");
      this.#diagnostics = (
        this.#diagnostics +
        sanitizeDiagnostic(chunk.diagnostics.toString("utf8"))
      ).slice(-16384);
      if (chunk.bytes.length && !this.#stdout.push(chunk.bytes))
        await new Promise<void>((resolve) => {
          this.#wakeRead = resolve;
        });
      if (chunk.eof) {
        this.#outputComplete = true;
        this.#stdout.push(null);
        if (chunk.exitCode === null) deny();
        return chunk.exitCode;
      }
    }
    throw new Error("STORE_TOOL_STOPPED");
  }
  async waitForExit(): Promise<number> {
    if (arguments.length || !this.#started) deny();
    await this.#started;
    if (!this.#reading) deny();
    const code = await this.#reading;
    await this.stop();
    return code;
  }
  stop(): Promise<void> {
    if (arguments.length)
      return Promise.reject(new Error("STORE_TOOL_INVALID"));
    if (this.#closed) return Promise.resolve();
    this.#stopping = true;
    this.#wakeRead?.();
    this.#wakeRead = undefined;
    if (!this.#outputComplete)
      this.#stdout.destroy(new Error("STORE_TOOL_STOPPED"));
    return (this.#stop ??= this.#retire());
  }
  async #retire() {
    await this.#admission?.catch(() => {});
    if (!this.#token && this.#launchAttempted) {
      if (!this.#writer) deny();
      await StoreRoleNative.prototype.fixedStopBeforeToken.call(
        this.#writer,
        this.#kind,
        this.#kind === "qualification" || this.#kind === "benchmark"
          ? { incarnation: this.incarnation }
          : {
              kind: this.#kind,
              request_id: this.#requestId,
              incarnation: this.incarnation,
              configuration_sha256: this.#configurationSha256!,
              operation_token: this.#operationToken!,
            },
      );
    }
    if (this.#token && this.#writer) {
      if (this.#kind === "benchmark")
        await StoreRoleNative.prototype.benchmarkStop.call(
          this.#writer,
          this.#token,
        );
      else if (this.#kind === "qualification")
        await StoreRoleNative.prototype.qualificationStop.call(
          this.#writer,
          this.#token,
        );
      else
        await StoreRoleNative.prototype.toolStop.call(
          this.#writer,
          this.#token,
        );
    }
    await this.#started?.catch(() => {});
    await this.#reading?.catch(() => {});
    await this.#opening?.catch(() => {});
    await this.#reader?.close();
    await this.#writer?.close();
    this.#closed = true;
    StoreNodeIssuer.prototype.childRetired.call(this.#issuer, this);
  }
  closedForIssuer(issuer: StoreNodeIssuer): boolean {
    if (arguments.length !== 1 || issuer !== this.#issuer) deny();
    return this.#closed;
  }
  async retireForIssuer(
    issuer: StoreNodeIssuer,
    recovery: boolean,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      issuer !== this.#issuer ||
      typeof recovery !== "boolean"
    )
      deny();
    if (this.#closed) return;
    if (recovery && this.#stop) return this.recoverStop();
    return this.stop();
  }
  async recoverStop(): Promise<void> {
    if (arguments.length || !this.#stop || this.#closed) deny();
    this.#failedStops.push(this.#stop);
    await this.#stop.catch(() => {});
    this.#stop = this.#retire();
    return this.#stop;
  }
}

/** One fixed protected transfer Node beneath its original Fleet attempt.
 * Its actual issuer/attempt/helper owners remain private through lost ACKs. */
export class StoreFleetTransferChild {
  readonly incarnation: string;
  #issuer: StoreNodeIssuer;
  #request: Readonly<{
    requestId: string;
    operation: "download" | "upload";
    attemptId: string;
    relativePath: string;
  }>;
  #lease: StoreFleetAttemptLease;
  #writer: StoreRoleNative | undefined;
  #reader: StoreRoleNative | undefined;
  #opening: Promise<void> | undefined;
  #admission: Promise<void> | undefined;
  #started: Promise<void> | undefined;
  #reading: Promise<number> | undefined;
  #writing: Promise<void> | undefined;
  #token: string | undefined;
  #process: ConsumerProcessIdentity | undefined;
  #launchAttempted = false;
  #inputAttempted = false;
  #stopping = false;
  #closed = false;
  #outputComplete = false;
  #stop: Promise<void> | undefined;
  #recovery: Promise<void> | undefined;
  #failedStops: Promise<void>[] = [];
  #stdout: Readable;
  #wakeRead: (() => void) | undefined;
  constructor(
    token: symbol,
    issuer: StoreNodeIssuer,
    request: Readonly<{
      requestId: string;
      operation: "download" | "upload";
      attemptId: string;
      relativePath: string;
    }>,
    lease: StoreFleetAttemptLease,
  ) {
    if (token !== TOKEN || issuer.nodeRole !== "fleet") deny();
    StoreFleetAttemptLease.prototype.expectationForIssuer.call(lease, issuer);
    this.#issuer = issuer;
    this.#request = request;
    this.#lease = lease;
    this.incarnation = uuid(request.requestId);
    this.#stdout = new Readable({
      highWaterMark: 4096,
      read: () => {
        this.#wakeRead?.();
        this.#wakeRead = undefined;
      },
    });
    this.#stdout.on("error", () => {});
    Object.freeze(this);
  }
  matches(issuer: StoreNodeIssuer, input: unknown): boolean {
    if (arguments.length !== 2 || issuer !== this.#issuer) deny();
    const row = storeCpuFields(input, [
      "requestId",
      "operation",
      "attemptId",
      "relativePath",
    ]);
    return (
      row.requestId === this.#request.requestId &&
      row.operation === this.#request.operation &&
      row.attemptId === this.#request.attemptId &&
      row.relativePath === this.#request.relativePath
    );
  }
  blocksAttempt(issuer: StoreNodeIssuer, id: string): boolean {
    if (arguments.length !== 2 || issuer !== this.#issuer) deny();
    return !this.#closed && id === this.#request.attemptId;
  }
  get stdout(): Readable {
    return this.#stdout;
  }
  closedForIssuer(issuer: StoreNodeIssuer): boolean {
    if (arguments.length !== 1 || issuer !== this.#issuer) deny();
    return this.#closed;
  }
  async #openHelpers(): Promise<void> {
    this.#writer = (await StoreNodeIssuer.prototype.openTransferNative.call(
      this.#issuer,
      this,
    )) as StoreRoleNative;
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this.#writer);
    if (this.#stopping) throw new Error("STORE_TRANSFER_STOPPED");
    this.#reader = (await StoreNodeIssuer.prototype.openTransferNative.call(
      this.#issuer,
      this,
    )) as StoreRoleNative;
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, this.#reader);
  }
  async #admit(): Promise<void> {
    this.#opening ??= this.#openHelpers();
    await this.#opening;
    if (!this.#writer || !this.#reader) deny();
    const expectation =
      StoreFleetAttemptLease.prototype.expectationForIssuer.call(
        this.#lease,
        this.#issuer,
      );
    this.#launchAttempted = true;
    const raw = await StoreRoleNative.prototype.transferOperation.call(
      this.#writer,
      "start",
      {
        incarnation: this.incarnation,
        operation: this.#request.operation,
        attempt_id: this.#request.attemptId,
        relative_path: this.#request.relativePath,
        workspace_token: expectation.token,
      },
    );
    const token = parseStoreToolToken(raw);
    if (this.#token && this.#token !== token) deny();
    this.#token = token;
    const started = parseStoreToolStarted(
      raw,
      this.#issuer.owner.identity,
      this.#process ? { token, process: this.#process } : undefined,
    );
    this.#process = started.process;
  }
  start(): Promise<void> {
    if (arguments.length || this.#started || this.#stopping || this.#closed)
      return Promise.reject(new Error("STORE_FLEET_TRANSFER_DENIED"));
    this.#started = (async () => {
      this.#admission = this.#admit();
      await this.#admission;
      if (this.#stopping) throw new Error("STORE_TRANSFER_STOPPED");
      this.#reading = this.#pump();
      void this.#reading.catch((error) => {
        this.#stdout.destroy(
          error instanceof Error ? error : new Error("STORE_TRANSFER_FAILED"),
        );
        void this.stop().catch(() => {});
      });
    })();
    void this.#started.catch(() => {});
    return this.#started;
  }
  write(bytes: Uint8Array): Promise<void> {
    if (
      arguments.length !== 1 ||
      !this.#started ||
      this.#inputAttempted ||
      this.#stopping ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_FLEET_TRANSFER_DENIED"));
    const copy = Buffer.from(snapshotStoreTransferBytes(bytes, 65536)),
      paths = StoreFleetAttemptLease.prototype.paths.call(this.#lease),
      request = parseStoreTransferRequest(copy, paths.root);
    if (
      request.requestId !== this.#request.requestId ||
      request.operation !== this.#request.operation ||
      request.attemptId !== this.#request.attemptId ||
      request.path !==
        (this.#request.operation === "download" ? paths.input : paths.output)
    )
      deny();
    this.#inputAttempted = true;
    this.#writing = (async () => {
      await this.#started;
      if (!this.#token || !this.#writer) deny();
      for (let offset = 0; offset < copy.length; offset += 24576) {
        if (this.#stopping) throw new Error("STORE_TRANSFER_STOPPED");
        const chunk = copy.subarray(offset, offset + 24576),
          row = storeCpuFields(
            await StoreRoleNative.prototype.transferOperation.call(
              this.#writer,
              "write",
              {
                token: this.#token,
                bytes_base64: chunk.toString("base64"),
                end: offset + chunk.length === copy.length,
              },
            ),
            ["written"],
          );
        if (row.written !== chunk.length) deny();
      }
    })();
    void this.#writing.catch(() => {});
    return this.#writing;
  }
  async #pump(): Promise<number> {
    while (!this.#stopping) {
      if (!this.#reader || !this.#token) deny();
      const chunk = parseStoreToolChunk(
        await StoreRoleNative.prototype.transferOperation.call(
          this.#reader,
          "read",
          { token: this.#token },
        ),
      );
      if (this.#stopping) throw new Error("STORE_TRANSFER_STOPPED");
      if (chunk.bytes.length && !this.#stdout.push(chunk.bytes))
        await new Promise<void>((resolve) => {
          this.#wakeRead = resolve;
        });
      if (chunk.eof) {
        if (chunk.exitCode === null) deny();
        this.#outputComplete = true;
        this.#stdout.push(null);
        return chunk.exitCode;
      }
    }
    throw new Error("STORE_TRANSFER_STOPPED");
  }
  async waitForExit(): Promise<number> {
    if (arguments.length || !this.#started) deny();
    await this.#started;
    if (!this.#reading) deny();
    return this.#reading;
  }
  stop(): Promise<void> {
    if (arguments.length)
      return Promise.reject(new Error("STORE_FLEET_TRANSFER_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#stopping = true;
    this.#wakeRead?.();
    this.#wakeRead = undefined;
    if (!this.#outputComplete)
      this.#stdout.destroy(new Error("STORE_TRANSFER_STOPPED"));
    this.#stop ??= this.#retire(false);
    void this.#stop.catch(() => {});
    return this.#stop;
  }
  async #retire(recovery: boolean): Promise<void> {
    await this.#admission?.catch(() => {});
    if (!this.#token && this.#launchAttempted) {
      if (!this.#writer) deny();
      const expectation =
        StoreFleetAttemptLease.prototype.expectationForIssuer.call(
          this.#lease,
          this.#issuer,
        );
      parseStoreToolCleanup(
        await StoreRoleNative.prototype.transferOperation.call(
          this.#writer,
          "stop",
          {
            incarnation: this.incarnation,
            operation: this.#request.operation,
            attempt_id: this.#request.attemptId,
            relative_path: this.#request.relativePath,
            workspace_token: expectation.token,
          },
        ),
      );
    }
    if (this.#token && this.#writer)
      parseStoreToolCleanup(
        await StoreRoleNative.prototype.transferOperation.call(
          this.#writer,
          "stop",
          { token: this.#token },
        ),
      );
    await this.#writing?.catch(() => {});
    await this.#started?.catch(() => {});
    await this.#reading?.catch(() => {});
    await this.#opening?.catch(() => {});
    await StoreNodeIssuer.prototype.retireTransferOpenings.call(
      this.#issuer,
      this,
      recovery,
    );
    await this.#reader?.close();
    await this.#writer?.close();
    this.#closed = true;
  }
  recoverStop(): Promise<void> {
    if (arguments.length || !this.#stop)
      return Promise.reject(new Error("STORE_FLEET_TRANSFER_DENIED"));
    if (this.#closed) return Promise.resolve();
    return (this.#recovery ??= (async () => {
      this.#failedStops.push(this.#stop!);
      await this.#stop!.catch(() => {});
      this.#stop = this.#retire(true);
      await this.#stop;
    })().finally(() => {
      this.#recovery = undefined;
    }));
  }
  async retireForIssuer(
    issuer: StoreNodeIssuer,
    recovery: boolean,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      issuer !== this.#issuer ||
      typeof recovery !== "boolean"
    )
      deny();
    if (this.#closed) return;
    if (recovery && this.#stop) await this.recoverStop();
    else await this.stop();
  }
}
