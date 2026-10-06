import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";
import {
  runMacUserCommand,
  type MacUserCommandContext,
} from "../src/platform/macos/user-cli.js";
import { initializeLocalLifecycle } from "../src/runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import { personalEngineIdentity } from "../src/runtime/personal-admission.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mw-direct-")));
  roots.push(root);
  const layout = createMacUserLayout(join(root, "home"));
  await createMacUserDirectories(layout);
  await writeFile(layout.configPath, "{}", { mode: 0o600 });
  await writeFile(layout.credentialPath, "x".repeat(43), { mode: 0o600 });
  await mkdir(join(layout.releasesRoot, "fixture"), {
    recursive: true,
    mode: 0o700,
  });
  await symlink("releases/fixture", layout.currentLink);
  await initializeLocalLifecycle(layout.lifecyclePath);
  await writeLocalRuntimeStatus(layout.runtimeStatusPath, []);
  const launchAgent = {
    status: vi.fn(async () => ({ loaded: false, running: false })),
    bootstrap: vi.fn(async () => undefined),
    bootout: vi.fn(async () => undefined),
    kickstart: vi.fn(async () => undefined),
  };
  const context: MacUserCommandContext = {
    layout,
    launchAgent,
    host: {
      platform: "darwin",
      arch: "arm64",
      uid: process.getuid!(),
      home: layout.homeRoot,
    },
    stdout: () => undefined,
    preflight: async () => true,
  };
  return { root, layout, launchAgent, context };
}
async function idleEngine(state: string) {
  const id = createHash("sha256").update(randomUUID()).digest("hex");
  const directory = join(
    await realpath("/tmp"),
    `mm-engine-${process.getuid!()}-${id.slice(0, 24)}`,
  );
  roots.push(directory);
  await mkdir(directory, { mode: 0o700 });
  const socket = join(directory, "engine.sock");
  const script = `import net from 'node:net'; import fs from 'node:fs'; const socket = process.argv[1]; const id = process.argv[2]; const server = net.createServer(peer => { peer.write(JSON.stringify({type:'ready',pid:process.pid,engine_id:id})+'\\n'); let data=''; peer.on('data',chunk=>{data+=chunk; if(data.includes('\\n') && JSON.parse(data).operation==='retire'){peer.end();server.close(()=>process.exit(0));}}); });server.listen(socket,()=>{fs.chmodSync(socket,0o600);process.stdout.write('READY\\n');});`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, socket, id],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  await once(child.stdout!, "data");
  await writeFile(
    join(state, "personal-admission.json"),
    JSON.stringify({
      request_id: randomUUID(),
      phase: "idle",
      engine_pid: child.pid,
      process_identity: await personalEngineIdentity(child.pid!),
      engine_socket: socket,
      engine_id: id,
    }),
    { mode: 0o600 },
  );
  return child;
}

describe.skipIf(process.platform !== "darwin")(
  "direct current/bundled CLI GPU coordination",
  () => {
    it.each([
      ["install", ["--label", "Fixture"]],
      ["recover", []],
      ["update", []],
      ["start", []],
      ["restart", []],
      ["benchmark", []],
      ["benchmark-file", ["--input", "/private/tmp/fixture.wav"]],
      ["capacity", ["--workers", "1"]],
      ["cleanup", ["--apply"]],
    ] as const)(
      "blocks %s before any heavy callback when personal ownership is active/unknown",
      async (command, arguments_) => {
        const f = await fixture();
        await writeFile(
          join(f.layout.stateRoot, "personal-admission.json"),
          JSON.stringify({
            request_id: randomUUID(),
            phase: "active",
            client_pid: process.pid,
            client_identity: await personalEngineIdentity(process.pid),
          }),
          { mode: 0o600 },
        );
        const called = vi.fn(async () => ({}) as never);
        await expect(
          runMacUserCommand(command, arguments_, {
            ...f.context,
            install: called,
            recover: called,
            update: called,
            benchmark: called,
            benchmarkFile: called,
            preflight: called,
          }),
        ).rejects.toMatchObject({ errorCode: "WORKER_PERSONAL_BUSY" });
        expect(called).not.toHaveBeenCalled();
        expect(f.launchAgent.bootstrap).not.toHaveBeenCalled();
      },
    );

    it("retires a verified idle engine and waits for real process exit before direct benchmark", async () => {
      const f = await fixture();
      const engine = await idleEngine(f.layout.stateRoot);
      const benchmark = vi.fn(async () => {
        expect(await personalEngineIdentity(engine.pid!)).toBeUndefined();
        await expect(
          lstat(join(f.layout.stateRoot, "personal-admission.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          lstat(join(f.layout.stateRoot, "app-preparation.json")),
        ).resolves.toBeDefined();
        return { status: "PASS" };
      });
      expect(
        await runMacUserCommand("benchmark", ["--json"], {
          ...f.context,
          benchmark,
        }),
      ).toBe(0);
      expect(benchmark).toHaveBeenCalledOnce();
      await expect(
        lstat(join(f.layout.stateRoot, "app-preparation.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("fails closed on unknown historical prepared Python children without reading argv or killing them", async () => {
      const f = await fixture();
      const interpreter = join(
        f.layout.homeRoot,
        "Library",
        "Application Support",
        "MusicMuteLocal",
        "runtime",
        "releases",
        "fixture",
        "runtime",
        "runtime",
        "python",
        "bin",
        "python3",
      );
      await mkdir(join(interpreter, ".."), { recursive: true, mode: 0o700 });
      // Homebrew Node needs its relative libnode dylib; a self-contained system
      // executable provides the same owned comm-path identity for this fixture.
      await copyFile("/bin/sleep", interpreter, constants.COPYFILE_FICLONE);
      const engine = spawn(interpreter, ["30"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(engine);
      let stderr = "";
      engine.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      await Promise.race([
        vi.waitFor(async () => {
          expect(await personalEngineIdentity(engine.pid!)).toBeTypeOf(
            "string",
          );
        }),
        once(engine, "exit").then(([code, signal]) => {
          throw new Error(
            `Copied interpreter exited (${code ?? signal}): ${stderr}`,
          );
        }),
        once(engine, "error").then(([error]) => {
          throw error;
        }),
      ]);
      const benchmark = vi.fn(async () => ({ status: "PASS" }));
      await expect(
        runMacUserCommand("benchmark", ["--json"], { ...f.context, benchmark }),
      ).rejects.toMatchObject({ errorCode: "WORKER_PERSONAL_BUSY" });
      expect(benchmark).not.toHaveBeenCalled();
      expect(await personalEngineIdentity(engine.pid!)).toBeTypeOf("string");
    });
  },
);
