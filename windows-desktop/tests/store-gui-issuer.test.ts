import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Server, Socket } from "node:net";

// Test-only pathname bridge. The issuer still uses actual Node servers and
// sockets; this gives portable protocol/lifetime evidence, not Win32 peer proof.
const fixture = vi.hoisted(() => ({
  directory: "",
  routes: new Map<string, string>(),
  servers: [] as Server[],
  sockets: new Set<Socket>(),
}));
vi.mock("node:process", async (original) => ({
  ...(await original<typeof import("node:process")>()),
  platform: "win32",
  arch: "x64",
}));
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (
      options: import("node:net").ServerOpts,
      listener: (socket: Socket) => void,
    ) => {
      const server = actual.createServer(options, listener);
      const listen = server.listen.bind(server);
      server.listen = ((path: string, callback: () => void) => {
        if (
          !/^\\\\\.\\pipe\\MusicMuteStoreGuiBootstrap-[1-9]\d*-[a-f0-9]{64}$/u.test(
            path,
          )
        )
          throw new Error("FIXTURE_FIXED_PIPE_REQUIRED");
        const route = join(fixture.directory, `p-${fixture.routes.size}.sock`);
        fixture.routes.set(path, route);
        return listen(route, callback);
      }) as typeof server.listen;
      fixture.servers.push(server);
      return server;
    },
  };
});
import { createConnection } from "node:net";
import {
  parseStoreGuiIssuerFrame,
  STORE_GUI_ISSUER_MAX_FRAME,
  STORE_GUI_ISSUER_TIMEOUT_MS,
  StoreGuiBootstrapIssuer,
} from "../src/main/browser/store-gui-issuer.js";

const birth = "1337133713371337";
const childPid = process.pid + 1;
const issuers: StoreGuiBootstrapIssuer[] = [];
async function open() {
  const issuer = await StoreGuiBootstrapIssuer.open();
  issuers.push(issuer);
  const nonce = issuer.bindSpawnedProcess(childPid);
  const path = `\\\\.\\pipe\\MusicMuteStoreGuiBootstrap-${process.pid}-${nonce}`;
  const route = fixture.routes.get(path);
  if (!route) throw new Error("FIXTURE_ROUTE_MISSING");
  return { issuer, nonce, route };
}
async function connect(route: string) {
  const socket = createConnection(route);
  fixture.sockets.add(socket);
  socket.on("error", () => undefined);
  socket.on("close", () => fixture.sockets.delete(socket));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}
function frame(nonce: string, extra: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      nonce,
      pid: childPid,
      creation_time: birth,
      ...extra,
    }) + "\n",
  );
}
async function reply(socket: Socket, request: Uint8Array, split = false) {
  const response = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > STORE_GUI_ISSUER_MAX_FRAME)
        reject(new Error("FIXTURE_RESPONSE_TOO_LARGE"));
      else chunks.push(chunk);
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks)));
    socket.once("close", (hadError) => {
      if (hadError) reject(new Error("FIXTURE_PEER_CLOSED"));
    });
  });
  if (split) {
    socket.write(request.subarray(0, 17));
    socket.write(request.subarray(17));
  } else socket.write(request);
  return response;
}
beforeEach(async () => {
  fixture.directory = await mkdtemp("/tmp/mm-gui-issuer-");
  fixture.routes.clear();
  fixture.servers.length = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const socket of fixture.sockets) socket.destroy();
  await Promise.all(issuers.splice(0).map((issuer) => issuer.close()));
  expect(fixture.servers.every((server) => !server.listening)).toBe(true);
  await rm(fixture.directory, { recursive: true });
});

describe("GUI issuer receiving grammar (no authority from parsed JSON)", () => {
  const nonce = "a".repeat(64);
  it("receives only the exact bounded single UTF8 JSON frame", () => {
    const value = parseStoreGuiIssuerFrame(frame(nonce), nonce, childPid);
    expect(value.pid).toBe(childPid);
    expect(value.creation_time).toBe(birth);
    expect(Object.isFrozen(value)).toBe(true);
    expect(value).not.toHaveProperty("confirmBootHelper");
  });
  it.each([
    { version: 2 },
    { nonce: "b".repeat(64) },
    { pid: childPid + 1 },
    { pid: "123" },
    { pid: 0 },
    { creation_time: "0" },
    { creation_time: "001" },
    { creation_time: "18446744073709551616" },
    { creation_time: 1337133713371337 },
    { adapter: true },
  ])("rejects foreign/invalid fields %j", (change) => {
    expect(() =>
      parseStoreGuiIssuerFrame(frame(nonce, change), nonce, childPid),
    ).toThrow("STORE_GUI_ISSUER_DENIED");
  });
  it.each([
    Buffer.from(
      `{"version":1,"nonce":"${nonce}","pid":${childPid},"pid":${childPid},"creation_time":"${birth}"}\n`,
    ),
    Buffer.from(
      `{"version":1,"nonce":"${nonce}","pid":${childPid},"\\u0070id":${childPid},"creation_time":"${birth}"}\n`,
    ),
    Buffer.concat([frame(nonce), frame(nonce)]),
    Buffer.concat([frame(nonce), Buffer.from(" ")]),
    frame(nonce).subarray(0, -1),
    Buffer.from("[]\n"),
    Buffer.from([0xff, 10]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), frame(nonce)]),
    Buffer.from(frame(nonce).toString().replace("\n", "\r\n")),
    Buffer.alloc(STORE_GUI_ISSUER_MAX_FRAME + 1, 32),
  ])("rejects duplicate/replayed/unframed/invalid UTF8 bytes", (bytes) => {
    expect(() => parseStoreGuiIssuerFrame(bytes, nonce, childPid)).toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
  });
});

