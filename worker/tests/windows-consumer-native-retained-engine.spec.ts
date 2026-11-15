import { describe, expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  type ConsumerNativeOperation,
  type ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native.js";

const sid = "S-1-5-21-1-2-3-1001",
  guardian = { sid, sessionId: 1, pid: 42, creationTime: "133400000000000001" },
  engine = { ...guardian, pid: 43, creationTime: "133400000000000002" },
  token = "a".repeat(64),
  job = "11111111-1111-4111-8111-111111111111";
function fixture(response: (operation: ConsumerNativeOperation) => unknown) {
  const request = vi.fn(async (operation: ConsumerNativeOperation) =>
      operation === "identity"
        ? {
            sid,
            session_id: 1,
            pid: 7,
            creation_time: guardian.creationTime,
            logon_sid: "S-1-5-5-1-2",
            native_arch: "x64",
            process_arch: "x64",
            os_major: 10,
            os_build: 19045,
            local_app_data: "C:\\Users\\Fixture\\AppData\\Local",
          }
        : response(operation),
    ),
    transport = {
      request,
      close: vi.fn(async () => {}),
    } satisfies ConsumerNativeTransport;
  return { native: new WindowsConsumerNative(transport), request };
}
describe("retained personal engine native boundary (injected adapter)", () => {
  it("carries both exact process births and the closed attempt-scoped operations", async () => {
    const f = fixture((operation) => {
      switch (operation) {
        case "retained_engine_register":
          return { token };
        case "retained_engine_begin":
          return { busy: true };
        case "retained_engine_complete":
        case "retained_engine_idle":
          return { idle: true };
        case "retained_engine_forget":
          return { forgotten: true };
        default:
          throw new Error("unexpected fixture operation");
      }
    });
    expect(await f.native.registerRetainedEngine(guardian, engine)).toEqual({
      token,
    });
    expect(f.request).toHaveBeenCalledWith("retained_engine_register", {
      guardian: {
        sid,
        session_id: 1,
        pid: guardian.pid,
        creation_time: guardian.creationTime,
      },
      engine: {
        sid,
        session_id: 1,
        pid: engine.pid,
        creation_time: engine.creationTime,
      },
    });
    await f.native.beginRetainedEngine(token, job);
    await f.native.completeRetainedEngine(token, job);
    expect(await f.native.retainedEngineIdle(token)).toBe(true);
    await f.native.forgetRetainedEngine(token);
    expect(f.request).toHaveBeenCalledWith("retained_engine_begin", {
      token,
      job_id: job,
    });
    expect(f.request).toHaveBeenCalledWith("retained_engine_complete", {
      token,
      job_id: job,
    });
    expect(f.request).toHaveBeenCalledWith("retained_engine_idle", { token });
    expect(f.request).toHaveBeenCalledWith("retained_engine_forget", { token });
  });
  it("preserves busy and denied census responses without substituting original inference idleness", async () => {
    const f = fixture(() => ({ idle: false }));
    expect(await f.native.retainedEngineIdle(token)).toBe(false);
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual([
      "retained_engine_idle",
    ]);
    await expect(f.native.completeRetainedEngine(token, job)).rejects.toThrow(
      "PROTOCOL_MISMATCH",
    );
  });
  it.each([
    { ...engine, sid: "S-1-5-21-4-5-6-1002" },
    { ...engine, sessionId: 2 },
    { ...engine, pid: guardian.pid },
  ])(
    "rejects foreign SID/session or duplicate process before registration dispatch",
    async (peer) => {
      const f = fixture(() => ({ token }));
      await expect(
        f.native.registerRetainedEngine(guardian, peer),
      ).rejects.toThrow("PEER_DENIED");
      expect(
        f.request.mock.calls.filter(
          ([operation]) => operation === "retained_engine_register",
        ),
      ).toHaveLength(0);
    },
  );
  it.each([{ token: "A".repeat(64) }, { token, extra: true }, { token: 1 }])(
    "rejects malformed or widened registration acknowledgement",
    async (reply) => {
      const f = fixture(() => reply);
      await expect(
        f.native.registerRetainedEngine(guardian, engine),
      ).rejects.toThrow("PROTOCOL_MISMATCH");
    },
  );
  it("rejects malformed job ID and token locally for every attempt/retirement operation", async () => {
    const f = fixture(() => ({}));
    await expect(
      f.native.beginRetainedEngine(token, "arbitrary"),
    ).rejects.toThrow("BAD_REQUEST");
    await expect(
      f.native.completeRetainedEngine(token, "arbitrary"),
    ).rejects.toThrow("BAD_REQUEST");
    await expect(f.native.retainedEngineIdle("bad")).rejects.toThrow(
      "BAD_REQUEST",
    );
    await expect(f.native.forgetRetainedEngine("bad")).rejects.toThrow(
      "BAD_REQUEST",
    );
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    ["begin", { busy: false }],
    ["begin", { busy: true, idle: true }],
    ["complete", { idle: false }],
    ["complete", { idle: true, busy: false }],
    ["idle", { idle: true, exited: true }],
    ["forget", { forgotten: false }],
    ["forget", { forgotten: true, pid_gone: true }],
  ] as const)(
    "rejects uncertain or widened %s acknowledgement",
    async (operation, reply) => {
      const f = fixture(() => reply);
      const run =
        operation === "begin"
          ? f.native.beginRetainedEngine(token, job)
          : operation === "complete"
            ? f.native.completeRetainedEngine(token, job)
            : operation === "idle"
              ? f.native.retainedEngineIdle(token)
              : f.native.forgetRetainedEngine(token);
      await expect(run).rejects.toThrow("PROTOCOL_MISMATCH");
    },
  );
});
