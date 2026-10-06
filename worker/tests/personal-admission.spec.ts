import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MacPersonalAdmission,
  personalEngineIdentity,
} from "../src/runtime/personal-admission.js";
import {
  persistPersonalReservation,
  withPersonalAdmissionLock,
} from "../src/runtime/personal-reservation.js";

const roots: string[] = [];
const servers: MacPersonalAdmission[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "mw-pa-"));
  roots.push(root);
  await chmod(root, 0o700);
  const processes = new Map<number, string>([
    [process.pid, "client-process-start"],
  ]);
  const identify = vi.fn(async (pid: number) => processes.get(pid));
  const server = new MacPersonalAdmission(root, identify);
  servers.push(server);
  const wake = vi.fn();
  await server.start(wake);
  return { root, server, processes, identify, wake };
}

async function client(path: string) {
  const socket = createConnection(path);
  sockets.push(socket);
  socket.on("error", () => {});
  await new Promise<void>((done, fail) => {
    socket.once("connect", done);
    socket.once("error", fail);
  });
  const messages: Array<Record<string, unknown>> = [];
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  const request_id = randomUUID();
  const send = (type: string, fields = {}) =>
    socket.write(
      JSON.stringify({ protocol_version: 1, request_id, type, ...fields }) +
        "\n",
    );
  const wait = async (type: string) => {
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === type)).toBe(true),
    );
  };
  send("PERSONAL", { client_pid: process.pid });
  await wait("WAITING");
  return { socket, messages, send, wait, request_id };
}