describe("actual portable GUI issuer socket lifetime (not Windows OS proof)", () => {
  it("rejects caller options instead of exposing a path or success adapter", async () => {
    await expect(
      Reflect.apply(StoreGuiBootstrapIssuer.open, StoreGuiBootstrapIssuer, [
        { path: "caller-selected", timeoutMs: 1, accepted: true },
      ]),
    ).rejects.toThrow("STORE_GUI_ISSUER_UNSUPPORTED_HOST");
    expect(fixture.servers).toHaveLength(0);
  });
  it("rejects a connection before the actual spawned child is bound", async () => {
    const issuer = await StoreGuiBootstrapIssuer.open();
    issuers.push(issuer);
    const route = [...fixture.routes.values()][0]!;
    const socket = await connect(route);
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(() => issuer.bindSpawnedProcess(childPid)).toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
  });
  it("starts before binding, acknowledges one fragmented claim through EOF and consumes matching boot once", async () => {
    const { issuer, nonce, route } = await open();
    expect(nonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(issuer)).toEqual([]);
    const socket = await connect(route);
    const ack = await reply(socket, frame(nonce), true);
    expect(JSON.parse(ack.toString())).toEqual({
      version: 1,
      accepted: true,
      nonce,
      pid: childPid,
      creation_time: birth,
    });
    await issuer.confirmBootHelper(childPid, birth);
    await issuer.close();
    await issuer.close();
    await expect(issuer.confirmBootHelper(childPid, birth)).rejects.toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
    await expect(connect(route)).rejects.toThrow();
  });
  it("rejects a forged boot birth after a valid live claim", async () => {
    const { issuer, nonce, route } = await open();
    await reply(await connect(route), frame(nonce));
    await expect(
      issuer.confirmBootHelper(childPid, "1337133713371338"),
    ).rejects.toThrow("STORE_GUI_ISSUER_DENIED");
  });
  it("rejects nonce/PID mismatch and closes the endpoint", async () => {
    const { issuer, nonce, route } = await open();
    const pending = issuer.confirmBootHelper(childPid, birth);
    const rejection = expect(pending).rejects.toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
    const socket = await connect(route);
    socket.write(frame(nonce, { pid: childPid + 1 }));
    await rejection;
    expect(fixture.servers[0]!.listening).toBe(false);
  });
  it("rejects a second complete frame before issuing ACK", async () => {
    const { issuer, nonce, route } = await open();
    const pending = issuer.confirmBootHelper(childPid, birth);
    const rejection = expect(pending).rejects.toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
    const socket = await connect(route);
    socket.write(Buffer.concat([frame(nonce), frame(nonce)]));
    await rejection;
  });
  it("rejects a second connection/replay after ACK but before boot confirmation", async () => {
    const { issuer, nonce, route } = await open();
    await reply(await connect(route), frame(nonce));
    const replay = await connect(route);
    replay.write(frame(nonce));
    await new Promise<void>((resolve) => replay.once("close", () => resolve()));
    await expect(issuer.confirmBootHelper(childPid, birth)).rejects.toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
  });
  it("fails closed on EOF before a complete frame", async () => {
    const { issuer, route } = await open();
    const pending = issuer.confirmBootHelper(childPid, birth);
    const rejection = expect(pending).rejects.toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
    const socket = await connect(route);
    socket.end("{");
    await rejection;
  });
  it("rejects oversized live input without waiting for LF", async () => {
    const { issuer, route } = await open();
    const pending = issuer.confirmBootHelper(childPid, birth);
    const rejection = expect(pending).rejects.toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
    (await connect(route)).write(
      Buffer.alloc(STORE_GUI_ISSUER_MAX_FRAME + 1, 32),
    );
    await rejection;
  });
  it("bounds the entire listen/claim/boot lifetime by the fixed deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { issuer } = await open();
    const pending = issuer.confirmBootHelper(childPid, birth);
    const rejection = expect(pending).rejects.toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
    await vi.advanceTimersByTimeAsync(STORE_GUI_ISSUER_TIMEOUT_MS + 1);
    await rejection;
  });
  it("cannot rebind the spawned child or construct an injected authority", async () => {
    const { issuer } = await open();
    expect(() => issuer.bindSpawnedProcess(childPid + 1)).toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
    expect(() =>
      Reflect.construct(StoreGuiBootstrapIssuer, [Symbol("fake")]),
    ).toThrow("STORE_GUI_ISSUER_DENIED");
    await issuer.close();
  });
  it("explicit close cancels pending confirmation and retires all sockets", async () => {
    const { issuer, route } = await open();
    await connect(route);
    const pending = issuer.confirmBootHelper(childPid, birth);
    const rejection = expect(pending).rejects.toThrow(
      "STORE_GUI_ISSUER_DENIED",
    );
    await issuer.close();
    await rejection;
    expect(fixture.servers[0]!.listening).toBe(false);
  });
});
