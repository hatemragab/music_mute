import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DesktopCatalog } from "../src/companion/desktop-catalog.js";
import { accountCacheKey } from "../src/companion/account-cache.js";
import {
  FULL_TIMELINE_RECIPE_DIGEST,
  parseJobMetadata,
} from "../src/companion/cloud-provider.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";
import { encodeFrame, FrameDecoder } from "../src/companion/native-protocol.js";
import type { NativeReply } from "../src/shared/protocol.js";
import {
  AccountCacheRestoreQueue,
  type AccountRestoreAttempt,
} from "../src/companion/account-cache-restore.js";
import {
  readPlaybackPins,
  withCacheMutation,
} from "../src/companion/cache-mutator.js";
import { makeOfflineSpace } from "../src/companion/cache-budget.js";
import { localCacheKey } from "../src/companion/jobs.js";
import { NativeAccountState } from "../src/companion/account-state.js";

let root: string, entry: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mm-host-resident-"));
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
        name: "isolated-config",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/config\.js$/ }, (args) =>
            args.importer.endsWith("/host.ts")
              ? { path: "host-config", namespace: "fixture" }
              : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `
        import { join } from 'node:path';
        export async function loadLocalConfig() {
          const root = process.env.MUSICMUTE_HOST_FIXTURE_ROOT;
          return { root, cache_root:join(root,'cache'), logs_root:join(root,'logs'), models_root:join(root,'models'),
            python_path:'/unused/python', node_path:process.execPath, ffmpeg_path:'/unused/ffmpeg', ffprobe_path:'/unused/ffprobe',
            yt_dlp_path:'/unused/downloader', js_runtime_path:process.execPath, engine_root:'/unused/engine', runner_path:'/unused/runner' };
        }
        export async function inspectLocalReadiness() {}
      `,
          }));
        },
      },
    ],
  });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function publishAccount(
  directory: string,
  owner?: { uid: string; session_generation: string },
  raw?: string,
) {
  const temporary = join(directory, `.account-state-${randomUUID()}.tmp`);
  await writeFile(
    temporary,
    raw ??
      JSON.stringify({
        version: 1,
        firebase_uid: owner?.uid ?? null,
        session_generation: owner?.session_generation ?? null,
      }),
    { mode: 0o600 },
  );
  await rename(temporary, join(directory, "account-state.json"));
}
async function fixture(guest = false) {
  const directory = join(root, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const owner = { uid: "host-owner", session_generation: randomUUID() };
  const bytes = Buffer.from("isolated playback cache bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const job = parseJobMetadata({
    id: "a".repeat(24),
    request_id: randomUUID(),
    status: "ready",
    source_kind: "url",
    source_url: "https://www.youtube.com/watch?v=bZxrIoCPsOc",
    trim_enabled: false,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    can_download_output: true,
    can_download_input: false,
    input: {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: bytes.length,
      duration_seconds: 3,
      sha256: Buffer.from(sha256, "hex").toString("base64"),
    },
    output: {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: bytes.length,
      sha256: Buffer.from(sha256, "hex").toString("base64"),
      duration_seconds: 3,
    },
    error: null,
  });
  const cacheKey = guest
    ? localCacheKey({
        video_id: "bZxrIoCPsOc",
        duration_seconds: 3,
        provider: "LOCAL_MACOS",
      })
    : accountCacheKey(
        {
          firebase_uid: owner.uid,
          session_generation: owner.session_generation,
        },
        job,
      );
  const target = join(directory, "cache", "vocals", cacheKey),
    vocalPath = join(target, "vocals.mp3"),
    manifestPath = join(target, "result.json");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await writeFile(vocalPath, bytes, { mode: 0o600 });
  await writeFile(
    manifestPath,
    JSON.stringify({
      output_path: vocalPath,
      duration_seconds: 3,
      source_duration_seconds: 3,
      bytes: bytes.length,
      sha256,
      model_id: MODEL_SHA256,
      trim_enabled: false,
      timings_ms: {},
      ...(!guest
        ? {
            owner_uid: owner.uid,
            account_job_id: job.id,
            recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
            validation_version: 1,
          }
        : {}),
      source_title: "Acquired video title",
      source: { kind: "youtube", video_id: "bZxrIoCPsOc" },
    }),
    { mode: 0o600 },
  );
  const catalog = new DesktopCatalog(
    join(directory, "desktop-catalog"),
    join(directory, "cache"),
  );
  await catalog.remember(guest ? undefined : owner, {
    cache_key: cacheKey,
    operation_id: job.request_id,
    source_kind: "url",
    video_id: "bZxrIoCPsOc",
    vocal_path: vocalPath,
    duration_seconds: 3,
    source_duration_seconds: 3,
    bytes: bytes.length,
    sha256,
    ...(!guest ? { job_id: job.id } : {}),
    source_title: "My custom podcast name",
  });
  await publishAccount(directory, guest ? undefined : owner);
  return {
    directory,
    owner,
    cacheKey,
    vocalPath,
    manifestPath,
    bytes,
    target,
    job,
  };
}