describe("private personal GPU admission", () => {
  it.skipIf(process.platform !== "darwin")(
    "reloads a reservation published between endpoint binding and the locked startup snapshot",
    async () => {
      const f = await fixture();
      await f.server.stop();
      const replacement = new MacPersonalAdmission(f.root);
      servers.push(replacement);
      const engine = spawn(process.execPath, [
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      await once(engine, "spawn");
      let starting!: Promise<void>;
      try {
        await withPersonalAdmissionLock(f.root, async () => {
          starting = replacement.start(f.wake);
          await vi.waitFor(async () =>
            expect((await lstat(replacement.socketPath)).isSocket()).toBe(true),
          );
          await persistPersonalReservation(f.root, {
            request_id: randomUUID(),
            phase: "active",
            client_pid: process.pid,
            client_identity: (await personalEngineIdentity(process.pid))!,
            engine_pid: engine.pid!,
            process_identity: (await personalEngineIdentity(engine.pid!))!,
          });
        });
        await starting;
        expect(replacement.pending()).toBe(true);
        engine.kill("SIGKILL");
        await once(engine, "exit");
        await vi.waitFor(() => expect(replacement.pending()).toBe(false));
      } finally {
        engine.kill("SIGKILL");
      }
    },
  );
  it.each(["app-maintenance.json", "app-preparation.json"])(
    "defers a grant while %s fences qualification",
    async (name) => {
      const f = await fixture();
      const owner = await client(f.server.socketPath);
      const maintenance = join(f.root, name);
      await writeFile(maintenance, "{}\n", { mode: 0o600 });
      await f.server.grant();
      expect(owner.messages.some((message) => message.type === "GRANTED")).toBe(
        false,
      );
      expect(f.server.pending()).toBe(true);
      await unlink(maintenance);
      await f.server.grant();
      await owner.wait("GRANTED");
      owner.send("RELEASE");
      await owner.wait("RELEASED");
    },
  );
  it("queues requests until fleet exit, acknowledges registration and retains ownership until engine exit", async () => {
    const f = await fixture();
    const first = await client(f.server.socketPath);
    const second = await client(f.server.socketPath);
    expect((await lstat(f.server.socketPath)).mode & 0o777).toBe(0o600);
    expect(f.server.pending()).toBe(true);
    expect(first.messages.some((message) => message.type === "GRANTED")).toBe(
      false,
    );
    await Promise.all([f.server.grant(), f.server.grant()]);
    await first.wait("GRANTED");
    expect(second.messages.some((message) => message.type === "GRANTED")).toBe(
      false,
    );
    f.processes.set(4321, "owned-process-start");
    first.send("ENGINE", { engine_pid: 4321 });
    await first.wait("REGISTERED");
    const journal = JSON.parse(
      await readFile(join(f.root, "personal-admission.json"), "utf8"),
    );
    expect(journal).toEqual({
      request_id: first.request_id,
      phase: "active",
      client_pid: process.pid,
      client_identity: "client-process-start",
      engine_pid: 4321,
      process_identity: "owned-process-start",
    });
    expect(
      (await lstat(join(f.root, "personal-admission.json"))).mode & 0o777,
    ).toBe(0o600);
    first.send("RELEASE");
    await new Promise((done) => setTimeout(done, 30));
    expect(first.messages.some((message) => message.type === "RELEASED")).toBe(
      false,
    );
    f.processes.delete(4321);
    await first.wait("RELEASED");
    await f.server.grant();
    await second.wait("GRANTED");
    second.send("RELEASE");
    await second.wait("RELEASED");
    expect(f.server.pending()).toBe(false);
  });

  it("keeps a disconnected registered engine fenced across supervisor restart", async () => {
    const f = await fixture();
    const owner = await client(f.server.socketPath);
    await f.server.grant();
    await owner.wait("GRANTED");
    f.processes.set(4321, "same-start");
    owner.send("ENGINE", { engine_pid: 4321 });
    await owner.wait("REGISTERED");
    owner.socket.destroy();
    await f.server.stop();
    const replacement = new MacPersonalAdmission(f.root, f.identify);
    servers.push(replacement);
    await replacement.start(f.wake);
    expect(replacement.pending()).toBe(true);
    f.identify.mockRejectedValueOnce(new Error("EPERM"));
    await new Promise((done) => setTimeout(done, 300));
    expect(replacement.pending()).toBe(true);
    f.processes.delete(4321);
    await vi.waitFor(() => expect(replacement.pending()).toBe(false));
  });

  it("recovers interrupted pre-registration grants only after the requesting process exits", async () => {
    const f = await fixture();
    const waiting = await client(f.server.socketPath);
    waiting.socket.destroy();
    await vi.waitFor(() => expect(f.server.pending()).toBe(false));
    const owner = await client(f.server.socketPath);
    await f.server.grant();
    await owner.wait("GRANTED");
    owner.socket.destroy();
    await new Promise((done) => setTimeout(done, 300));
    expect(f.server.pending()).toBe(true);
    f.processes.delete(process.pid);
    await vi.waitFor(() => expect(f.server.pending()).toBe(false));
  });

  it("keeps legacy ownerless reservations fail-closed across restart", async () => {
    const f = await fixture();
    await f.server.stop();
    await writeFile(
      join(f.root, "personal-admission.json"),
      JSON.stringify({ request_id: randomUUID() }),
      { mode: 0o600 },
    );
    const replacement = new MacPersonalAdmission(f.root, f.identify);
    servers.push(replacement);
    await replacement.start(f.wake);
    expect(replacement.pending()).toBe(true);
  });

  it("observes actual disposable engine exit before releasing the GPU", async () => {
    const f = await fixture();
    await f.server.stop();
    const replacement = new MacPersonalAdmission(f.root);
    servers.push(replacement);
    await replacement.start(f.wake);
    const engine = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    await once(engine, "spawn");
    try {
      const owner = await client(replacement.socketPath);
      await replacement.grant();
      await owner.wait("GRANTED");
      owner.send("ENGINE", { engine_pid: engine.pid! });
      await owner.wait("REGISTERED");
      owner.send("RELEASE");
      await new Promise((done) => setTimeout(done, 300));
      expect(replacement.pending()).toBe(true);
      engine.kill("SIGKILL");
      await once(engine, "exit");
      await owner.wait("RELEASED");
      expect(replacement.pending()).toBe(false);
    } finally {
      engine.kill("SIGKILL");
    }
  });

  it("refuses unsafe roots and hostile journal links", async () => {
    const f = await fixture();
    await f.server.stop();
    await symlink("outside", join(f.root, "personal-admission.json"));
    const unsafe = new MacPersonalAdmission(f.root, f.identify);
    await expect(unsafe.start(f.wake)).rejects.toThrow("UNSAFE");
    await chmod(f.root, 0o755);
    await expect(
      new MacPersonalAdmission(f.root).start(f.wake),
    ).rejects.toThrow("UNSAFE");
  });

  it("never replaces a live coordinator", async () => {
    const f = await fixture();
    const contender = new MacPersonalAdmission(f.root, f.identify);
    await expect(contender.start(f.wake)).rejects.toThrow("ALREADY_STARTED");
    expect((await lstat(f.server.socketPath)).isSocket()).toBe(true);
  });

  it("identifies the actual logged-in process and positively observes a missing PID", async () => {
    expect(await personalEngineIdentity(process.pid)).toBeTypeOf("string");
    expect(await personalEngineIdentity(2_147_483_647)).toBeUndefined();
  });
});
