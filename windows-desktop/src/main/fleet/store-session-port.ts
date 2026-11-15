import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  processIdentityFromWire,
  type ConsumerOwnedProcess,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  ControlPlaneError,
  WorkerControlPlaneClient,
} from "../../../../worker/src/runtime/control-plane-client.js";
import type { FleetSessionControlPort } from "../../agent/fleet.js";
import { StoreRuntimeContext } from "../session/store-runtime-context.js";
import { StoreNodeIssuer } from "../session/store-node-issuer.js";
import { VaultFleetStore } from "./store.js";
import { consumerFleetRemoved } from "./advanced/removal-marker.js";
import { readStoreFleetRuntimeIdentity } from "./store-active-runtime.js";
import {
  parseFleetChildCommand,
  parseFleetChildReply,
  type FleetChildCommand,
} from "./channel.js";

const DENIED = "STORE_SESSION_CONTEXT_DENIED";
function dataProperties(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(DENIED);
  const prototype = Object.getPrototypeOf(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some(
      (field) =>
        !descriptors[field]?.enumerable || !("value" in descriptors[field]),
    )
  )
    throw new Error(DENIED);
  return Object.fromEntries(
    fields.map((field) => [field, descriptors[field]!.value]),
  );
}
function originalFleetOwner(value: ConsumerOwnedProcess): ConsumerOwnedProcess {
  const row = dataProperties(value, ["role", "nonce", "identity"]),
    identity = dataProperties(row.identity, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]);
  if (
    row.role !== "fleet" ||
    typeof row.nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.nonce)
  )
    throw new Error(DENIED);
  return Object.freeze({
    role: "fleet" as const,
    nonce: row.nonce,
    identity: Object.freeze(
      processIdentityFromWire({
        sid: identity.sid,
        session_id: identity.sessionId,
        pid: identity.pid,
        creation_time: identity.creationTime,
      }),
    ),
  });
}
function originalFleetCommand(
  input: Omit<FleetChildCommand, "version" | "requestId">,
): FleetChildCommand {
  const action = Object.getOwnPropertyDescriptor(input, "action");
  if (!action || !("value" in action) || typeof action.value !== "string")
    throw new Error("FLEET_CHANNEL_INVALID");
  const additional =
      action.value === "intent"
        ? ["intent"]
        : action.value === "admission_pending"
          ? ["pending"]
          : action.value === "guard_acquire"
            ? ["gpuLuid"]
            : action.value === "guard_release"
              ? ["guardNonce"]
              : [],
    row = dataProperties(input, ["action", ...additional]);
  if (
    Object.entries(row).some(
      ([key, value]) =>
        typeof value !== (key === "pending" ? "boolean" : "string"),
    )
  )
    throw new Error("FLEET_CHANNEL_INVALID");
  return Object.freeze(
    parseFleetChildCommand(
      Buffer.from(
        JSON.stringify({ ...row, version: 1, requestId: randomUUID() }),
      ),
    ),
  );
}
function association(context: StoreRuntimeContext) {
  // Inspect a data property without invoking a caller getter, then require the
  // real private context and its exact issuer-owned helper before any IO.
  const descriptor = Object.getOwnPropertyDescriptor(context, "native");
  if (!descriptor || !("value" in descriptor)) throw new Error(DENIED);
  const native = descriptor.value as WindowsConsumerNative;
  StoreRuntimeContext.prototype.assertNative.call(context, native);
  const issuer = context.storeIssuer,
    role = Object.getOwnPropertyDescriptor(
      StoreNodeIssuer.prototype,
      "nodeRole",
    )!.get!.call(issuer);
  if (role !== "session-agent") throw new Error(DENIED);
  StoreNodeIssuer.prototype.assertNative.call(issuer, native);
  return { native, issuer };
}
async function current(context: StoreRuntimeContext) {
  const { native, issuer } = association(context),
    view = await StoreNodeIssuer.prototype.codeView.call(issuer);
  association(context);
  if (
    context.distribution !== "microsoft-store" ||
    context.generation !== issuer.inventorySha256 ||
    context.configuration.release !== issuer.inventorySha256 ||
    !isDeepStrictEqual(context.binding, view.binding)
  )
    throw new Error(DENIED);
  return { native, issuer };
}