async function startHost(
  directory: string,
  restore?: (
    queue: AccountCacheRestoreQueue,
    attempt: AccountRestoreAttempt,
  ) => Promise<void>,
  onReady?: (
    reply: NativeReply,
    replies: readonly NativeReply[],
  ) => Promise<void>,
): Promise<NativeReply[]> {
  const queueRoot = join(directory, "cache-restores");
  await mkdir(queueRoot, { mode: 0o700 });
  const state = JSON.parse(
    await readFile(join(directory, "account-state.json"), "utf8"),
  );
  const owner = {
    uid: String(state.firebase_uid),
    session_generation: String(state.session_generation),
  };
  const queue = new AccountCacheRestoreQueue(queueRoot);
  let timer: ReturnType<typeof setTimeout> | undefined,
    consumed = false,
    claiming = false,
    restoreTask: Promise<void> | undefined,
    readyTask: Promise<void> | undefined,
    restoreError: unknown;
  const watcher = restore
    ? watch(queueRoot, { recursive: true }, (_event, file) => {
        if (consumed || claiming || !String(file).endsWith("record.json"))
          return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (consumed || claiming) return;
          claiming = true;
          restoreTask = (async () => {
            let attempt: AccountRestoreAttempt | null = null;
            // The atomic filesystem notification can arrive before its writer
            // releases the fixture queue lock under parallel test load.
            await vi.waitFor(
              async () => {
                attempt = await queue.claimOne(owner);
                expect(attempt).not.toBeNull();
              },
              { timeout: 1_000 },
            );
            if (attempt && !consumed) {
              consumed = true;
              await restore(queue, attempt);
            }
          })()
            .catch((error: unknown) => {
              restoreError = error;
              child.kill("SIGKILL");
            })
            .finally(() => {
              claiming = false;
            });
        }, 30);
      })
    : undefined;
  const child = spawn(
    process.execPath,
    [entry, "chrome-extension://" + "a".repeat(32)],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        MUSICMUTE_LOCAL_TEST_MODE: "1",
        MUSICMUTE_LOCAL_FIXTURE_AUDIO: "/unused/inference-must-not-run.mp3",
        MUSICMUTE_HOST_FIXTURE_ROOT: directory,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const decoder = new FrameDecoder(),
    replies: NativeReply[] = [];
  return await new Promise((resolveResult, reject) => {
    const deadline = setTimeout(() => {
      restoreError = new Error("HOST_FIXTURE_TIMEOUT");
      child.kill("SIGKILL");
    }, 5000);
    let stderr = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.length;
    });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) {
          const reply = value as NativeReply;
          replies.push(reply);
          if (
            onReady &&
            reply.type === "JOB" &&
            reply.payload?.state === "READY"
          ) {
            readyTask = onReady(reply, replies).then(
              () => {
                child.stdin.end();
              },
              (error: unknown) => {
                restoreError = error;
                child.kill("SIGKILL");
              },
            );
          } else if (
            !readyTask &&
            (reply.type === "ERROR" ||
              (reply.type === "JOB" &&
                reply.payload &&
                ["READY", "FAILED", "CANCELLED"].includes(reply.payload.state)))
          )
            child.stdin.end();
        }
      } catch (error) {
        restoreError = error;
        child.kill("SIGKILL");
      }
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(timer);
      watcher?.close();
      void Promise.all([restoreTask, readyTask]).then(() => {
        if (restoreError) reject(restoreError);
        else if (code !== 0 || stderr)
          reject(new Error("HOST_FIXTURE_PROCESS_FAILED"));
        else resolveResult(replies);
      });
    });
    child.stdin.write(
      encodeFrame({
        protocol_version: 1,
        request_id: randomUUID(),
        type: "START",
        payload: {
          video_id: "bZxrIoCPsOc",
          duration_seconds: 3,
          provider: "LOCAL_MACOS",
        },
      }),
    );
  });
}

