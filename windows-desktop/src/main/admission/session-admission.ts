import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { win32 } from "node:path";
import {
  parseDirectmlGpuIdentity,
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
  sameConsumerProcess,
  type ConsumerOwnedProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { PersonalAdmission } from "../../../../worker/src/runtime/personal-admission.js";
import type { PersonalAgentClient } from "../personal/session-port.js";
import { requestFleetCommand } from "../fleet/channel.js";
import { openStoreFleetSessionPort } from "../fleet/store-session-port.js";
import type { FleetSessionControlPort } from "../../agent/fleet.js";
import type { StoreRuntimeContext } from "../session/store-runtime-context.js";
import { readCurrentFleetGpu, readCurrentPersonalGpu } from "./current-gpu.js";
import { GpuBrokerBank } from "./broker-bank.js";
import type { PersonalWaitReason } from "../../shared/personal-contracts.js";
export { readCurrentFleetGpu, readCurrentPersonalGpu } from "./current-gpu.js";
import { SessionClient, type SessionDispatcher } from "../session/control.js";
import type {
  SessionChildContext,
  SessionRuntimeContext,
} from "../session/context.js";
import { StoreNodeIssuer } from "../session/store-node-issuer.js";
import {
  WindowsGpuBroker,
  type GpuLease,
  type GpuPersistentState,
  type GpuRequest,
  type GpuBrokerView,
} from "./gpu-broker.js";

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
type Action =
  | "request_personal"
  | "request_fleet"
  | "release_personal"
  | "fleet_yielded"
  | "cancel"
  | "status";
interface Frame {
  version: 1;
  kind: "gpu-admission";
  action: Action;
  requestId: string;
  generation: string;
  ownerReceipt: ConsumerOwnedProcess;
  gpuIdentity: DirectmlGpuIdentity;
  leaseNonce?: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GPU_OWNER_DENIED");
  return value as Record<string, unknown>;
}
function identity(value: unknown): ConsumerProcessIdentity {
  return processIdentityFromWire(
    processIdentityToWire(object(value) as unknown as ConsumerProcessIdentity),
  );
}
function owner(value: unknown): ConsumerOwnedProcess {
  const row = object(value);
  if (
    Object.keys(row).sort().join() !== "identity,nonce,role" ||
    (row.role !== "personal" && row.role !== "fleet") ||
    typeof row.nonce !== "string" ||
    !HASH.test(row.nonce)
  )
    throw new Error("GPU_OWNER_DENIED");
  return { role: row.role, nonce: row.nonce, identity: identity(row.identity) };
}
function parseFrame(payload: Uint8Array): Frame {
  if (payload.byteLength > 4096) throw new Error("GPU_OWNER_DENIED");
  const row = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)),
  );
  if (
    row.version !== 1 ||
    row.kind !== "gpu-admission" ||
    typeof row.action !== "string" ||
    ![
      "request_personal",
      "request_fleet",
      "release_personal",
      "fleet_yielded",
      "cancel",
      "status",
    ].includes(row.action) ||
    typeof row.requestId !== "string" ||
    !UUID.test(row.requestId) ||
    typeof row.generation !== "string" ||
    !UUID.test(row.generation) ||
    Object.keys(row).some(
      (key) =>
        ![
          "version",
          "kind",
          "action",
          "requestId",
          "generation",
          "ownerReceipt",
          "gpuIdentity",
          "leaseNonce",
        ].includes(key),
    ) ||
    (row.leaseNonce !== undefined &&
      (typeof row.leaseNonce !== "string" || !HASH.test(row.leaseNonce)))
  )
    throw new Error("GPU_OWNER_DENIED");
  const receipt = owner(row.ownerReceipt);
  if (
    ((row.action === "request_personal" || row.action === "release_personal") &&
      receipt.role !== "personal") ||
    ((row.action === "request_fleet" || row.action === "fleet_yielded") &&
      receipt.role !== "fleet")
  )
    throw new Error("GPU_OWNER_DENIED");
  return {
    ...row,
    ownerReceipt: receipt,
    gpuIdentity: parseDirectmlGpuIdentity(row.gpuIdentity),
  } as unknown as Frame;
}
interface Pending {
  request: GpuRequest;
  controller: AbortController;
  promise: Promise<GpuLease>;
  lease?: GpuLease;
  error?: string;
  lastWaitReason?: PersonalWaitReason;
}
function personalWaitReason(view: GpuBrokerView): PersonalWaitReason | null {
  if (view.waiting < 1) return null;
  if (view.state === "waiting-for-worker") return "waiting-for-worker";
  if (
    view.problem === "GPU_BUSY" ||
    view.state === "personal" ||
    view.state === "prepare"
  )
    return "gpu-busy";
  return view.state === "recovering" ? "recovering" : null;
}
export interface SessionGpuAdmissionOptions {
  gpu: DirectmlGpuIdentity;
  personal: PersonalAgentClient;
  currentOwner(role: "personal" | "fleet"): ConsumerOwnedProcess | undefined;
  certificateEvents?(wake: () => void): () => void;
  /** Internal fixed per-adapter durable slot; never supplied by a caller frame. */
  stateKey?: string;
}
/** Logical authority; physical mutex operations are delegated to the verified role's stable helper. */
export async function createSessionGpuAdmission(
  context: SessionRuntimeContext,
  options: SessionGpuAdmissionOptions,
): Promise<
  SessionDispatcher & {
    close(): Promise<void>;
    broker: WindowsGpuBroker;
    settledRequestIds(): readonly string[];
  }
