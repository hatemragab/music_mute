import {
  isCurrentUserSid,
  processIdentityFromWire,
  processIdentityToWire,
  type ConsumerProcessIdentity,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  SESSION_MAX_RECEIPTS,
  SESSION_RESTART_LIMIT,
  type FleetIntent,
  type SessionRole,
} from "../../shared/session-contracts.js";
import type {
  RestartBudget,
  SessionPersistentState,
  SessionStatePort,
} from "./supervisor.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
function plainRecord(value: unknown): Record<string, unknown> {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(
        (descriptor) => !("value" in descriptor),
      )
    )
      throw new Error("STATE_UNAVAILABLE");
  } catch {
    throw new Error("STATE_UNAVAILABLE");
  }
  return value as Record<string, unknown>;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  const input = plainRecord(value);
  if (Object.keys(input).sort().join() !== keys.sort().join())
    throw new Error("STATE_UNAVAILABLE");
  return input;
}
function budget(value: unknown): RestartBudget {
  const input = record(value, ["attempts", "nextStartAt", "blocked"]);
  if (
    !Number.isInteger(input.attempts) ||
    (input.attempts as number) < 0 ||
    (input.attempts as number) > SESSION_RESTART_LIMIT ||
    !Number.isSafeInteger(input.nextStartAt) ||
    (input.nextStartAt as number) < 0 ||
    typeof input.blocked !== "boolean"
  )
    throw new Error("STATE_UNAVAILABLE");
  return input as unknown as RestartBudget;
}
export function parseSessionState(value: unknown): SessionPersistentState {
  // Previous pre-release consumer v1 state did not carry maintenance intent.
  const original = plainRecord(value);
  if (!Object.hasOwn(original, "maintenance"))
    value = { ...original, maintenance: null };
  const input = record(value, [
    "version",
    "sid",
    "revision",
    "fleetIntent",
    "restartPending",
    "maintenance",
    "owner",
    "budgets",
    "receipts",
  ]);
  if (
    input.version !== 1 ||
    typeof input.restartPending !== "boolean" ||
    !isCurrentUserSid(input.sid) ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 1 ||
    !["stopped", "paused", "draining", "running"].includes(
      input.fleetIntent as string,
    )
  )
    throw new Error("STATE_UNAVAILABLE");
  let maintenance: SessionPersistentState["maintenance"] = null;
  if (input.maintenance !== null) {
    const candidate = plainRecord(input.maintenance);
    const row = record(candidate, [
      "transaction",
      "peer",
      "idle",
      ...(Object.hasOwn(candidate, "force") ? ["force"] : []),
    ]);
    if (
      typeof row.idle !== "boolean" ||
      typeof row.transaction !== "string" ||
      !UUID.test(row.transaction)
    )
      throw new Error("STATE_UNAVAILABLE");
    const identity = record(row.peer, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]);
    try {
      const peer = processIdentityFromWire(
        processIdentityToWire(identity as unknown as ConsumerProcessIdentity),
      );
      if (peer.sid !== input.sid) throw new Error("STATE_UNAVAILABLE");
      maintenance = {
        transaction: row.transaction,
        peer,
        idle: row.idle as boolean,
      };
      if (Object.hasOwn(row, "force")) {
        const force = record(row.force, ["requestId", "reason", "owner"]);
        if (
          typeof force.requestId !== "string" ||
          !UUID.test(force.requestId) ||
          force.requestId !== row.transaction ||
          row.idle !== false ||
          typeof force.reason !== "string" ||
          !["stop", "restart", "update", "revoke"].includes(force.reason)
        )
          throw new Error("STATE_UNAVAILABLE");
        let owner = null;
        if (force.owner !== null) {
          const owned = record(force.owner, ["role", "nonce", "identity"]);
          if (
            owned.role !== "fleet" ||
            typeof owned.nonce !== "string" ||
            !/^[a-f0-9]{64}$/u.test(owned.nonce)
          )
            throw new Error("STATE_UNAVAILABLE");
          const identity = processIdentityFromWire(
            processIdentityToWire(
              record(owned.identity, [
                "sid",
                "sessionId",
                "pid",
                "creationTime",
              ]) as unknown as ConsumerProcessIdentity,
            ),
          );
          if (identity.sid !== input.sid) throw new Error("STATE_UNAVAILABLE");
          owner = { role: "fleet" as const, nonce: owned.nonce, identity };
        }
        maintenance.force = {
          requestId: force.requestId,
          reason: force.reason as "stop" | "restart" | "update" | "revoke",
          owner,
        };
      }
    } catch {
      throw new Error("STATE_UNAVAILABLE");
    }
  }
  const budgets = record(input.budgets, ["personal", "fleet"]);
  const parsedBudgets = Object.fromEntries(
    (["personal", "fleet"] as SessionRole[]).map((role) => [
      role,
      budget(budgets[role]),
    ]),
  ) as Record<SessionRole, RestartBudget>;
  let owner: SessionPersistentState["owner"] = null;
  if (input.owner !== null) {
    const owned = record(input.owner, ["nonce", "identity"]);
    if (typeof owned.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(owned.nonce))
      throw new Error("STATE_UNAVAILABLE");
    const identity = record(owned.identity, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]);
    try {
      owner = {
        nonce: owned.nonce,
        identity: processIdentityFromWire(
          processIdentityToWire(identity as unknown as ConsumerProcessIdentity),
        ),
      };
    } catch {
      throw new Error("STATE_UNAVAILABLE");
    }
    if (owner.identity.sid !== input.sid) throw new Error("STATE_UNAVAILABLE");
  }
  if (
    !Array.isArray(input.receipts) ||
    input.receipts.length > SESSION_MAX_RECEIPTS
  )
    throw new Error("STATE_UNAVAILABLE");
  const seen = new Set<string>();
  const receipts = input.receipts.map((value) => {
    const receipt = record(value, ["requestId", "digest"]);
    if (
      typeof receipt.requestId !== "string" ||
      !UUID.test(receipt.requestId) ||
      seen.has(receipt.requestId) ||
      typeof receipt.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(receipt.digest)
    )
      throw new Error("STATE_UNAVAILABLE");
    seen.add(receipt.requestId);
    return { requestId: receipt.requestId, digest: receipt.digest };
  });
  if (maintenance?.force && !seen.has(maintenance.force.requestId))
    throw new Error("STATE_UNAVAILABLE");
  return {
    version: 1,
    sid: input.sid,
    revision: input.revision as number,
    fleetIntent: input.fleetIntent as FleetIntent,
    restartPending: input.restartPending,
    maintenance,
    owner,
    budgets: parsedBudgets,
    receipts,
  };
}

/** Atomic native DPAPI writes. This state never depends on app Google login. */
export class VaultSessionStateStore implements SessionStatePort {
  constructor(
    private readonly native: Pick<
      WindowsConsumerNative,
      "vaultRead" | "vaultWrite"
    >,
  ) {}
  async read(): Promise<SessionPersistentState | null> {
    const bytes = await this.native.vaultRead("fleet", "session_state");
    if (bytes === null) return null;
    try {
      if (bytes.byteLength > 16_384) throw new Error("STATE_UNAVAILABLE");
      return parseSessionState(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          16_384,
        ),
      );
    } catch {
      throw new Error("STATE_UNAVAILABLE");
    } finally {
      bytes.fill(0);
    }
  }
  async write(state: SessionPersistentState): Promise<void> {
    const validated = parseSessionState(state);
    const bytes = Buffer.from(JSON.stringify(validated));
    try {
      if (bytes.byteLength > 16_384) throw new Error("STATE_UNAVAILABLE");
      await this.native.vaultWrite("fleet", "session_state", bytes);
    } finally {
      bytes.fill(0);
    }
  }
}