describe("native Chrome host resident account cache", () => {
  it.each(["guest-to-owner", "generation-change", "unsafe-state"] as const)(
    "notifies Chrome and releases an active playback pin after %s without replacing cached audio",
    async (transition) => {
      const env = await fixture(transition === "guest-to-owner");
      const cacheRoot = join(env.directory, "cache");
      const before = await readFile(env.manifestPath);
      const replies = await startHost(
        env.directory,
        undefined,
        async (ready, observed) => {
          if (ready.type !== "JOB" || !ready.payload?.media)
            throw new Error("HOST_MEDIA_REQUIRED");
          expect(await readPlaybackPins(cacheRoot)).toEqual(
            new Set([env.cacheKey]),
          );
          expect((await fetch(ready.payload.media.url)).status).toBe(200);
          await publishAccount(
            env.directory,
            transition === "generation-change"
              ? { ...env.owner, session_generation: randomUUID() }
              : env.owner,
            transition === "unsafe-state" ? "{" : undefined,
          );
          await vi.waitFor(() =>
            expect(
              observed.filter(
                (reply) =>
                  reply.type === "JOB" && reply.payload?.state === "CANCELLED",
              ),
            ).toHaveLength(1),
          );
          const cancelled = observed.find(
            (reply) =>
              reply.type === "JOB" && reply.payload?.state === "CANCELLED",
          );
          expect(cancelled).toMatchObject({
            request_id: ready.request_id,
            type: "JOB",
            payload: {
              job_id: ready.payload.job_id,
              video_id: ready.payload.video_id,
              state: "CANCELLED",
              stage: "cancelled",
            },
          });
          if (cancelled?.type === "JOB")
            expect(cancelled.payload?.media).toBeUndefined();
          expect(await readPlaybackPins(cacheRoot)).toEqual(new Set());
          expect((await fetch(ready.payload.media.url)).status).toBe(403);
          expect(await readFile(env.manifestPath)).toEqual(before);
          expect(await readFile(env.vocalPath)).toEqual(env.bytes);
        },
      );
      expect(
        replies.filter(
          (reply) => reply.type === "JOB" && reply.payload?.state === "READY",
        ),
      ).toHaveLength(1);
      expect(
        replies.some(
          (reply) =>
            reply.type === "JOB" &&
            reply.payload?.stage === "fixture-separation",
        ),
      ).toBe(false);
      const logs = (
        await Promise.all(
          (await readdir(join(env.directory, "logs")))
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) => readFile(join(env.directory, "logs", file), "utf8")),
        )
      ).join("\n");
      expect(logs).toContain(
        transition === "unsafe-state"
          ? "ACCOUNT_STATE_UNSAFE"
          : "ACCOUNT_CHANGED",
      );
      expect(logs).not.toContain(env.owner.uid);
      expect(logs).not.toContain(env.owner.session_generation);
    },
  );
  it("cancels an owner change during account restoration without late inference or READY", async () => {
    const env = await fixture();
    await rm(env.target, { recursive: true });
    const replies = await startHost(env.directory, async () => {
      await publishAccount(env.directory, {
        ...env.owner,
        session_generation: randomUUID(),
      });
    });
    expect(replies).toContainEqual(
      expect.objectContaining({
        type: "JOB",
        payload: expect.objectContaining({
          state: "CANCELLED",
          error_code: "ACCOUNT_CHANGED",
        }),
      }),
    );
    expect(
      replies.some(
        (reply) =>
          reply.type === "JOB" &&
          (reply.payload?.state === "READY" ||
            reply.payload?.stage === "fixture-separation"),
      ),
    ).toBe(false);
    expect(await readdir(join(env.directory, "cache", "vocals"))).toEqual([]);
    expect(await readPlaybackPins(join(env.directory, "cache"))).toEqual(
      new Set(),
    );
  });
  it("keeps playback active when authoritative account publications are unchanged", async () => {
    const env = await fixture();
    const replies = await startHost(
      env.directory,
      undefined,
      async (ready, observed) => {
        if (ready.type !== "JOB" || !ready.payload?.media)
          throw new Error("HOST_MEDIA_REQUIRED");
        const monitor = new NativeAccountState(env.directory);
        const invalidated = vi.fn();
        try {
          await monitor.start(invalidated);
          await publishAccount(env.directory, env.owner);
          expect(await monitor.isCurrent(env.owner)).toBe(true);
          // Give the actual child filesystem notification a bounded event-loop
          // window; production invalidation remains event-driven, without polling.
          await new Promise<void>((done) => setTimeout(done, 100));
          expect(invalidated).not.toHaveBeenCalled();
          expect(
            observed.some(
              (reply) =>
                reply.type === "JOB" && reply.payload?.state === "CANCELLED",
            ),
          ).toBe(false);
          expect(await readPlaybackPins(join(env.directory, "cache"))).toEqual(
            new Set([env.cacheKey]),
          );
          expect((await fetch(ready.payload.media.url)).status).toBe(200);
        } finally {
          monitor.close();
        }
      },
    );
    expect(
      replies.filter(
        (reply) => reply.type === "JOB" && reply.payload?.state === "READY",
      ),
    ).toHaveLength(1);
  });
  it("protects the active Chrome grant from another process's cache clear and releases on teardown", async () => {
    const env = await fixture(),
      cacheRoot = join(env.directory, "cache");
    const replies = await startHost(env.directory, undefined, async (reply) => {
      const pins = await readPlaybackPins(cacheRoot);
      expect(pins).toEqual(new Set([env.cacheKey]));
      const pin = JSON.parse(
        await readFile(
          join(cacheRoot, "pins", (await readdir(join(cacheRoot, "pins")))[0]!),
          "utf8",
        ),
      );
      expect(pin.pid).not.toBe(process.pid);
      expect(pin.process_start_identity).toMatch(/^[a-f0-9]{64}$/);
      // READY is flushed before the publishing writer releases its lease. Wait
      // for that tiny boundary so this proves the disk pin, rather than the lock.
      await vi.waitFor(
        async () => {
          await withCacheMutation(cacheRoot, async () => {
            expect(
              await makeOfflineSpace(
                cacheRoot,
                0,
                undefined,
                await readPlaybackPins(cacheRoot),
                { clear: true },
              ),
            ).toMatchObject({ evicted_entries: 0 });
          });
        },
        { timeout: 1_000 },
      );
      expect(await readFile(env.vocalPath)).toEqual(env.bytes);
      if (reply.type !== "JOB" || !reply.payload?.media)
        throw new Error("HOST_MEDIA_REQUIRED");
      const response = await fetch(reply.payload.media.url, {
        headers: { Range: "bytes=0-3" },
      });
      expect(response.status).toBe(206);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        env.bytes.subarray(0, 4),
      );
    });
    expect(
      replies.some(
        (reply) => reply.type === "JOB" && reply.payload?.state === "READY",
      ),
    ).toBe(true);
    expect(await readPlaybackPins(cacheRoot)).toEqual(new Set());
    expect(await readdir(join(cacheRoot, "pins"))).toEqual([]);
    expect(await readFile(env.vocalPath)).toEqual(env.bytes);
  });
  it("publishes resident account audio with no credentials or provider preparation and keeps one original cache entry", async () => {
    const env = await fixture(),
      before = await readFile(env.manifestPath);
    const replies = await startHost(env.directory);
    const ready = replies.find(
      (reply) => reply.type === "JOB" && reply.payload?.state === "READY",
    );
    expect(ready).toMatchObject({
      type: "JOB",
      payload: {
        state: "READY",
        cache_hit: true,
        media: {
          duration_seconds: 3,
          model_id: MODEL_SHA256,
          trim_enabled: false,
        },
      },
    });
    expect(
      replies.some(
        (reply) =>
          reply.type === "JOB" && reply.payload?.stage === "fixture-separation",
      ),
    ).toBe(false);
    expect(await readFile(env.manifestPath)).toEqual(before);
    expect(await readdir(join(env.directory, "cache", "vocals"))).toEqual([
      env.cacheKey,
    ]);
    expect(await readdir(join(env.directory, "sync-outbox"))).toEqual([]);
    expect(await readdir(join(env.directory, "sync-captures"))).toEqual([]);
    const catalog = new DesktopCatalog(
      join(env.directory, "desktop-catalog"),
      join(env.directory, "cache"),
    );
    expect(await catalog.sourceTitle(env.owner, env.cacheKey)).toBe(
      "My custom podcast name",
    );
  });
  it("restores one account miss through a token-free receipt outside the cache lease and publishes without inference", async () => {
    const env = await fixture(),
      manifest = await readFile(env.manifestPath);
    await rm(env.target, { recursive: true });
    let attempts = 0;
    const replies = await startHost(env.directory, async (queue, attempt) => {
      attempts++;
      expect(attempt).toMatchObject({
        owner: env.owner,
        video_id: "bZxrIoCPsOc",
        duration_seconds: 3,
      });
      await queue.assertActive(attempt);
      await withCacheMutation(join(env.directory, "cache"), async () => {
        await mkdir(env.target, { mode: 0o700 });
        await writeFile(env.vocalPath, env.bytes, { mode: 0o600 });
        await writeFile(env.manifestPath, manifest, { mode: 0o600 });
      });
      await queue.complete(attempt, {
        state: "ready",
        cache_key: env.cacheKey,
        job_id: env.job.id,
      });
    });
    expect(attempts).toBe(1);
    expect(replies).toContainEqual(
      expect.objectContaining({
        type: "JOB",
        payload: expect.objectContaining({ state: "READY", cache_hit: true }),
      }),
    );
    expect(
      replies.some(
        (reply) =>
          reply.type === "JOB" && reply.payload?.stage === "fixture-separation",
      ),
    ).toBe(false);
    expect(await readFile(env.manifestPath)).toEqual(manifest);
    expect(await readdir(join(env.directory, "cache", "vocals"))).toEqual([
      env.cacheKey,
    ]);
  });
  it("tries account lookup once and falls back to ordinary Local when the owner has no compatible saved result", async () => {
    const env = await fixture();
    await rm(env.target, { recursive: true });
    let attempts = 0;
    const replies = await startHost(env.directory, async (queue, attempt) => {
      attempts++;
      await queue.complete(attempt, { state: "missing" });
    });
    expect(attempts).toBe(1);
    expect(
      replies.filter(
        (reply) =>
          reply.type === "JOB" && reply.payload?.stage === "fixture-separation",
      ),
    ).toHaveLength(1);
    expect(replies).toContainEqual(
      expect.objectContaining({
        type: "JOB",
        payload: expect.objectContaining({ state: "FAILED" }),
      }),
    );
    expect(await readdir(join(env.directory, "cache", "vocals"))).toEqual([]);
  });
});