> {
  if (context.distribution === "microsoft-store") {
    const issuer = context.storeIssuer;
    if (!issuer) throw new Error("GPU_OWNER_DENIED");
    StoreNodeIssuer.prototype.assertNative.call(issuer, context.native);
    if (
      issuer.nodeRole !== "session-agent" ||
      issuer.inventorySha256 !== context.configuration.release
    )
      throw new Error("GPU_OWNER_DENIED");
  }
  const fleetCommand: FleetSessionControlPort["command"] =
    context.distribution === "microsoft-store"
      ? openStoreFleetSessionPort(context as StoreRuntimeContext).command
      : (owner, request, signal) =>
          requestFleetCommand(context, owner, request, signal);
  const native = await context.openNative(),
    host = await native.identity();
  const gpu = resolveQualifiedGpuIdentity(
    options.gpu,
    await native.enumerateGpus(),
  );
  const stateKey = options.stateKey ?? "gpu_broker_state";
  if (stateKey !== "gpu_broker_state" && stateKey !== `gpu_broker_${gpu.luid}`)
    throw new Error("RESERVATION_INVALID");
  const pending = new Map<string, Pending>();
  const completed = new Map<string, Pending>();
  const rememberCompleted = (id: string, entry: Pending) => {
    pending.delete(id);
    yieldRequested.delete(id);
    completed.set(id, entry);
    if (completed.size > 64) completed.delete(completed.keys().next().value!);
  };
  const physical = new Map<string, string>();
  const yieldRequested = new Set<string>();
  let closed = false;
  const personalCommand = async (
    action: "guard_acquire" | "guard_status" | "guard_release",
    request: GpuRequest,
    guardNonce?: string,
  ) => {
    // These operations never pass through the renderer/client gateway.
    const command = {
      version: 1,
      requestId: randomUUID(),
      action,
      jobId: request.requestId,
      ...(action === "guard_acquire" ? { gpu: request.gpu } : {}),
      ...(guardNonce ? { guardNonce } : {}),
    };
    const reply = await options.personal.command(command as never);
    const guard = object((reply as unknown as { guard: unknown }).guard);
    return guard;
  };
  const findRequest = (
    roleOwner: ConsumerOwnedProcess,
    peer: ConsumerProcessIdentity,
  ): GpuRequest | undefined =>
    [...pending.values()]
      .map((entry) => entry.request)
      .find(
        (request) =>
          request.owner.nonce === roleOwner.nonce &&
          sameConsumerProcess(request.owner.identity, roleOwner.identity) &&
          sameConsumerProcess(request.peer, peer),
      );
  const broker = new WindowsGpuBroker({
    sid: host.sid,
    sessionId: host.sessionId,
    gpu,
    read: async () => {
      const bytes = await native.vaultRead("fleet", stateKey);
      if (!bytes) return null;
      try {
        if (bytes.length > 16384) throw new Error("RESERVATION_INVALID");
        const value = object(JSON.parse(bytes.toString("utf8")));
        if (
          Object.keys(value).sort().join() !== "active,gpuLuid,sid,version" ||
          value.version !== 1 ||
          value.sid !== host.sid ||
          value.gpuLuid !== gpu.luid
        )
          throw new Error("RESERVATION_INVALID");
        if (value.active !== null) {
          const lease = object(value.active),
            request = object(lease.request);
          if (
            typeof lease.nonce !== "string" ||
            !HASH.test(lease.nonce) ||
            typeof request.requestId !== "string" ||
            !UUID.test(request.requestId) ||
            typeof request.generation !== "string" ||
            !UUID.test(request.generation)
          )
            throw new Error("RESERVATION_INVALID");
          owner(request.owner);
          identity(request.peer);
          parseDirectmlGpuIdentity(request.gpu);
        }
        return value as unknown as GpuPersistentState;
      } finally {
        bytes.fill(0);
      }
    },
    write: async (value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      try {
        await native.vaultWrite("fleet", stateKey, bytes);
      } finally {
        bytes.fill(0);
      }
    },
    verifyOwner: async (request) => {
      if (await native.ownedTreeExited(request.owner)) return;
      const current = options.currentOwner(
        request.kind as "personal" | "fleet",
      );
      if (
        !current ||
        current.nonce !== request.owner.nonce ||
        !sameConsumerProcess(current.identity, request.owner.identity)
      )
        throw new Error("GPU_OWNER_DENIED");
      await context.verifyOwnedPeer(request.owner, request.peer);
    },
    treeExited: async (roleOwner, peer) => {
      if (await native.ownedTreeExited(roleOwner)) return true;
      const request = findRequest(roleOwner, peer);
      // Unknown old guardians cannot be certified by a PID-only liveness check.
      if (!request) return false;
      try {
        await context.verifyOwnedPeer(roleOwner, peer);
        if (roleOwner.role === "personal") {
          const proof = await personalCommand("guard_status", request);
          return proof.exited === true && proof.cleaned === true;
        }
        const proof = await fleetCommand(
          roleOwner,
          { action: "inference_proof" },
          AbortSignal.timeout(9000),
        );
        return proof?.idle === true;
      } catch {
        return false;
      }
    },
    acquireGuard: async (_luid, request) => {
      let nonce: string | undefined;
      if (request.kind === "personal") {
        const result = await personalCommand("guard_acquire", request);
        if (result.acquired !== true) return null;
        if (typeof result.nonce !== "string" || !HASH.test(result.nonce))
          throw new Error("GPU_GUARD_UNSAFE");
        nonce = result.nonce;
      } else {
        const result = await fleetCommand(
          request.owner,
          { action: "guard_acquire", gpuLuid: request.gpu.luid },
          AbortSignal.timeout(9000),
        );
        if (result?.held !== true || !result.guardNonce) return null;
        nonce = result.guardNonce;
      }
      physical.set(request.requestId, nonce);
      return {
        release: async () => {
          const held = physical.get(request.requestId);
          if (!held || held !== nonce) throw new Error("GPU_LEASE_STALE");
          if (!(await native.ownedTreeExited(request.owner))) {
            if (request.kind === "personal")
              await personalCommand("guard_release", request, held);
            else
              await fleetCommand(
                request.owner,
                { action: "guard_release", guardNonce: held },
                AbortSignal.timeout(9000),
              );
          }
          physical.delete(request.requestId);
        },
      };
    },
    legacyConflict: () => native.legacyWorkerConflict(),
    fenceFleet: async (value) => {
      const fleet = options.currentOwner("fleet");
      if (fleet)
        await fleetCommand(
          fleet,
          { action: "admission_pending", pending: value },
          AbortSignal.timeout(9000),
        );
    },
  });
  await broker.start();
  const dispatch = async (
    payload: Uint8Array,
    peer: ConsumerProcessIdentity,
  ): Promise<Buffer> => {
    const frame = parseFrame(payload);
    await context.verifyOwnedPeer(frame.ownerReceipt, peer);
    resolveQualifiedGpuIdentity(gpu, [frame.gpuIdentity]);
    const request: GpuRequest = {
      requestId: frame.requestId,
      generation: frame.generation,
      kind: frame.ownerReceipt.role as "personal" | "fleet",
      owner: frame.ownerReceipt,
      peer,
      gpu: frame.gpuIdentity,
    };
    const previous =
      pending.get(frame.requestId) ?? completed.get(frame.requestId);
    if (
      previous &&
      (previous.request.generation !== frame.generation ||
        previous.request.kind !== request.kind ||
        previous.request.owner.nonce !== request.owner.nonce ||
        !sameConsumerProcess(
          previous.request.owner.identity,
          request.owner.identity,
        ) ||
        !sameConsumerProcess(previous.request.peer, peer))
    )
      throw new Error("GPU_OWNER_DENIED");
    let response: Record<string, unknown>;
    if (frame.action === "status") response = { state: broker.snapshot() };
    else if (
      frame.action === "request_personal" ||
      frame.action === "request_fleet"
    ) {
      if (closed) throw new Error("GPU_COORDINATION_UNAVAILABLE");
      if (completed.has(frame.requestId)) throw new Error("GPU_LEASE_STALE");
      let entry = previous;
      if (!entry && pending.size >= 64) throw new Error("GPU_BUSY");
      if (request.kind === "fleet" && !yieldRequested.has(frame.requestId)) {
        yieldRequested.add(frame.requestId);
        // The owned personal helper can retain a warm model and physical mutex.
        // Do not await: eviction releases through this admission channel and needs
        // the personal guard channel free for the final positive release ACK.
        void options.personal
          .command({
            version: 1,
            requestId: randomUUID(),
            action: "yield_idle",
          })
          .catch(() => {});
      }
      if (!entry) {
        if (pending.size >= 64) throw new Error("GPU_BUSY");
        const controller = new AbortController();
        const promise = broker.acquire(request, controller.signal);
        entry = { request, controller, promise };
        pending.set(frame.requestId, entry);
        const capture = entry;
        void promise.then(
          (lease) => {
            capture.lease = lease;
          },
          (error) => {
            capture.error =
              error instanceof Error && /^[A-Z_]{1,64}$/u.test(error.message)
                ? error.message
                : "GPU_COORDINATION_UNAVAILABLE";
          },
        );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiting = entry;
      let removeWaitEvents = () => {};
      const waitChanged = new Promise<void>((resolve) => {
        removeWaitEvents = broker.subscribe((view) => {
          const reason = personalWaitReason(view);
          if (reason !== null && reason !== waiting.lastWaitReason) resolve();
        });
      });
      try {
        await Promise.race([
          entry.promise.catch(() => {}),
          waitChanged,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 20000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        removeWaitEvents();
      }
      const waitReason = personalWaitReason(broker.snapshot());
      if (entry.error) response = { ok: false, error: entry.error };
      else
        response = entry.lease
          ? { ok: true, leaseNonce: entry.lease.nonce, gpuLuid: gpu.luid }
          : {
              ok: true,
              pending: true,
              ...(waitReason ? { waitReason } : {}),
            };
      if (!entry.lease && !entry.error && waitReason)
        entry.lastWaitReason = waitReason;
    } else if (frame.action === "cancel") {
      if (previous) {
        previous.controller.abort();
        await previous.promise.catch(() => {});
        if (previous.lease) await broker.release(previous.lease);
        rememberCompleted(frame.requestId, previous);
      }
      response = { ok: true, cancelled: true };
    } else {
      if (!previous?.lease || frame.leaseNonce !== previous.lease.nonce)
        throw new Error("GPU_LEASE_STALE");
      await broker.release(previous.lease);
      rememberCompleted(frame.requestId, previous);
      response = { ok: true, released: true };
    }
    return Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "gpu-admission",
        requestId: frame.requestId,
        ...response,
      }),
    );
  };
  let exitQueue: Promise<void> = Promise.resolve();
  const wake = () => {
    exitQueue = exitQueue
      .then(async () => {
        for (const [id, entry] of pending) {
          if (await native.ownedTreeExited(entry.request.owner)) {
            // The certificate fences this exact retired role. Stop an ungranted
            // waiter too; its absence from the active lease is not an idle proof.
            entry.controller.abort();
            await entry.promise.catch(() => {});
            if (entry.lease) await broker.release(entry.lease);
            rememberCompleted(id, entry);
          }
        }
        await broker.recover();
      })
      .catch(() => {});
  };
  let removeCertificateEvents: () => void;
  if (options.certificateEvents)
    removeCertificateEvents = options.certificateEvents(wake);
  else {
    await native.validatePath("fleet", "vault\\fleet", "directory");
    const changed = watch(
      win32.join(context.configuration.fleetRoot, "vault", "fleet"),
      { persistent: false },
      (_event, name) => {
        if (name && /^job_exit_[a-f0-9]{55}\.dpapi$/u.test(String(name)))
          wake();
      },
    );
    changed.on("error", () => {
      closed = true;
      for (const entry of pending.values()) entry.controller.abort();
    });
    removeCertificateEvents = () => changed.close();
  }
  return {
    broker,
    dispatch,
    settledRequestIds: () => [...completed.keys()],
    close: async () => {
      closed = true;
      removeCertificateEvents();
      for (const entry of pending.values()) entry.controller.abort();
      await broker.close();
      await native.close();
    },
  };
}

