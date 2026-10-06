import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeFrame, FrameDecoder } from "../src/companion/native-protocol.js";
import type { NativeReply } from "../src/shared/protocol.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";

let root: string, entry: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "musicmute-host-selection-"));
  entry = join(root, "host.mjs");
  await build({
    entryPoints: [resolve("src/companion/host.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    plugins: [
      {
        name: "isolated-native-cloud",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^\.\/(config|browser-processing-bridge|browser-cloud-provider)\.js$/,
            },
            (args) =>
              args.importer.endsWith("/host.ts")
                ? { path: args.path, namespace: "selection-fixture" }
                : undefined,
          );
          builder.onLoad(
            { filter: /.*/, namespace: "selection-fixture" },
            (args) => {
              if (args.path.endsWith("config.js"))
                return {
                  contents: `
            import {join} from 'node:path';
            export async function loadLocalConfig() { const root=process.env.MM_SELECTION_ROOT;
              return {root,cache_root:join(root,'cache'),logs_root:join(root,'logs'),models_root:join(root,'models'),python_path:'/unused',node_path:process.execPath,ffmpeg_path:'/unused',ffprobe_path:'/unused',yt_dlp_path:'/unused',js_runtime_path:process.execPath,engine_root:'/unused',runner_path:'/unused'}; }
            export async function inspectLocalReadiness() { throw new Error('SETUP_REQUIRED'); }
          `,
                };
              if (args.path.endsWith("browser-processing-bridge.js"))
                return {
                  contents: `
            import {readFile} from 'node:fs/promises'; import {join} from 'node:path';
            export class BrowserProcessingBridge { constructor(config){this.config=config;}
              async provider(){return (await readFile(join(this.config.root,'selection'),'utf8')) === 'cloud' ? 'ONLINE_MUSICMUTE' : 'LOCAL_MACOS';}
              async session(owner){return {firebase_uid:owner.uid,session_generation:owner.session_generation,installation_id:'11111111-1111-4111-8111-111111111111',id_token:'synthetic.token.signature'};}
            }
          `,
                };
              return {
                contents: `
            import {createHash} from 'node:crypto'; import {mkdir,readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
            export class BrowserCloudProvider { id='ONLINE_MUSICMUTE'; constructor(config,options){this.config=config;this.options=options;}
              async prepare(request,workRoot,hooks){
                const scope=await this.options.session(hooks.signal);
                await this.options.verifyCurrent(scope); hooks.onProgress('cloud_processing_processing');
                if(process.env.MM_SELECTION_WAIT === '1') await new Promise((done,failed)=>{if(hooks.signal.aborted)failed(new Error('CANCELLED'));else hooks.signal.addEventListener('abort',()=>failed(new Error('CANCELLED')),{once:true});});
                await mkdir(workRoot,{recursive:true,mode:0o700});
                await writeFile(join(this.config.root,'cloud-uploaded'),'only isolated cloud adapter ran',{mode:0o600});
                const bytes=Buffer.from('synthetic vocals');const output_path=join(workRoot,'vocals.mp3');
                await writeFile(output_path,bytes,{mode:0o600});this.options.onCloudJob?.(scope,'a'.repeat(24));
                return {output_path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),model_id:'${MODEL_SHA256}',trim_enabled:false,duration_seconds:request.duration_seconds,source_duration_seconds:request.duration_seconds,timings_ms:{}};
              }
            }
          `,
              };
            },
          );
        },
      },
    ],
  });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixture(signedIn: boolean, waiting = false) {
  const directory = join(root, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const generation = randomUUID();
  await writeFile(join(directory, "selection"), "cloud", { mode: 0o600 });
  await writeFile(
    join(directory, "account-state.json"),
    JSON.stringify({
      version: 1,
      firebase_uid: signedIn ? "fixture-owner" : null,
      session_generation: signedIn ? generation : null,
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [entry, `chrome-extension://${"a".repeat(32)}`],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        MM_SELECTION_ROOT: directory,
        MM_SELECTION_WAIT: waiting ? "1" : "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const replies: NativeReply[] = [];
  const decoder = new FrameDecoder();
  child.stdout.on("data", (chunk: Buffer) =>
    replies.push(...(decoder.push(chunk) as NativeReply[])),
  );
  const send = (type: string, payload: unknown) => {
    const request_id = randomUUID();
    child.stdin.write(
      encodeFrame({ protocol_version: 1, request_id, type, payload }),
    );
    return request_id;
  };
  const reply = async (id: string) => {
    let found: NativeReply | undefined;
    await vi.waitFor(
      () => {
        found = replies.find((item) => item.request_id === id);
        expect(found).toBeDefined();
      },
      { timeout: 5000 },
    );
    return found!;
  };
  return { directory, child, replies, send, reply };
}
async function stop(child: ChildProcessWithoutNullStreams) {
  child.stdin.end();
  await vi
    .waitFor(() => expect(child.exitCode).not.toBeNull(), { timeout: 5000 })
    .catch((error: unknown) => {
      child.kill("SIGKILL");
      throw error;
    });
}
const payload = {
  video_id: "AbCdEfGh_-1",
  duration_seconds: 3,
  provider: "ONLINE_MUSICMUTE",
};
describe("native host saved processing choice", () => {
  it("does not write cancellation snapshots into Chrome's closed pipe during shutdown", async () => {
    const host = await fixture(true, true);
    try {
      await host.reply(host.send("HELLO", {}));
      await host.reply(host.send("START", payload));
      host.child.stdout.destroy();
      host.child.stdin.end();
      await vi.waitFor(() => expect(host.child.exitCode).not.toBeNull(), {
        timeout: 5000,
      });
      const events = await readFile(
        join(host.directory, "logs/events.jsonl"),
        "utf8",
      );
      expect(events).toContain("job_cancelled");
      expect(events).toContain("companion_stopped");
      expect(events).not.toContain("COMPANION_CRASH");
      expect(host.child.exitCode).toBe(0);
    } finally {
      if (host.child.exitCode === null) await stop(host.child);
    }
  });
  it("closes cleanly when Chrome closes its reply pipe before a reply", async () => {
    const host = await fixture(true);
    try {
      await host.reply(host.send("HELLO", {}));
      host.child.stdout.destroy();
      host.send("STATUS", {});
      await vi.waitFor(() => expect(host.child.exitCode).not.toBeNull(), {
        timeout: 5000,
      });
      const events = await readFile(
        join(host.directory, "logs/events.jsonl"),
        "utf8",
      );
      expect(events).not.toContain("COMPANION_CRASH");
      expect(events).toContain("NATIVE_PIPE_CLOSED");
      expect(host.child.exitCode).toBe(0);
    } finally {
      if (host.child.exitCode === null) await stop(host.child);
    }
  });
  it("serves cloud playback without loading the local model, and checks preference changes before START", async () => {
    const host = await fixture(true);
    try {
      const legacyHello = await host.reply(host.send("HELLO", {}));
      expect(legacyHello).toMatchObject({
        type: "HELLO",
        payload: { capabilities: ["error_context_v1", "cloud_handoff_v1"] },
      });
      const hello = await host.reply(
        host.send("HELLO", { capabilities: ["processing_selection_v1"] }),
      );
      expect(hello).toMatchObject({
        type: "HELLO",
        payload: { ready: true, processing_provider: "ONLINE_MUSICMUTE" },
      });
      await host.reply(host.send("START", payload));
      await vi.waitFor(
        () =>
          expect(
            host.replies.some(
              (item) =>
                item.type === "JOB" &&
                item.payload?.state === "READY" &&
                item.payload.provider === "ONLINE_MUSICMUTE",
            ),
          ).toBe(true),
        { timeout: 5000 },
      );
      expect(
        await readFile(join(host.directory, "cloud-uploaded"), "utf8"),
      ).toBe("only isolated cloud adapter ran");
      const ready = host.replies.find(
        (item) => item.type === "JOB" && item.payload?.state === "READY",
      );
      if (ready?.type !== "JOB" || !ready.payload)
        throw new Error("FIXTURE_NOT_READY");
      await host.reply(host.send("CANCEL", { job_id: ready.payload.job_id }));
      await writeFile(join(host.directory, "selection"), "local", {
        mode: 0o600,
      });
      const changed = await host.reply(host.send("START", payload));
      expect(changed).toMatchObject({
        type: "ERROR",
        payload: { error_code: "PROCESSING_SELECTION_CHANGED" },
      });
    } finally {
      await stop(host.child);
    }
  });
  it("refuses cloud for guests before acquisition or upload", async () => {
    const host = await fixture(false);
    try {
      const response = await host.reply(host.send("START", payload));
      expect(response).toMatchObject({
        type: "ERROR",
        payload: { error_code: "ACCOUNT_REQUIRED" },
      });
      await expect(
        readFile(join(host.directory, "cloud-uploaded")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(host.replies.some((item) => item.type === "JOB")).toBe(false);
    } finally {
      await stop(host.child);
    }
  });
  it("refuses a different account session between HELLO and START", async () => {
    const host = await fixture(true);
    try {
      await host.reply(
        host.send("HELLO", { capabilities: ["processing_selection_v1"] }),
      );
      const temporary = join(host.directory, "state.tmp");
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          firebase_uid: "fixture-owner",
          session_generation: randomUUID(),
        }),
        { mode: 0o600 },
      );
      await rename(temporary, join(host.directory, "account-state.json"));
      expect(await host.reply(host.send("START", payload))).toMatchObject({
        type: "ERROR",
        payload: { error_code: "ACCOUNT_CHANGED" },
      });
      await expect(
        readFile(join(host.directory, "cloud-uploaded")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await stop(host.child);
    }
  });
  it("cancels cloud work and fences late output when the account changes", async () => {
    const host = await fixture(true, true);
    try {
      await host.reply(
        host.send("HELLO", { capabilities: ["processing_selection_v1"] }),
      );
      await host.reply(host.send("START", payload));
      await vi.waitFor(
        () =>
          expect(
            host.replies.some(
              (item) =>
                item.type === "JOB" &&
                item.payload?.stage === "cloud_processing_processing",
            ),
          ).toBe(true),
        { timeout: 5000 },
      );
      const temporary = join(host.directory, "state.tmp");
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          firebase_uid: null,
          session_generation: null,
        }),
        { mode: 0o600 },
      );
      await rename(temporary, join(host.directory, "account-state.json"));
      await vi.waitFor(
        () =>
          expect(
            host.replies.some(
              (item) =>
                item.type === "JOB" &&
                item.payload?.error_code === "ACCOUNT_CHANGED",
            ),
          ).toBe(true),
        { timeout: 5000 },
      );
      expect(
        host.replies.some(
          (item) => item.type === "JOB" && item.payload?.state === "READY",
        ),
      ).toBe(false);
      await expect(
        readFile(join(host.directory, "cloud-uploaded")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await stop(host.child);
    }
  });
});
