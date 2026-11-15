export const SESSION_PROTOCOL_VERSION = 1;
export const SESSION_MAX_COMMAND_BYTES = 4096;
export const SESSION_MAX_RECEIPTS = 32;
export const SESSION_RESTART_LIMIT = 5;
export type FleetIntent = "stopped" | "paused" | "draining" | "running";
export type SessionRole = "personal" | "fleet";
export type StartupState =
  "absent" | "registered" | "disabled" | "conflict" | "unknown";
export type SessionPhase =
  "starting" | "running" | "sleeping" | "recovering" | "blocked" | "logged-out";
export type SessionProblem =
  | "NOT_ENROLLED"
  | "APPROVAL_REQUIRED"
  | "PREPARE_REQUIRED"
  | "LEGACY_WORKER_CONFLICT"
  | "RESTART_BUDGET_EXHAUSTED"
  | "CHILD_CREATION_FAILED"
  | "CLAIM_RECONCILIATION_FAILED"
  | "CHILD_SHUTDOWN_PENDING"
  | "STATE_UNAVAILABLE"
  | "SESSION_IDENTITY_CONFLICT"
  | null;
export interface SessionAccountScope {
  firebaseUid: string;
  generation: string;
}
export interface SessionSnapshot {
  version: 1;
  instance_id: string;
  release: string;
  revision: number;
  phase: SessionPhase;
  fleet: {
    intent: FleetIntent;
    phase:
      | "absent"
      | "stopped"
      | "starting"
      | "running"
      | "paused"
      | "draining"
      | "recovering"
      | "blocked";
    problem: SessionProblem;
  };
  personal: {
    owners: number;
    phase: "stopped" | "starting" | "running" | "recovering" | "blocked";
    problem: SessionProblem;
  };
  startup: StartupState;
  maintenance: { transaction: string; phase: "draining" | "idle" } | null;
}
export type SessionCommand = { version: 1; request_id: string } & (
  | { action: "status" }
  | { action: "wait_state"; after_revision: number; instance_id?: string }
  | { action: "fleet_intent"; intent: FleetIntent }
  | { action: "fleet_restart" }
  | {
      action: "fleet_force";
      reason: "stop" | "restart" | "update" | "revoke";
      machine_id: string;
      authority: string;
      expected_revision: number;
      confirmation: string;
    }
  | {
      action: "maintenance_begin" | "maintenance_end" | "maintenance_commit";
      transaction: string;
    }
  | { action: "maintenance_resume"; transaction: string; instance_id: string }
  | {
      action: "personal_attach";
      owner_id: string;
      owner_kind: "desktop" | "chrome";
    }
  | { action: "personal_detach"; owner_id: string }
  | { action: "account_scope"; scope: SessionAccountScope | null }
);
export type SessionReply =
  | { version: 1; request_id: string; ok: true; snapshot: SessionSnapshot }
  | {
      version: 1;
      request_id: string;
      ok: false;
      error: {
        code:
          | "INVALID_COMMAND"
          | "REQUEST_ID_REUSED"
          | "PEER_DENIED"
          | "SESSION_UNAVAILABLE"
          | "STATE_UNAVAILABLE"
          | "CHILD_SHUTDOWN_PENDING"
          | "FORCE_CONFIRMATION_STALE"
          | "UPDATE_BUSY";
      };
    };
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const intents: readonly string[] = ["stopped", "paused", "draining", "running"];
export function parseSessionCommand(bytes: Uint8Array): SessionCommand {
  if (bytes.byteLength > SESSION_MAX_COMMAND_BYTES)
    throw new Error("INVALID_COMMAND");
  let value: unknown;
  try {
    value = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      SESSION_MAX_COMMAND_BYTES,
    );
  } catch {
    throw new Error("INVALID_COMMAND");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_COMMAND");
  const wire = value as Record<string, unknown>;
  if (
    wire.version !== 1 ||
    typeof wire.request_id !== "string" ||
    !UUID.test(wire.request_id)
  )
    throw new Error("INVALID_COMMAND");
  const base = { version: 1 as const, request_id: wire.request_id };
  const exact = (fields: string[]) => {
    if (
      Object.keys(wire).sort().join() !==
      ["version", "request_id", "action", ...fields].sort().join()
    )
      throw new Error("INVALID_COMMAND");
  };
  switch (wire.action) {
    case "status":
      exact([]);
      return { ...base, action: "status" };
    case "wait_state":
      exact(
        wire.instance_id === undefined
          ? ["after_revision"]
          : ["after_revision", "instance_id"],
      );
      if (
        !Number.isSafeInteger(wire.after_revision) ||
        (wire.after_revision as number) < 0 ||
        (wire.instance_id !== undefined &&
          (typeof wire.instance_id !== "string" ||
            !UUID.test(wire.instance_id)))
      )
        throw new Error("INVALID_COMMAND");
      return {
        ...base,
        action: "wait_state",
        after_revision: wire.after_revision as number,
        ...(wire.instance_id === undefined
          ? {}
          : { instance_id: wire.instance_id as string }),
      };
    case "fleet_restart":
      exact([]);
      return { ...base, action: "fleet_restart" };
    case "fleet_force":
      exact([
        "reason",
        "machine_id",
        "authority",
        "expected_revision",
        "confirmation",
      ]);
      if (
        !["stop", "restart", "update", "revoke"].includes(
          String(wire.reason),
        ) ||
        typeof wire.machine_id !== "string" ||
        !UUID.test(wire.machine_id) ||
        typeof wire.authority !== "string" ||
        !/^[a-f0-9]{64}$/u.test(wire.authority) ||
        typeof wire.confirmation !== "string" ||
        !UUID.test(wire.confirmation) ||
        wire.confirmation !== wire.request_id ||
        !Number.isSafeInteger(wire.expected_revision) ||
        (wire.expected_revision as number) < 0
      )
        throw new Error("INVALID_COMMAND");
      return {
        ...base,
        action: "fleet_force",
        reason: wire.reason as "stop" | "restart" | "update" | "revoke",
        machine_id: wire.machine_id,
        authority: wire.authority,
        expected_revision: wire.expected_revision as number,
        confirmation: wire.confirmation,
      };
    case "maintenance_resume":
      exact(["transaction", "instance_id"]);
      if (
        typeof wire.transaction !== "string" ||
        !UUID.test(wire.transaction) ||
        typeof wire.instance_id !== "string" ||
        !UUID.test(wire.instance_id)
      )
        throw new Error("INVALID_COMMAND");
      return {
        ...base,
        action: "maintenance_resume",
        transaction: wire.transaction,
        instance_id: wire.instance_id,
      };
    case "maintenance_begin":
    case "maintenance_end":
    case "maintenance_commit":
      exact(["transaction"]);
      if (typeof wire.transaction !== "string" || !UUID.test(wire.transaction))
        throw new Error("INVALID_COMMAND");
      return { ...base, action: wire.action, transaction: wire.transaction };
    case "fleet_intent":
      exact(["intent"]);
      if (typeof wire.intent !== "string" || !intents.includes(wire.intent))
        throw new Error("INVALID_COMMAND");
      return {
        ...base,
        action: "fleet_intent",
        intent: wire.intent as FleetIntent,
      };
    case "personal_attach":
      exact(["owner_id", "owner_kind"]);
      if (
        typeof wire.owner_id !== "string" ||
        !UUID.test(wire.owner_id) ||
        (wire.owner_kind !== "desktop" && wire.owner_kind !== "chrome")
      )
        throw new Error("INVALID_COMMAND");
      return {
        ...base,
        action: "personal_attach",
        owner_id: wire.owner_id,
        owner_kind: wire.owner_kind,
      };
    case "personal_detach":
      exact(["owner_id"]);
      if (typeof wire.owner_id !== "string" || !UUID.test(wire.owner_id))
        throw new Error("INVALID_COMMAND");
      return { ...base, action: "personal_detach", owner_id: wire.owner_id };
    case "account_scope": {
      exact(["scope"]);
      if (wire.scope === null)
        return { ...base, action: "account_scope", scope: null };
      if (
        !wire.scope ||
        typeof wire.scope !== "object" ||
        Array.isArray(wire.scope)
      )
        throw new Error("INVALID_COMMAND");
      const scope = wire.scope as Record<string, unknown>;
      if (
        Object.keys(scope).sort().join() !== "firebaseUid,generation" ||
        typeof scope.firebaseUid !== "string" ||
        scope.firebaseUid.length < 1 ||
        scope.firebaseUid.length > 128 ||
        [...scope.firebaseUid].some((c) => c.charCodeAt(0) < 32) ||
        typeof scope.generation !== "string" ||
        !UUID.test(scope.generation)
      )
        throw new Error("INVALID_COMMAND");
      return {
        ...base,
        action: "account_scope",
        scope: { firebaseUid: scope.firebaseUid, generation: scope.generation },
      };
    }
    default:
      throw new Error("INVALID_COMMAND");
  }
}
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
