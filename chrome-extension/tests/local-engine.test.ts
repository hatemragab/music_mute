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
import { afterEach, expect, it } from "vitest";
import type { LocalConfig } from "../src/companion/config.js";
import { runLocalEngine } from "../src/companion/local-engine.js";

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
