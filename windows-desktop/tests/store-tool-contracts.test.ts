import { describe, expect, it } from "vitest";
import {
  STORE_FIXED_TOOL_KINDS,
  assertStoreFixedTool,
  parseStoreToolStarted,
  parseStoreToolToken,
  parseStoreToolChunk,
  parseStoreToolCleanup,
} from "../src/shared/store-tool-contracts.js";
import {
  StoreFixedToolChild,
  StoreNodeIssuer,
} from "../src/main/session/store-node-issuer.js";
import {
  parseStoreSessionPresence,
  StoreSessionClient,
} from "../src/main/session/store-session-client.js";
const request = "12345678-1234-4234-8234-123456789012",
  token = "a".repeat(64);
const owner = {
  sid: "S-1-12-1-100-200-300-400",
  sessionId: 1,
  pid: 10,
  creationTime: "132000000000000001",
};
const child = {
  sid: owner.sid,
  session_id: 1,
  pid: 11,
  creation_time: "132000000000000002",
};
const started = { token, started: true, process: child };
const chunk = {
  bytes_base64: "e30=",
  stderr_base64: "",
  eof: false,
  exit_code: null,
};
describe("fixed Store CPU tool receiving data", () => {
  it("admits only finite kinds and UUID request data, without an execution constructor", async () => {
    for (const kind of STORE_FIXED_TOOL_KINDS)
      expect(() => assertStoreFixedTool(kind, request)).not.toThrow();
    for (const kind of [
      "ffmpeg",
      "shell",
      "cloud-probe-input ",
      "DENO-PROVIDER",
      { kind: "deno-version" },
    ])
      expect(() => assertStoreFixedTool(kind, request)).toThrow(
        "STORE_TOOL_INVALID",
      );
    for (const id of [
      "../request",
      "C:\\private",
      request.replace("12345678", "abcdefab").toUpperCase(),
      null,
      1,
    ])
      expect(() => assertStoreFixedTool("cloud-transcode", id)).toThrow(
        "STORE_TOOL_INVALID",
      );
    expect(
      () =>
        new StoreFixedToolChild(
          Symbol(),
          {} as never,
          "deno-version",
          request,
          token,
        ),
    ).toThrow();
    await expect(
      StoreNodeIssuer.prototype.createFixedTool.call(
        Object.create(StoreNodeIssuer.prototype),
        "deno-version",
        request,
        token,
        {} as never,
      ),
    ).rejects.toThrow();
  });
  it("binds the actual receiving child to its own logon and retained original birth", () => {
    const parsed = parseStoreToolStarted(started, owner);
    expect(parsed.token).toBe(token);
    expect(parsed.process.pid).toBe(11);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseStoreToolToken({ token, started: false, process: null })).toBe(
      token,
    );
    expect(parseStoreToolStarted(started, owner, parsed)).toEqual(parsed);
    for (const changed of [
      { ...child, pid: owner.pid },
      { ...child, sid: "S-1-5-21-100-200-300-400" },
      { ...child, session_id: 2 },
      { ...child, pid: 0 },
      { ...child, creation_time: "01" },
    ])
      expect(() =>
        parseStoreToolStarted({ ...started, process: changed }, owner),
      ).toThrow("STORE_TOOL_INVALID");
    expect(() =>
      parseStoreToolStarted(
        {
          ...started,
          process: { ...child, creation_time: "132000000000000003" },
        },
        owner,
        parsed,
      ),
    ).toThrow("STORE_TOOL_INVALID");
    for (const field of Object.keys(started)) {
      const bad: Record<string, unknown> = { ...started };
      delete bad[field];
      expect(() => parseStoreToolToken(bad)).toThrow("STORE_TOOL_INVALID");
    }
    const getter = { ...started };
    Object.defineProperty(getter, "token", {
      get: () => token,
      enumerable: true,
    });
    expect(() => parseStoreToolStarted(getter, owner)).toThrow(
      "STORE_TOOL_INVALID",
    );
  });
  it("requires bounded canonical chunks and actual terminal exit data", () => {
    expect(parseStoreToolChunk(chunk).bytes.toString()).toBe("{}");
    expect(
      parseStoreToolChunk({ ...chunk, eof: true, exit_code: 0 }).exitCode,
    ).toBe(0);
    for (const changed of [
      { eof: true },
      { exit_code: 0 },
      { eof: "true" },
      { exit_code: -1, eof: true },
      { exit_code: 0x100000000, eof: true },
      { bytes_base64: "e31=" },
      { bytes_base64: "e30=\n" },
      { stderr_base64: "====" },
      { path: "C:\\tool.exe" },
    ])
      expect(() => parseStoreToolChunk({ ...chunk, ...changed })).toThrow(
        "STORE_TOOL_INVALID",
      );
    expect(
      parseStoreToolChunk({
        ...chunk,
        bytes_base64: Buffer.alloc(24576).toString("base64"),
      }).bytes.length,
    ).toBe(24576);
    expect(() =>
      parseStoreToolChunk({
        ...chunk,
        bytes_base64: Buffer.alloc(24577).toString("base64"),
      }),
    ).toThrow("STORE_TOOL_INVALID");
    expect(() =>
      parseStoreToolChunk({
        ...chunk,
        stderr_base64: Buffer.alloc(16385).toString("base64"),
      }),
    ).toThrow("STORE_TOOL_INVALID");
  });
  it("accepts only the original positive child Job cleanup receiving shape", () => {
    expect(() =>
      parseStoreToolCleanup({ job: "confirmed", stopped: true }),
    ).not.toThrow();
    for (const row of [
      { job: "pending", stopped: true },
      { job: "confirmed", stopped: false },
      { job: "confirmed", stopped: true, gpu: "confirmed" },
      { stopped: true },
      null,
    ])
      expect(() => parseStoreToolCleanup(row)).toThrow("STORE_TOOL_INVALID");
  });
});
describe("passive Store Session publication receiving", () => {
  it("accepts exactly one own boolean observation without creating a client", async () => {
    expect(parseStoreSessionPresence({ present: true })).toBe(true);
    expect(parseStoreSessionPresence({ present: false })).toBe(false);
    for (const row of [
      null,
      {},
      [],
      { present: 1 },
      { present: "false" },
      { present: false, ready: true },
      Object.create({ present: false }),
    ])
      expect(() => parseStoreSessionPresence(row)).toThrow(
        "STORE_SESSION_CLIENT_DENIED",
      );
    expect(() =>
      parseStoreSessionPresence(
        Object.defineProperty({}, "present", {
          get: () => false,
          enumerable: true,
        }),
      ),
    ).toThrow("STORE_SESSION_CLIENT_DENIED");
    await expect(
      StoreSessionClient.tryOpen({} as never, {} as never),
    ).rejects.toThrow("STORE_SESSION_CLIENT_DENIED");
  });
});
