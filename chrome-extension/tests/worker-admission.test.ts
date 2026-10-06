import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { LocalConfig } from "../src/companion/config.js";
import { runLocalEngine } from "../src/companion/local-engine.js";
import {
  authorizePersonalMaintenanceUnderLock,
  reclaimIdlePersonalReservation,
  withPersonalAdmissionLock,
} from "../../worker/src/runtime/personal-reservation.js";
import { afterEach, expect, it, vi } from "vitest";
import { MacPersonalAdmission } from "../../worker/src/runtime/personal-admission.js";
import { acquireWorkerAdmission } from "../src/companion/worker-admission.js";

const roots: string[] = [],
  children: ChildProcess[] = [],
  coordinators: MacPersonalAdmission[] = [],
  servers: Server[] = [],
  sockets: Socket[] = [];
const residentPids = new Set<number>();
afterEach(async () => {
  for (const pid of residentPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already retired */
    }
  }
  residentPids.clear();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/mm-admit-"));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });
  return {
    root,
    state,
    options: {
      workerRoot: root,
      signal: new AbortController().signal,
      timeoutMs: 1000,
      exchangeTimeoutMs: 200,
    },
  };
}
async function engine() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  children.push(child);
  await once(child, "spawn");
  return child;
}
async function warmFixture() {
  const f = await fixture(),
    root = join(f.root, "personal");
  await mkdir(root, { mode: 0o700 });
  const runner = join(root, "runner.cjs");
  await writeFile(join(root, "local_engine_service.py"), "fixture-service");
  await writeFile(
    runner,
    `
const net = require('node:net'), fs = require('node:fs');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
let calls = 0;
const server = net.createServer(socket => {
 socket.on('error', () => {});
 socket.write(JSON.stringify({ type: 'ready', engine_id: arg('--engine-id'), pid: process.pid }) + '\\n');
 socket.once('data', bytes => {
  const frame = JSON.parse(bytes);
  if (frame.operation === 'retire') { socket.end(); server.close(() => process.exit(0)); return; }
  socket.write(JSON.stringify({ type: 'result', result: { calls: ++calls, pid: process.pid } }) + '\\n');
 });
});
server.on('error', () => process.exit(0));
server.listen(arg('--socket'), () => fs.chmodSync(arg('--socket'), 0o600));
`,
  );
  const config = {
    root,
    runner_path: runner,
    python_path: process.execPath,
    node_path: process.execPath,
    engine_root: root,
    models_root: root,
    ffmpeg_path: process.execPath,
    ffprobe_path: process.execPath,
  } as LocalConfig;
  const run = async () => {
    const lease = await acquireWorkerAdmission(f.options);
    const result = await runLocalEngine(
      config,
      join(root, "source"),
      root,
      "A".repeat(43) + "=",
      {
        signal: f.options.signal,
        onEvent() {},
        onSpawn: (pid) => {
          residentPids.add(pid);
        },
        beforeProcess: (pid, endpoint) => lease.registerEngine(pid, endpoint),
      },
    );
    await lease.markIdle();
    await lease.release();
    return result;
  };
  const name = createHash("sha256").update(root).digest("hex").slice(0, 24);
  roots.push(
    join(await realpath("/tmp"), `mm-engine-${process.getuid?.()}-${name}`),
  );
  return { ...f, config, run };
}
async function coordinator(state: string) {
  const value = new MacPersonalAdmission(state);
  coordinators.push(value);
  await value.start(() => {});
  return value;
}
async function fakeServer(
  state: string,
  receive: (socket: Socket, frame: Record<string, unknown>) => void,
) {
  const path = join(state, "personal-admission.sock");
  const value = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let buffered = "";
    socket.on("data", (bytes) => {
      buffered += bytes.toString();
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffered.slice(0, end)) as Record<
          string,
          unknown
        >;
        buffered = buffered.slice(end + 1);
        receive(socket, frame);
      }
    });
  });
  servers.push(value);
  await new Promise<void>((done) => value.listen(path, done));
  await chmod(path, 0o600);
}
function reply(socket: Socket, frame: Record<string, unknown>, type: string) {
  socket.write(
    JSON.stringify({
      protocol_version: 1,
      request_id: frame.request_id,
      type,
    }) + "\n",
  );
}