/** Parent business port over the actual Store Creator's owned Fleet channel.
 * Enrollment and backend approval retain their existing policy. No private
 * executable configuration, legacy control ticket or archive is published. */
export function openStoreFleetSessionPort(
  context: StoreRuntimeContext,
): FleetSessionControlPort {
  if (arguments.length !== 1) throw new Error(DENIED);
  association(context);
  const command = async (
    owner: ConsumerOwnedProcess,
    input: Omit<FleetChildCommand, "version" | "requestId">,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const originalOwner = originalFleetOwner(owner),
      request = originalFleetCommand(input),
      deadline = AbortSignal.any([signal, AbortSignal.timeout(9000)]),
      { issuer } = await current(context);
    await StoreRuntimeContext.prototype.verifyOwnedPeer.call(
      context,
      originalOwner,
      originalOwner.identity,
    );
    deadline.throwIfAborted();
    const bytes = await StoreNodeIssuer.prototype.requestControl.call(
      issuer,
      "fleet",
      Buffer.from(JSON.stringify(request)),
      deadline,
      originalOwner,
    );
    // A reply from a retired/replaced tree cannot describe the current worker.
    await StoreRuntimeContext.prototype.verifyOwnedPeer.call(
      context,
      originalOwner,
      originalOwner.identity,
    );
    await current(context);
    deadline.throwIfAborted();
    return parseFleetChildReply(bytes, request.requestId);
  };
  const port: FleetSessionControlPort = {
    command,
    eligibility: async () => {
      const { native, issuer } = await current(context),
        host = await native.identity(),
        record = await new VaultFleetStore(native, host.sid).read();
      if (
        !record ||
        !record.machineCredential ||
        record.phase !== "complete" ||
        (await consumerFleetRemoved(native, record))
      )
        return { enrolled: false, approved: false, prepared: false };
      let prepared = false,
        active:
          Awaited<ReturnType<typeof readStoreFleetRuntimeIdentity>> | undefined;
      try {
        active = await readStoreFleetRuntimeIdentity(
          issuer,
          record,
          new AbortController().signal,
        );
        prepared =
          active.release === context.generation &&
          isDeepStrictEqual(active.storeBinding, context.binding);
      } catch {
        // Unbound, stale or unqualified Store state never permits a launch.
      }
      await current(context);
      const control = new WorkerControlPlaneClient({
        baseUrl: record.backendOrigin,
        credential: record.machineCredential,
        maxAttempts: 1,
      });
      let approved: boolean;
      try {
        const status = await control.machineStatus();
        approved = status.machineId === record.machineId;
      } catch (error) {
        // Preserve the existing enrolled worker's transient-network policy;
        // explicit revocation always denies admission and no error grants Ready.
        approved =
          error instanceof ControlPlaneError &&
          error.status !== 401 &&
          error.status !== 403 &&
          error.code !== "WORKER_MACHINE_DELETED" &&
          error.retryable;
      }
      await current(context);
      const latestRecord = await new VaultFleetStore(native, host.sid).read();
      if (
        !isDeepStrictEqual(record, latestRecord) ||
        (await consumerFleetRemoved(native, record))
      )
        return { enrolled: false, approved: false, prepared: false };
      if (prepared && active) {
        try {
          const latestActive = await readStoreFleetRuntimeIdentity(
            issuer,
            record,
            new AbortController().signal,
          );
          prepared = isDeepStrictEqual(active, latestActive);
        } catch {
          prepared = false;
        }
      }
      await current(context);
      return { enrolled: true, approved, prepared };
    },
    reconcile: async (owner, signal) => {
      await command(owner, { action: "reconcile" }, signal);
    },
    setIntent: async (owner, intent, signal) => {
      await command(owner, { action: "intent", intent }, signal);
    },
    gracefulStop: async (owner, signal) => {
      await command(owner, { action: "stop" }, signal);
    },
    pauseForSleep: async (owner, signal) => {
      await command(owner, { action: "sleep" }, signal);
    },
  };
  return Object.freeze(port);
}