export interface RoleGpuGateway {
  acquire(
    request: { jobId: string; gpu: DirectmlGpuIdentity },
    signal: AbortSignal,
    onWait?: (reason: PersonalWaitReason) => void,
  ): Promise<{ jobId: string; gpuLuid: string; leaseNonce: string }>;
  release(request: {
    jobId: string;
    leaseNonce: string;
    exited: true;
    cleaned: true;
  }): Promise<void>;
  cancelAfterCleanup(request: {
    jobId: string;
    exited: true;
    cleaned: true;
  }): Promise<void>;
}
export interface QualifiedSessionGpuAdmissionOptions extends Omit<
  SessionGpuAdmissionOptions,
  "gpu" | "stateKey"
> {
  /** Trusted composition/test port; no wire field can supply this function. */
  readRoleGpu?(role: "personal" | "fleet"): Promise<DirectmlGpuIdentity>;
}
/** Per-role current qualification selects the physical adapter. Same LUID uses
 * one queue; different independently qualified adapters have separate guards. */
export async function createQualifiedSessionGpuAdmission(
  context: SessionRuntimeContext,
  options: QualifiedSessionGpuAdmissionOptions,
): Promise<
  SessionDispatcher & {
    broker: { recover(): Promise<void>; snapshot(): GpuBrokerView };
    close(): Promise<void>;
  }
