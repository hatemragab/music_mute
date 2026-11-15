import { describe, expect, it } from "vitest";
import {
  storeGuiControlCommand,
  parseStoreControlEvent,
  parseStoreControlReceived,
  storeControlReplyBytes,
  parseStoreControlDelivery,
} from "../src/shared/store-control-contracts.js";
import { StoreRuntimeContext } from "../src/main/session/store-runtime-context.js";
import { StoreSessionClient } from "../src/main/session/store-session-client.js";
import {
  StoreNodeIssuer,
  StorePersonalEngineChild,
} from "../src/main/session/store-node-issuer.js";
const id = "12345678-1234-4234-8234-123456789012",
  token = "a".repeat(64);
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
describe("Store control receiving policy, no OS authority fixture", () => {
  it("keeps retired transport delivery distinct from an actual delivered reply", () => {
    expect(parseStoreControlDelivery({ accepted: true })).toBe(true);
    expect(
      parseStoreControlDelivery({ accepted: true, transport_retired: true }),
    ).toBe(false);
    for (const value of [
      null,
      true,
      {},
      { accepted: false },
      { accepted: true, transport_retired: false },
      { accepted: true, transport_retired: true, job: "confirmed" },
      { accepted: true, ready: true },
      { accepted: true, transport_retired: 1 },
    ])
      expect(() => parseStoreControlDelivery(value)).toThrow(
        "STORE_CONTROL_CONTRACT_DENIED",
      );
    const getter = Object.defineProperty(
      { accepted: true },
      "transport_retired",
      {
        enumerable: true,
        get: () => {
          throw new Error("GETTER_MUST_NOT_RUN");
        },
      },
    );
    expect(() => parseStoreControlDelivery(getter)).toThrow(
      "STORE_CONTROL_CONTRACT_DENIED",
    );
  });
  it("cannot mint a protected engine child from receipts, transports or a copied issuer prototype", async () => {
    expect(() =>
      Reflect.construct(StorePersonalEngineChild, [
        Symbol("caller"),
        { nodeRole: "personal", owner: { role: "personal" } },
        { request: () => ({ started: true }) },
        { request: () => ({ eof: true }) },
        "personal\\engine-session\\" + id + "\\engine-config.json",
      ]),
    ).toThrow("STORE_NODE_ISSUER_DENIED");
    await expect(
      Reflect.apply(
        StoreNodeIssuer.prototype.createPersonalEngine,
        Object.create(StoreNodeIssuer.prototype),
        ["C:\\private\\engine-config.json"],
      ),
    ).rejects.toThrow();
  });
  it("retains existing typed control commands without selecting a caller peer", () => {
    for (const command of [
      { version: 1, request_id: id, action: "status" },
      {
        version: 1,
        request_id: id,
        action: "maintenance_begin",
        transaction: id,
      },
      {
        version: 1,
        request_id: id,
        action: "maintenance_end",
        transaction: id,
      },
      {
        version: 1,
        request_id: id,
        action: "maintenance_resume",
        transaction: id,
        instance_id: id,
      },
      {
        version: 1,
        request_id: id,
        action: "wait_state",
        after_revision: 3,
        instance_id: id,
      },
      { version: 1, request_id: id, action: "account_scope", scope: null },
    ]) {
      const result = storeGuiControlCommand(bytes(command), id);
      expect(Buffer.from(result.payload_base64, "base64")).toEqual(
        bytes(command),
      );
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).not.toBeInstanceOf(StoreSessionClient);
    }
  });
  it("receives distinct Chrome expectations without minting a browser client", () => {
    const attach = {
      version: 1,
      request_id: id,
      action: "personal_attach",
      owner_id: id,
      owner_kind: "chrome",
    };
    expect(storeGuiControlCommand(bytes(attach), id).action).toBe(
      "session_forward",
    );
    const command = {
      version: 1,
      kind: "personal-command",
      owner_kind: "chrome",
      command: { version: 1, requestId: id, action: "status" },
    };
    expect(storeGuiControlCommand(bytes(command), id).action).toBe(
      "session_forward",
    );
  });
  it("rejects unknown commands, legacy retirement, selected original peers and unknown owner kinds", () => {
    for (const value of [
      { version: 1, request_id: id, action: "execute", path: "cmd.exe" },
      {
        version: 1,
        request_id: id,
        action: "maintenance_commit",
        transaction: id,
      },
      { version: 1, request_id: id, action: "status", original_peer: {} },
      {
        version: 1,
        request_id: id,
        action: "personal_attach",
        owner_id: id,
        owner_kind: "worker",
      },
      {
        version: 1,
        kind: "personal-command",
        owner_kind: "worker",
        command: { version: 1, requestId: id, action: "status" },
      },
      {
        version: 1,
        kind: "personal-command",
        owner_kind: "desktop",
        command: {
          version: 1,
          requestId: id,
          action: "guard_status",
          jobId: id,
        },
      },
      {
        version: 1,
        kind: "personal-command",
        owner_kind: "desktop",
        command: { version: 1, requestId: id, action: "status" },
        original_peer: {},
      },
    ])
      expect(() => storeGuiControlCommand(bytes(value), id)).toThrow(
        "STORE_CONTROL_CONTRACT_DENIED",
      );
    for (const input of [
      Buffer.from('{"version":1,"version":1}'),
      Buffer.from([0xff]),
      Buffer.from("\ufeff{}"),
      Buffer.alloc(4097, 32),
    ])
      expect(() => storeGuiControlCommand(input, id)).toThrow(
        "STORE_CONTROL_CONTRACT_DENIED",
      );
  });
  it("accepts only request-bound complete events and canonical bounded result bytes", () => {
    expect(
      parseStoreControlEvent(
        { version: 1, requestId: id, state: "waiting" },
        id,
      ),
    ).toBeNull();
    const result = bytes({ version: 1, measured: 1.25 });
    expect(
      parseStoreControlEvent(
        {
          version: 1,
          requestId: id,
          state: "completed",
          payload_base64: result.toString("base64"),
        },
        id,
      ),
    ).toEqual(result);
    for (const value of [
      { version: 1, requestId: id, state: "waiting", payload_base64: "e30=" },
      {
        version: 1,
        requestId: "00000000-1234-4234-8234-123456789012",
        state: "waiting",
      },
      {
        version: 1,
        requestId: id,
        state: "completed",
        payload_base64: "e30=\n",
      },
      { version: 1, requestId: id, state: "completed", payload_base64: "e31=" },
      {
        version: 1,
        requestId: id,
        state: "completed",
        payload_base64: Buffer.from("\ufeff{}").toString("base64"),
      },
      {
        version: 1,
        requestId: id,
        state: "completed",
        payload_base64: Buffer.from('{"x":1,"x":2}').toString("base64"),
      },
    ])
      expect(() => parseStoreControlEvent(value, id)).toThrow(
        "STORE_CONTROL_CONTRACT_DENIED",
      );
    expect(() => storeControlReplyBytes(Buffer.alloc(32769, 32))).toThrow(
      "STORE_CONTROL_CONTRACT_DENIED",
    );
  });
  it("reads actual-transport peer observations without turning them into an issuer", () => {
    const row = {
      version: 1,
      token,
      payload_base64: "e30=",
      peer: {
        sid: "S-1-12-1-100-200-300-400",
        session_id: 1,
        pid: 123,
        creation_time: "132000000000000001",
      },
    };
    const received = parseStoreControlReceived(row)!;
    expect(received.peer.pid).toBe(123);
    expect(received.payload.toString()).toBe("{}");
    expect(received).not.toBeInstanceOf(StoreRuntimeContext);
    for (const value of [
      { ...row, token: token.toUpperCase() },
      { ...row, source_role: "session-agent" },
      { ...row, peer: { ...row.peer, pid: 0 } },
      { ...row, payload_base64: Buffer.alloc(4097, 32).toString("base64") },
    ])
      expect(() => parseStoreControlReceived(value)).toThrow(
        "STORE_CONTROL_CONTRACT_DENIED",
      );
  });
  it("forged contexts and structural clients cannot gain control or helper membership", async () => {
    expect(() =>
      Reflect.construct(StoreRuntimeContext, [Symbol(), {}]),
    ).toThrow("STORE_SESSION_CONTEXT_DENIED");
    await expect(
      StoreRuntimeContext.prototype.openNative.call({} as StoreRuntimeContext),
    ).rejects.toThrow();
    await expect(
      StoreSessionClient.prototype.command.call({} as StoreSessionClient, {
        version: 1,
        request_id: id,
        action: "status",
      }),
    ).rejects.toThrow();
    await expect(
      Reflect.apply(StoreRuntimeContext.open, StoreRuntimeContext, [{}]),
    ).rejects.toThrow("STORE_SESSION_CONTEXT_DENIED");
  });
});
