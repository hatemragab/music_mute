import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  sameConsumerProcess,
  processIdentityFromWire,
  type ConsumerOwnedProcess,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type {
  SessionControlTicket,
  SessionRuntimeContext,
} from "../session/context.js";
export type FleetChildCommand = {
  version: 1;
  requestId: string;
  action:
    | "reconcile"
    | "intent"
    | "stop"
    | "sleep"
    | "admission_pending"
    | "inference_proof"
    | "guard_acquire"
    | "guard_release";
  pending?: boolean;
  gpuLuid?: string;
  guardNonce?: string;
  intent?: "running" | "paused" | "draining";
};
export interface FleetChildReply {
  version: 1;
  requestId: string;
  ok: boolean;
  code: string | null;
  data?: { idle: boolean; held: boolean; guardNonce: string | null };
}
export const FLEET_CHANNEL_ERROR_CODES = new Set([
  "FLEET_DRAIN_PENDING",
  "FLEET_CONTROL_UNAVAILABLE",
  "FLEET_INFERENCE_ACTIVE",
  "FLEET_GPU_BUSY",
  "FLEET_GPU_REQUALIFICATION_REQUIRED",
  "FLEET_GUARD_STALE",
  "FLEET_GPU_INVALID",
  "FLEET_REQUEST_REUSED",
]);
export function safeFleetChannelError(error: unknown): string {
  return error instanceof Error && FLEET_CHANNEL_ERROR_CODES.has(error.message)
    ? error.message
    : "FLEET_CONTROL_UNAVAILABLE";
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("FLEET_CHANNEL_INVALID");
  return value as Record<string, unknown>;
}
export function parseFleetChildCommand(bytes: Uint8Array): FleetChildCommand {
  if (bytes.length < 2 || bytes.length > 2048)
    throw new Error("FLEET_CHANNEL_INVALID");
  let row: Record<string, unknown>;
  try {
    row = object(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
        2048,
        128,
      ),
    );
  } catch {
    throw new Error("FLEET_CHANNEL_INVALID");
  }
  if (
    row.version !== 1 ||
    typeof row.requestId !== "string" ||
    !UUID.test(row.requestId) ||
    ![
      "reconcile",
      "intent",
      "stop",
      "sleep",
      "admission_pending",
      "inference_proof",
      "guard_acquire",
      "guard_release",
    ].includes(String(row.action)) ||
    Object.keys(row).some(
      (k) =>
        ![
          "version",
          "requestId",
          "action",
          ...(row.action === "intent" ? ["intent"] : []),
          ...(row.action === "admission_pending" ? ["pending"] : []),
          ...(row.action === "guard_acquire" ? ["gpuLuid"] : []),
          ...(row.action === "guard_release" ? ["guardNonce"] : []),
        ].includes(k),
    ) ||
    (row.action === "guard_acquire" &&
      (typeof row.gpuLuid !== "string" ||
        !/^[a-f0-9]{16}$/.test(row.gpuLuid))) ||
    (row.action === "guard_release" &&
      (typeof row.guardNonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.guardNonce))) ||
    (row.action === "admission_pending" && typeof row.pending !== "boolean") ||
    (row.action === "intent" &&
      !["running", "paused", "draining"].includes(String(row.intent)))
  )
    throw new Error("FLEET_CHANNEL_INVALID");
  return row as unknown as FleetChildCommand;
}
export function fleetCommandDigest(command: FleetChildCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}
/** Receiving observations shared by the legacy pipe and genuine Store channel. */
export function parseFleetChildReply(
  bytes: Uint8Array,
  requestId: string,
): FleetChildReply["data"] | undefined {
  if (bytes.length < 2 || bytes.length > 2048 || !UUID.test(requestId))
    throw new Error("FLEET_CHANNEL_INVALID");
  let reply: Record<string, unknown>;
  try {
    reply = object(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
        2048,
        128,
      ),
    );
  } catch {
    throw new Error("FLEET_CHANNEL_INVALID");
  }
  if (
    ![4, 5].includes(Object.keys(reply).length) ||
    Object.keys(reply).some(
      (key) => !["version", "requestId", "ok", "code", "data"].includes(key),
    ) ||
    reply.version !== 1 ||
    reply.requestId !== requestId ||
    typeof reply.ok !== "boolean" ||
    (reply.code !== null && typeof reply.code !== "string") ||
    (reply.ok && reply.code !== null)
  )
    throw new Error("FLEET_CHANNEL_INVALID");
  if (!reply.ok)
    throw new Error(
      typeof reply.code === "string" &&
        FLEET_CHANNEL_ERROR_CODES.has(reply.code)
        ? reply.code
        : "FLEET_CONTROL_UNAVAILABLE",
    );
  if (reply.data === undefined) return undefined;
  const data = object(reply.data);
  if (
    Object.keys(data).sort().join() !== "guardNonce,held,idle" ||
    typeof data.idle !== "boolean" ||
    typeof data.held !== "boolean" ||
    (data.guardNonce !== null &&
      (typeof data.guardNonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.guardNonce))) ||
    data.held !== (data.guardNonce !== null)
  )
    throw new Error("FLEET_CHANNEL_INVALID");
  return {
    idle: data.idle,
    held: data.held,
    guardNonce: data.guardNonce as string | null,
  };
}
function ticketIdentity(value: unknown) {
  const row = object(value);
  if (
    Object.keys(row).length !== 4 ||
    Object.keys(row).some(
      (key) => !["sid", "sessionId", "pid", "creationTime"].includes(key),
    )
  )
    throw new Error("FLEET_CHANNEL_INVALID");
  return processIdentityFromWire({
    sid: row.sid,
    session_id: row.sessionId,
    pid: row.pid,
    creation_time: row.creationTime,
  });
}
export function parseFleetTicket(
  value: unknown,
  owner: ConsumerOwnedProcess,
  now = Date.now(),
): SessionControlTicket {
  const row = object(value),
    candidate = object(row.owner);
  if (
    Object.keys(row).length !== 6 ||
    row.version !== 1 ||
    Object.keys(candidate).length !== 3 ||
    candidate.role !== "fleet" ||
    candidate.nonce !== owner.nonce ||
    typeof row.channel !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.channel) ||
    typeof row.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.nonce) ||
    !Number.isSafeInteger(row.expiresAt) ||
    (row.expiresAt as number) <= now ||
    (row.expiresAt as number) > now + 35000
  )
    throw new Error("FLEET_CHANNEL_INVALID");
  const identity = ticketIdentity(candidate.identity);
  const server = ticketIdentity(row.server);
  if (
    !sameConsumerProcess(identity, owner.identity) ||
    server.sid !== owner.identity.sid ||
    server.sessionId !== owner.identity.sessionId
  )
    throw new Error("FLEET_CHANNEL_INVALID");
  return {
    version: 1,
    owner,
    server,
    channel: row.channel,
    nonce: row.nonce,
    expiresAt: row.expiresAt as number,
  };
}
/** Protected ticket plus exact native Job membership; no socket port or secret environment. */
export async function requestFleetCommand(
  context: SessionRuntimeContext,
  owner: ConsumerOwnedProcess,
  command: Omit<FleetChildCommand, "version" | "requestId">,
  signal: AbortSignal,
): Promise<FleetChildReply["data"] | undefined> {
  const request: FleetChildCommand = {
    version: 1,
    requestId: randomUUID(),
    ...command,
  };
  const payload = Buffer.from(JSON.stringify(request));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(9000)]);
  for (let attempt = 0; attempt < 8; attempt++) {
    deadline.throwIfAborted();
    const bytes = await context.native.vaultRead("fleet", "fleet_ticket");
    if (!bytes || bytes.length > 4096) {
      await delay(100, undefined, { signal: deadline });
      continue;
    }
    let ticket: SessionControlTicket;
    try {
      ticket = parseFleetTicket(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        owner,
      );
    } catch {
      await delay(100, undefined, { signal: deadline });
      continue;
    }
    await context.verifyOwnedPeer(owner, ticket.server);
    const client = await context.openNative();
    try {
      const result = await client.pipeConnect({
        channel: ticket.channel,
        nonce: ticket.nonce,
        peer: ticket.server,
        payload,
        timeoutMs: 8000,
      });
      deadline.throwIfAborted();
      return parseFleetChildReply(result, request.requestId);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "FLEET_CHANNEL_INVALID" ||
          FLEET_CHANNEL_ERROR_CODES.has(error.message))
      )
        throw error;
      if (attempt === 7) throw new Error("FLEET_CONTROL_UNAVAILABLE");
    } finally {
      await client.close();
    }
    await delay(100, undefined, { signal: deadline });
  }
  throw new Error("FLEET_CONTROL_UNAVAILABLE");
}

export async function sendFleetCommand(
  context: SessionRuntimeContext,
  owner: ConsumerOwnedProcess,
  command: Omit<FleetChildCommand, "version" | "requestId">,
  signal: AbortSignal,
): Promise<void> {
  await requestFleetCommand(context, owner, command, signal);
}