> {
  if (context.distribution === "microsoft-store") {
    const issuer = context.storeIssuer;
    if (!issuer || options.readRoleGpu) throw new Error("GPU_OWNER_DENIED");
    StoreNodeIssuer.prototype.assertNative.call(issuer, context.native);
    if (
      issuer.nodeRole !== "session-agent" ||
      issuer.inventorySha256 !== context.configuration.release
    )
      throw new Error("GPU_OWNER_DENIED");
  }
  const native = await context.openNative(),
    host = await native.identity(),
    bank = new GpuBrokerBank(native, host.sid),
    brokers = new Map<
      string,
      Awaited<ReturnType<typeof createSessionGpuAdmission>>
    >(),
    opening = new Map<
      string,
      Promise<Awaited<ReturnType<typeof createSessionGpuAdmission>>>
    >(),
    routes = new Map<
      string,
      { frame: Frame; peer: ConsumerProcessIdentity; luid: string }
    >(),
    completedRoutes = new Map<
      string,
      { frame: Frame; peer: ConsumerProcessIdentity; luid: string }
    >();
  let closed = false;
  await bank.start();
  const readGpu =
    options.readRoleGpu ??
    ((role) =>
      role === "personal"
        ? readCurrentPersonalGpu(
            native,
            context.configuration.release,
            context.distribution === "microsoft-store"
              ? context.storeIssuer
              : undefined,
          )
        : readCurrentFleetGpu(
            native,
            context.configuration.release,
            context.distribution === "microsoft-store"
              ? context.storeIssuer
              : undefined,
          ));
  const open = (gpu: DirectmlGpuIdentity) => {
    if (brokers.has(gpu.luid)) return Promise.resolve(brokers.get(gpu.luid)!);
    let pending = opening.get(gpu.luid);
    if (!pending) {
      pending = bank
        .open(gpu.luid, async (stateKey) => {
          const value = await createSessionGpuAdmission(context, {
            gpu,
            stateKey,
            personal: options.personal,
            currentOwner: options.currentOwner,
            ...(options.certificateEvents
              ? { certificateEvents: options.certificateEvents }
              : {}),
          });
          return value;
        })
        .then((value) => {
          brokers.set(gpu.luid, value);
          return value;
        });
      opening.set(gpu.luid, pending);
      void pending.finally(() => opening.delete(gpu.luid)).catch(() => {});
    }
    return pending;
  };
  const reconcileSettledRoutes = () => {
    for (const [luid, value] of brokers) {
      for (const id of value.settledRequestIds()) {
        const previous = routes.get(id);
        if (!previous || previous.luid !== luid) continue;
        routes.delete(id);
        completedRoutes.set(id, previous);
        if (completedRoutes.size > 64)
          completedRoutes.delete(completedRoutes.keys().next().value!);
      }
    }
  };
  return {
    broker: {
      recover: async () => {
        for (const value of brokers.values()) await value.broker.recover();
        reconcileSettledRoutes();
      },
      snapshot: () => {
        const views = [...brokers.values()].map((value) =>
            value.broker.snapshot(),
          ),
          active = views.find((view) => view.state !== "idle");
        return {
          state: active?.state ?? (opening.size ? "starting" : "idle"),
          waiting: views.reduce((sum, view) => sum + view.waiting, 0),
          problem: active?.problem ?? null,
        };
      },
    },
    dispatch: async (payload, peer) => {
      if (closed) throw new Error("GPU_COORDINATION_UNAVAILABLE");
      const frame = parseFrame(payload),
        role = frame.ownerReceipt.role as "personal" | "fleet";
      await context.verifyOwnedPeer(frame.ownerReceipt, peer);
      reconcileSettledRoutes();
      const previous =
        routes.get(frame.requestId) ?? completedRoutes.get(frame.requestId);
      if (
        previous &&
        (previous.frame.generation !== frame.generation ||
          previous.frame.ownerReceipt.role !== frame.ownerReceipt.role ||
          previous.frame.ownerReceipt.nonce !== frame.ownerReceipt.nonce ||
          !sameConsumerProcess(
            previous.frame.ownerReceipt.identity,
            frame.ownerReceipt.identity,
          ) ||
          !sameConsumerProcess(previous.peer, peer))
      )
        throw new Error("GPU_OWNER_DENIED");
      let value;
      if (
        frame.action === "request_personal" ||
        frame.action === "request_fleet" ||
        frame.action === "status"
      ) {
        if (completedRoutes.has(frame.requestId) && frame.action !== "status")
          throw new Error("GPU_LEASE_STALE");
        const qualified = await readGpu(role),
          inventory = await native.enumerateGpus(),
          gpu = resolveQualifiedGpuIdentity(qualified, inventory);
        resolveQualifiedGpuIdentity(gpu, [frame.gpuIdentity]);
        if (previous && previous.luid !== gpu.luid)
          throw new Error("GPU_LEASE_STALE");
        if (
          !brokers.has(gpu.luid) &&
          !opening.has(gpu.luid) &&
          brokers.size + opening.size >= inventory.length
        )
          throw new Error("GPU_BUSY");
        value = await open(gpu);
        if (frame.action !== "status" && !previous) {
          if (routes.size >= 64) throw new Error("GPU_BUSY");
          routes.set(frame.requestId, {
            frame,
            peer: structuredClone(peer),
            luid: gpu.luid,
          });
        }
      } else {
        // Release remains possible after device/boot/model changes, using only
        // its immutable original owner/binding and positive cleanup certificate.
        if (!previous) throw new Error("GPU_LEASE_STALE");
        resolveQualifiedGpuIdentity(previous.frame.gpuIdentity, [
          frame.gpuIdentity,
        ]);
        value = brokers.get(previous.luid);
        if (!value) throw new Error("GPU_LEASE_STALE");
      }
      const result = await value.dispatch(payload, peer);
      if (
        ["release_personal", "fleet_yielded", "cancel"].includes(frame.action)
      ) {
        const reply = object(JSON.parse(result.toString("utf8")));
        if (reply.ok === true && previous) {
          routes.delete(frame.requestId);
          completedRoutes.set(frame.requestId, previous);
          if (completedRoutes.size > 64)
            completedRoutes.delete(completedRoutes.keys().next().value!);
        }
      }
      return result;
    },
    close: async () => {
      closed = true;
      await Promise.allSettled(opening.values());
      const settled = await Promise.allSettled(
        [...brokers.values()].map((value) => value.close()),
      );
      if (settled.some((value) => value.status === "rejected"))
        throw new Error("GPU_CHILDREN_STILL_ACTIVE");
      await native.close();
    },
  };
}
/** A single role-owned client identity is kept for the entire admission lifetime. */
export function createRoleGpuGateway(
  context: SessionChildContext,
): RoleGpuGateway {
  const generation = randomUUID();
  let opened: Promise<SessionClient> | undefined;
  const requests = new Map<string, DirectmlGpuIdentity>();
  const client = () =>
    (opened ??= (async () => new SessionClient(await context.openNative()))());
  const exchange = async (
    action: Action,
    jobId: string,
    gpu: DirectmlGpuIdentity,
    leaseNonce?: string,
  ) => {
    const frame: Frame = {
      version: 1,
      kind: "gpu-admission",
      action,
      requestId: jobId,
      generation,
      ownerReceipt: {
        role: context.role,
        nonce: context.ownershipNonce,
        identity: context.ownerIdentity,
      },
      gpuIdentity: gpu,
      ...(leaseNonce ? { leaseNonce } : {}),
    };
    let response: Buffer;
    if (context.distribution === "microsoft-store") {
      const issuer = context.storeIssuer;
      if (!issuer) throw new Error("GPU_OWNER_DENIED");
      StoreNodeIssuer.prototype.assertNative.call(issuer, context.native);
      const actual = issuer.owner;
      if (
        actual.role !== context.role ||
        actual.nonce !== context.ownershipNonce ||
        !sameConsumerProcess(actual.identity, context.ownerIdentity)
      )
        throw new Error("GPU_OWNER_DENIED");
      response = await StoreNodeIssuer.prototype.requestControl.call(
        issuer,
        "session",
        Buffer.from(JSON.stringify(frame)),
      );
      StoreNodeIssuer.prototype.assertNative.call(issuer, context.native);
      if (
        issuer.owner.nonce !== actual.nonce ||
        !sameConsumerProcess(issuer.owner.identity, actual.identity)
      )
        throw new Error("GPU_OWNER_DENIED");
    } else {
      response = await (
        await client()
      ).exchange(Buffer.from(JSON.stringify(frame)));
    }
    const reply = object(JSON.parse(response.toString("utf8")));
    if (
      reply.version !== 1 ||
      reply.kind !== "gpu-admission" ||
      reply.requestId !== jobId ||
      reply.ok !== true
    )
      throw new Error(
        typeof reply.error === "string" && /^[A-Z_]{1,64}$/u.test(reply.error)
          ? reply.error
          : "GPU_COORDINATION_UNAVAILABLE",
      );
    return reply;
  };
  return {
    acquire: async (request, signal, onWait) => {
      if (!UUID.test(request.jobId)) throw new Error("GPU_OWNER_DENIED");
      const gpu = parseDirectmlGpuIdentity(request.gpu);
      requests.set(request.jobId, gpu);
      let lastWaitReason: PersonalWaitReason | undefined;
      for (;;) {
        signal.throwIfAborted();
        const reply = await exchange(
          context.role === "personal" ? "request_personal" : "request_fleet",
          request.jobId,
          gpu,
        );
        signal.throwIfAborted();
        if (reply.pending === true) {
          const reason = reply.waitReason;
          if (
            reason !== undefined &&
            reason !== null &&
            reason !== "waiting-for-worker" &&
            reason !== "gpu-busy" &&
            reason !== "recovering"
          )
            throw new Error("GPU_COORDINATION_UNAVAILABLE");
          if (reason && reason !== lastWaitReason) {
            lastWaitReason = reason;
            try {
              onWait?.(reason);
            } catch {}
          }
          continue;
        }
        if (
          typeof reply.leaseNonce !== "string" ||
          !HASH.test(reply.leaseNonce) ||
          reply.gpuLuid !== gpu.luid
        )
          throw new Error("GPU_COORDINATION_UNAVAILABLE");
        signal.throwIfAborted();
        return {
          jobId: request.jobId,
          gpuLuid: gpu.luid,
          leaseNonce: reply.leaseNonce,
        };
      }
    },
    release: async (request) => {
      if (
        request.exited !== true ||
        request.cleaned !== true ||
        !HASH.test(request.leaseNonce)
      )
        throw new Error("GPU_CHILDREN_STILL_ACTIVE");
      const gpu = requests.get(request.jobId);
      if (!gpu) throw new Error("GPU_LEASE_STALE");
      await exchange(
        context.role === "personal" ? "release_personal" : "fleet_yielded",
        request.jobId,
        gpu,
        request.leaseNonce,
      );
      requests.delete(request.jobId);
    },
    cancelAfterCleanup: async (request) => {
      if (request.exited !== true || request.cleaned !== true)
        throw new Error("GPU_CHILDREN_STILL_ACTIVE");
      const gpu = requests.get(request.jobId);
      if (!gpu) return;
      await exchange("cancel", request.jobId, gpu);
      requests.delete(request.jobId);
    },
  };
}

