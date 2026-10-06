import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalConfig } from "../src/companion/config.js";
import {
  retireIdleLocalEngine,
  retireLocalEngine,
  runLocalEngine,
} from "../src/companion/local-engine.js";

const roots: string[] = [];
const pids = new Set<number>();
afterEach(async () => {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already retired */
    }
  }
  pids.clear();
  for (const root of roots.splice(0)) {
    const name = createHash("sha256").update(root).digest("hex").slice(0, 24);
    await rm(
      join(await realpath("/tmp"), `mm-engine-${process.getuid?.()}-${name}`),
      { force: true, recursive: true },
    );
    await rm(root, { force: true, recursive: true });
  }
});
async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/mm-client-"));
  roots.push(root);
  await chmod(root, 0o700);
  const runner = join(root, "runner.cjs");
  await writeFile(
    join(root, "local_engine_service.py"),
    "synthetic-service-identity",
  );
  await writeFile(
    runner,
    `
const net = require('node:net'), fs = require('node:fs');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const path = arg('--socket'), id = arg('--engine-id');
let calls = 0;
const server = net.createServer(socket => {
 socket.write(JSON.stringify({ type: 'ready', engine_id: id, pid: process.pid }) + '\\n');
 socket.once('data', bytes => {
  const request = JSON.parse(bytes);
  if (request.operation === 'retire') { socket.end(); server.close(() => process.exit(0)); return; }
  calls++;
  fs.appendFileSync(arg('--service-root') + '/requests', String(calls) + '\\n');
  if (request.input.endsWith('disconnect')) { socket.destroy(); return; }
  if (request.input.endsWith('block')) { socket.write('{"type":"progress","stage":"separation"}\\n'); return; }
  socket.write(JSON.stringify({ type: 'result', result: { calls, pid: process.pid } }) + '\\n');
 });
 socket.on('error', () => {});
});
server.on('error', () => process.exit(0));
server.listen(path, () => fs.chmodSync(path, 0o600));
`,
  );
  const config = {
    root,
    runner_path: runner,
    python_path: process.execPath,
    node_path: process.execPath,
    models_root: root,
    engine_root: root,
    ffmpeg_path: process.execPath,
    ffprobe_path: process.execPath,
  } as LocalConfig;
  const options = {
    signal: new AbortController().signal,
    onEvent() {},
    onSpawn(pid: number) {
      pids.add(pid);
    },
  };
  const run = (input = "source") =>
    runLocalEngine(
      config,
      join(root, input),
      root,
      "A".repeat(43) + "=",
      options,
    );
  return { root, runner, config, options, run };
}
it("reuses one process and sends work exactly once per request", async () => {
  const f = await fixture();
  const first = await f.run(),
    second = await f.run();
  expect(second).toEqual({ calls: 2, pid: first.pid });
  expect(await readFile(join(f.root, "requests"), "utf8")).toBe("1\n2\n");
});
it("retires a historical idle identity without starting or replaying processing", async () => {
  const f = await fixture(),
    result = await f.run();
  await writeFile(
    join(f.root, "local_engine_service.py"),
    "new-service-identity",
  );
  await retireIdleLocalEngine(f.config, {
    findProcesses: async () => [Number(result.pid)],
  });
  expect(() => process.kill(Number(result.pid), 0)).toThrow();
  expect(await readFile(join(f.root, "requests"), "utf8")).toBe("1\n");
});
it("does not assume an unlinked socket proves an owned engine has exited", async () => {
  const f = await fixture(),
    result = await f.run();
  const name = createHash("sha256").update(f.root).digest("hex").slice(0, 24);
  await rm(
    join(
      await realpath("/tmp"),
      `mm-engine-${process.getuid?.()}-${name}`,
      "engine.sock",
    ),
  );
  await expect(
    retireIdleLocalEngine(f.config, {
      timeoutMs: 200,
      findProcesses: async () => [Number(result.pid)],
    }),
  ).rejects.toThrow("ENGINE_EXIT_UNCONFIRMED");
  expect(() => process.kill(Number(result.pid), 0)).not.toThrow();
});
it("does not start an absent engine during qualification preflight", async () => {
  const f = await fixture();
  await retireIdleLocalEngine(f.config, { findProcesses: async () => [] });
  expect(pids.size).toBe(0);
  await expect(readFile(join(f.root, "requests"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("refuses a busy historical engine without killing or replaying its accepted request", async () => {
  const f = await fixture();
  await writeFile(
    f.runner,
    `
const net = require('node:net'), fs = require('node:fs');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
let busy = false;
const server = net.createServer(socket => {
 socket.on('error', () => {});
 if (busy) return;
 socket.write(JSON.stringify({ type: 'ready', engine_id: arg('--engine-id'), pid: process.pid }) + '\\n');
 socket.once('data', () => { busy = true; socket.write('{"type":"progress","stage":"separation"}\\n'); });
});
server.on('error', () => process.exit(0));
server.listen(arg('--socket'), () => fs.chmodSync(arg('--socket'), 0o600));
`,
  );
  const controller = new AbortController();
  let observed!: () => void;
  const progress = new Promise<void>((done) => {
    observed = done;
  });
  const request = runLocalEngine(
    f.config,
    join(f.root, "source"),
    f.root,
    "A".repeat(43) + "=",
    {
      ...f.options,
      signal: controller.signal,
      onEvent: observed,
    },
  );
  await progress;
  const pid = [...pids][0]!;
  await expect(
    retireIdleLocalEngine(f.config, {
      timeoutMs: 200,
      findProcesses: async () => [pid],
    }),
  ).rejects.toThrow("ENGINE_EXIT_UNCONFIRMED");
  expect(() => process.kill(pid, 0)).not.toThrow();
  controller.abort();
  await expect(request).rejects.toThrow("CANCELLED");
});
it("awaits durable engine registration before dispatching any work", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const beforeProcess = vi.fn(async () => gate);
  const request = runLocalEngine(
    f.config,
    join(f.root, "source"),
    f.root,
    "A".repeat(43) + "=",
    { ...f.options, beforeProcess },
  );
  await vi.waitFor(() => expect(beforeProcess).toHaveBeenCalledOnce());
  await expect(readFile(join(f.root, "requests"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  release();
  const result = await request;
  expect(result.calls).toBe(1);
  await retireLocalEngine(f.config, Number(result.pid));
  expect(() => process.kill(Number(result.pid), 0)).toThrow();
});
it("does not dispatch or replay when durable registration fails", async () => {
  const f = await fixture();
  let pid = 0;
  await expect(
    runLocalEngine(
      f.config,
      join(f.root, "source"),
      f.root,
      "A".repeat(43) + "=",
      {
        ...f.options,
        beforeProcess: async (value) => {
          pid = value;
          throw new Error("WORKER_COORDINATION_UNAVAILABLE");
        },
      },
    ),
  ).rejects.toThrow("WORKER_COORDINATION_UNAVAILABLE");
  await expect(readFile(join(f.root, "requests"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await retireLocalEngine(f.config, pid);
});
it("retires the old identity and starts a new process before accepting work", async () => {
  const f = await fixture();
  const first = await f.run();
  await writeFile(
    join(f.root, "local_engine_service.py"),
    "new-service-identity",
  );
  const next = await f.run();
  expect(next.pid).not.toBe(first.pid);
  expect(next.calls).toBe(1);
});
it("never replays an accepted request after a lost response", async () => {
  const f = await fixture();
  await expect(f.run("disconnect")).rejects.toThrow("ENGINE_UNAVAILABLE");
  expect(await readFile(join(f.root, "requests"), "utf8")).toBe("1\n");
});
it("cancels an active exchange without resubmitting", async () => {
  const f = await fixture(),
    controller = new AbortController();
  await expect(
    runLocalEngine(
      f.config,
      join(f.root, "block"),
      f.root,
      "A".repeat(43) + "=",
      {
        ...f.options,
        signal: controller.signal,
        onEvent() {
          controller.abort();
        },
      },
    ),
  ).rejects.toThrow("CANCELLED");
  expect(await readFile(join(f.root, "requests"), "utf8")).toBe("1\n");
});
it("rejects an unsafe socket path before launching a process", async () => {
  const f = await fixture();
  const name = createHash("sha256").update(f.root).digest("hex").slice(0, 24);
  const directory = join(
    await realpath("/tmp"),
    `mm-engine-${process.getuid?.()}-${name}`,
  );
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "engine.sock"), "not a socket", {
    mode: 0o600,
  });
  await expect(f.run()).rejects.toThrow("ENGINE_SOCKET_UNSAFE");
  expect(pids.size).toBe(0);
});