it("reserves a stopped or never-enrolled worker before engine loading and clears only after actual exit", async () => {
  const f = await fixture();
  const lease = await acquireWorkerAdmission(f.options);
  const path = join(f.state, "personal-admission.json");
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    client_pid: process.pid,
  });
  const child = await engine();
  await lease.registerEngine(child.pid!);
  await expect(lease.release()).rejects.toThrow("ENGINE_EXIT_UNCONFIRMED");
  child.kill("SIGKILL");
  await once(child, "exit");
  await lease.release();
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains and safely adopts a worker-free resident engine between personal requests", async () => {
  const f = await warmFixture(),
    first = await f.run(),
    second = await f.run();
  expect(second).toEqual({ calls: 2, pid: first.pid });
  expect(
    JSON.parse(
      await readFile(join(f.state, "personal-admission.json"), "utf8"),
    ),
  ).toMatchObject({ phase: "idle", engine_pid: first.pid });
  expect(() => process.kill(Number(first.pid), 0)).not.toThrow();
});
it("a starting coordinator retires idle ownership and confirms actual exit before becoming available", async () => {
  const f = await warmFixture(),
    first = await f.run();
  const worker = await coordinator(f.state);
  expect(() => process.kill(Number(first.pid), 0)).toThrow();
  expect(worker.pending()).toBe(false);
  await expect(
    lstat(join(f.state, "personal-admission.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("maintenance retirement wins atomically over idle adoption and never exposes a live engine as unreserved", async () => {
  const f = await warmFixture(),
    first = await f.run();
  await withPersonalAdmissionLock(f.state, () =>
    authorizePersonalMaintenanceUnderLock(f.state),
  );
  expect(
    JSON.parse(await readFile(join(f.state, "personal-admission.json"), "utf8"))
      .phase,
  ).toBe("retiring");
  await expect(
    acquireWorkerAdmission({ ...f.options, timeoutMs: 100 }),
  ).rejects.toThrow("WORKER_WAIT_TIMEOUT");
  expect(() => process.kill(Number(first.pid), 0)).not.toThrow();
  await reclaimIdlePersonalReservation(f.state);
  expect(() => process.kill(Number(first.pid), 0)).toThrow();
  const next = await acquireWorkerAdmission(f.options);
  await next.release();
});
it("personal idle adoption wins atomically over maintenance and keeps its active generation fenced", async () => {
  const f = await warmFixture(),
    first = await f.run();
  const adopted = await acquireWorkerAdmission(f.options);
  await expect(
    withPersonalAdmissionLock(f.state, () =>
      authorizePersonalMaintenanceUnderLock(f.state),
    ),
  ).rejects.toThrow("WORKER_PERSONAL_BUSY");
  expect(() => process.kill(Number(first.pid), 0)).not.toThrow();
  // Cancellation before the generation acknowledges ENGINE can explicitly
  // verify and re-park its inherited idle engine; it cannot drop the journal.
  await adopted.release();
  expect(
    JSON.parse(await readFile(join(f.state, "personal-admission.json"), "utf8"))
      .phase,
  ).toBe("idle");
});
it("uses the actual worker protocol and retains admission until the registered disposable process exits", async () => {
  const f = await fixture(),
    worker = await coordinator(f.state);
  const waiting = vi.fn();
  const request = acquireWorkerAdmission({ ...f.options, onWaiting: waiting });
  await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
  await worker.grant();
  const lease = await request;
  const child = await engine();
  await lease.registerEngine(child.pid!);
  expect(worker.pending()).toBe(true);
  child.kill("SIGKILL");
  await once(child, "exit");
  await lease.release();
  await vi.waitFor(() => expect(worker.pending()).toBe(false));
});
it("coordinates a long isolated home through a UID-bound private hashed Unix socket", async () => {
  const f = await fixture();
  const root = join(f.root, "long-home-" + "x".repeat(120), "MusicMuteWorker"),
    state = join(root, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const worker = await coordinator(state);
  expect(Buffer.byteLength(worker.socketPath)).toBeLessThanOrEqual(100);
  expect(worker.socketPath.startsWith(state)).toBe(false);
  roots.push(dirname(worker.socketPath));
  expect((await lstat(dirname(worker.socketPath))).mode & 0o777).toBe(0o700);
  expect((await lstat(worker.socketPath)).mode & 0o777).toBe(0o600);
  const request = acquireWorkerAdmission({ ...f.options, workerRoot: root });
  await vi.waitFor(() => expect(worker.pending()).toBe(true));
  await worker.grant();
  const lease = await request;
  await lease.release();
  await vi.waitFor(() => expect(worker.pending()).toBe(false));
});
it("a starting supervisor adopts a stopped-worker reservation and observes later engine registration", async () => {
  const f = await fixture(),
    lease = await acquireWorkerAdmission(f.options);
  const worker = await coordinator(f.state);
  expect(worker.pending()).toBe(true);
  const child = await engine();
  await lease.registerEngine(child.pid!);
  child.kill("SIGKILL");
  await once(child, "exit");
  await lease.release();
  await vi.waitFor(() => expect(worker.pending()).toBe(false));
});
it("blocks maintenance, active legacy processes and unknown legacy journals without spawning work", async () => {
  const f = await fixture();
  await writeFile(join(f.state, "app-maintenance.json"), "{}", { mode: 0o600 });
  await expect(acquireWorkerAdmission(f.options)).rejects.toThrow(
    "WORKER_MAINTENANCE_BUSY",
  );
  await rm(join(f.state, "app-maintenance.json"));
  await writeFile(
    join(f.state, "runtime-status.json"),
    JSON.stringify({ processId: process.pid, childState: "stopped" }),
    { mode: 0o600 },
  );
  await expect(acquireWorkerAdmission(f.options)).rejects.toThrow(
    "WORKER_UPDATE_REQUIRED",
  );
  await writeFile(
    join(f.state, "runtime-status.json"),
    JSON.stringify({ processId: 2 ** 31 - 1, childState: "ready" }),
    { mode: 0o600 },
  );
  const lease = await acquireWorkerAdmission(f.options);
  await lease.release();
  await writeFile(
    join(f.state, "personal-admission.json"),
    JSON.stringify({ request_id: "c4df54fe-4d4e-4a7b-a92a-a71926f91a61" }),
    { mode: 0o600 },
  );
  await expect(acquireWorkerAdmission(f.options)).rejects.toThrow(
    "WORKER_RECOVERY_REQUIRED",
  );
});
it("cleans a cancelled waiting request without granting or leaving a journal", async () => {
  const f = await fixture(),
    worker = await coordinator(f.state),
    controller = new AbortController();
  const request = acquireWorkerAdmission({
    ...f.options,
    signal: controller.signal,
    onWaiting: () => controller.abort(),
  });
  await expect(request).rejects.toThrow("CANCELLED");
  await vi.waitFor(() => expect(worker.pending()).toBe(false));
});
it("bounds stalled registration and release acknowledgements and never replays an ENGINE frame", async () => {
  const f = await fixture(),
    frames: Record<string, unknown>[] = [];
  await fakeServer(f.state, (socket, frame) => {
    frames.push(frame);
    if (frame.type === "PERSONAL") reply(socket, frame, "GRANTED");
  });
  const lease = await acquireWorkerAdmission(f.options),
    child = await engine();
  await expect(lease.registerEngine(child.pid!)).rejects.toThrow(
    "WORKER_COORDINATION_UNAVAILABLE",
  );
  await expect(lease.release()).rejects.toThrow(
    "WORKER_COORDINATION_UNAVAILABLE",
  );
  expect(frames.filter((frame) => frame.type === "ENGINE")).toHaveLength(1);
  expect(frames.filter((frame) => frame.type === "RELEASE")).toHaveLength(1);
});
it("rejects unsafe sockets and private-state journal symlinks", async () => {
  const f = await fixture();
  await writeFile(join(f.state, "personal-admission.sock"), "file", {
    mode: 0o600,
  });
  await expect(acquireWorkerAdmission(f.options)).rejects.toThrow(
    "WORKER_COORDINATION_UNSAFE",
  );
  await rm(join(f.state, "personal-admission.sock"));
  await symlink(
    join(f.root, "outside"),
    join(f.state, "personal-admission.json"),
  );
  await expect(acquireWorkerAdmission(f.options)).rejects.toThrow(
    "WORKER_COORDINATION_UNSAFE",
  );
});
it("does not accept a response belonging to another request", async () => {
  const f = await fixture();
  await fakeServer(f.state, (socket) =>
    socket.write(
      '{"protocol_version":1,"request_id":"different","type":"GRANTED"}\n',
    ),
  );
  await expect(acquireWorkerAdmission(f.options)).rejects.toThrow(
    "WORKER_COORDINATION_UNSAFE",
  );
});