export function createFleetPersonalAdmission(
  context: SessionChildContext,
): PersonalAdmission & { setPending(value: boolean): void } {
  if (context.role !== "fleet") throw new Error("GPU_OWNER_DENIED");
  const gateway = createRoleGpuGateway(context);
  let pending = true,
    closed = false,
    wake = () => {},
    lease: Awaited<ReturnType<RoleGpuGateway["acquire"]>> | undefined;
  const lifetime = new AbortController();
  let acquiring: Promise<void> | undefined;
  const acquire = () =>
    (acquiring ??= (async () => {
      try {
        const gpu = await readCurrentFleetGpu(
          context.native,
          context.distribution === "microsoft-store"
            ? context.storeIssuer!.inventorySha256
            : win32.basename(context.releaseRoot),
          context.distribution === "microsoft-store"
            ? context.storeIssuer
            : undefined,
        );
        lease = await gateway.acquire(
          { jobId: randomUUID(), gpu },
          lifetime.signal,
        );
        pending = false;
        wake();
      } finally {
        acquiring = undefined;
      }
    })());
  const release = async () => {
    if (!lease) return;
    const current = lease;
    await gateway.release({
      jobId: current.jobId,
      leaseNonce: current.leaseNonce,
      exited: true,
      cleaned: true,
    });
    lease = undefined;
    pending = true;
  };
  return {
    start: async (callback) => {
      wake = callback;
      if (closed) throw new Error("GPU_COORDINATION_UNAVAILABLE");
      await acquire();
    },
    pending: () => pending || !lease,
    setPending: (value) => {
      pending = value || !lease;
      wake();
    },
    grant: async () => {
      if (!pending) return;
      await release();
      if (!closed)
        void acquire().catch(() => {
          pending = true;
          wake();
        });
    },
    stop: async () => {
      closed = true;
      lifetime.abort();
      pending = true;
      setImmediate(() => {
        void release().catch(() => {});
      });
    },
  };
}
