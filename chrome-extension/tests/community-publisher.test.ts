import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseCommunityPlayback } from "../src/companion/community-playback.js";
import {
  runCommunityPublisher,
  startCommunityPublisher,
} from "../src/companion/community-publisher.js";
import type { LocalConfig } from "../src/companion/config.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";
import {
  YouTubeCommunityClient,
  YOUTUBE_COMMUNITY_PROFILE,
  type CommunityContribution,
} from "../src/companion/youtube-community-client.js";
import { YouTubeCommunityOutbox } from "../src/companion/youtube-community-outbox.js";
import { DesktopApiError } from "../src/companion/account-api.js";
import { withCacheMutation } from "../src/companion/cache-mutator.js";
import { setTimeout as delay } from "node:timers/promises";
import type { JobSnapshot } from "../src/shared/protocol.js";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-background-publication-"));
  roots.push(root);
  const config = { root, node_path: process.execPath } as LocalConfig;
  const work = join(root, "scratch");
  await mkdir(work, { mode: 0o700 });
  const original = {
    path: join(work, "original.m4a"),
    extension: "m4a",
    content_type: "audio/mp4",
    duration_seconds: 5,
    bytes: 8,
    sha256: createHash("sha256").update("original").digest("hex"),
  };
  const vocals = {
    path: join(work, "vocals.mp3"),
    extension: "mp3",
    content_type: "audio/mpeg",
    duration_seconds: 5,
    bytes: 6,
    sha256: createHash("sha256").update("vocals").digest("hex"),
  };
  await writeFile(original.path, "original", { mode: 0o600 });
  await writeFile(vocals.path, "vocals", { mode: 0o600 });
  const contribution: CommunityContribution = {
    contribution_id: "0123456789abcdef01234567",
    request_id: randomUUID(),
    video_id: "bZxrIoCPsOc",
    profile_id: YOUTUBE_COMMUNITY_PROFILE,
    state: "preparing",
    producer: true,
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    lease_expires_at: null,
    upload_grants: null,
  };
  let offline = false;
  let missing = false;
  const uploaded = new Set<string>();
  const grant = (kind: "original" | "vocals") => {
    const item = kind === "original" ? original : vocals;
    const digest = Buffer.from(item.sha256, "hex").toString("base64");
    return {
      method: "PUT",
      url: `https://fixture.r2.cloudflarestorage.com/${kind}?signature=private`,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      headers: {
        "Content-Type": item.content_type,
        "If-None-Match": "*",
        "x-amz-checksum-sha256": digest,
        "x-amz-meta-sha256": digest,
      },
    };
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === "PUT") {
      if (offline) throw new Error("offline private URL must not escape");
      uploaded.add(new URL(String(url)).pathname);
      return new Response(null, { status: 200 });
    }
    const complete = String(url).endsWith("/completions");
    if (missing && String(url).endsWith("/upload-grants"))
      return new Response(
        JSON.stringify({ code: "YOUTUBE_CONTRIBUTION_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    if (complete && uploaded.size !== 2)
      return new Response(JSON.stringify({ code: "UPLOAD_NOT_READY" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    return new Response(
      JSON.stringify({
        ...contribution,
        state: complete ? "ready" : "awaiting_upload",
        upload_grants: complete
          ? null
          : { original: grant("original"), vocals: grant("vocals") },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const client = new YouTubeCommunityClient(
    "https://api.music-mute.com",
    {
      load: async () => ({
        token: "g".repeat(64),
        expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      }),
      save: async () => {},
    },
    fetcher,
  );
  const outbox = new YouTubeCommunityOutbox(
    join(root, "youtube-community-outbox"),
    fetcher,
  );
  await outbox.stage(contribution, original, vocals, {
    defer_publication: true,
  });
  const snapshot: JobSnapshot = {
    job_id: randomUUID(),
    video_id: contribution.video_id,
    provider: "LOCAL_MACOS",
    state: "READY",
    stage: "ready",
    save_state: "pending",
    media: {
      url: "http://127.0.0.1:4567/vocals?capability=private",
      duration_seconds: 5,
      trim_enabled: false,
      model_id: MODEL_SHA256,
    },
  };
  const identity = {
    job_id: snapshot.job_id,
    video_id: snapshot.video_id,
    sha256: vocals.sha256,
  };
  return {
    root,
    work,
    config,
    original,
    vocals,
    contribution,
    snapshot,
    identity,
    fetcher,
    client,
    outbox,
    uploadGrants: { original: grant("original"), vocals: grant("vocals") },
    offline(value: boolean) {
      offline = value;
    },
    missing(value: boolean) {
      missing = value;
    },
  };
}

describe("background community publication", () => {
  it("waits for brief background metadata contention before restoring pending vocals", async () => {
    const e = await fixture();
    let acquired!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withCacheMutation(e.outbox.root, async () => {
      acquired();
      await gate;
    });
    await locked;
    let finished = false;
    const restoring = e.outbox
      .restorePending(
        e.identity.video_id,
        5,
        join(e.root, "restored"),
        new AbortController().signal,
      )
      .then((result) => {
        finished = true;
        return result;
      });
    try {
      await delay(75);
      expect(finished).toBe(false);
      release();
      await holder;
      const restored = await restoring;
      expect(restored?.publication_ready).toBe(false);
      expect(await readFile(restored!.vocals.path, "utf8")).toBe("vocals");
      expect(e.fetcher).not.toHaveBeenCalled();
    } finally {
      release();
      await holder;
      await restoring;
    }
  });
  it("cancels a metadata-lock wait promptly without losing or releasing the pending pair", async () => {
    const e = await fixture();
    let acquired!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withCacheMutation(e.outbox.root, async () => {
      acquired();
      await gate;
    });
    await locked;
    const controller = new AbortController();
    const restoring = e.outbox.restorePending(
      e.identity.video_id,
      5,
      join(e.root, "restored"),
      controller.signal,
    );
    const rejected = expect(restoring).rejects.toThrow("CANCELLED");
    try {
      await delay(75);
      controller.abort();
      await rejected;
      const record = (await e.outbox.records())[0]!;
      expect(record).toMatchObject({
        state: "pending",
        publication_ready: false,
      });
      expect(await readFile(record.original.path, "utf8")).toBe("original");
      expect(await readFile(record.vocals.path, "utf8")).toBe("vocals");
      expect(e.fetcher).not.toHaveBeenCalled();
    } finally {
      release();
      await holder;
    }
  });
  it("bounds persistent metadata contention and leaves durable bytes available for another attempt", async () => {
    const e = await fixture();
    let acquired!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withCacheMutation(e.outbox.root, async () => {
      acquired();
      await gate;
    });
    await locked;
    const started = performance.now();
    try {
      await expect(
        e.outbox.restorePending(
          e.identity.video_id,
          5,
          join(e.root, "restored"),
          new AbortController().signal,
        ),
      ).rejects.toThrow("LOCAL_COMPANION_BUSY");
      expect(performance.now() - started).toBeLessThan(8_000);
      const record = (await e.outbox.records())[0]!;
      expect(await readFile(record.vocals.path, "utf8")).toBe("vocals");
      expect(record.publication_ready).toBe(false);
    } finally {
      release();
      await holder;
    }
  }, 10_000);
  it("never replays a metadata operation that already began before reporting a busy error", async () => {
    const e = await fixture();
    const records = vi
      .spyOn(e.outbox, "records")
      .mockRejectedValueOnce(new Error("LOCAL_COMPANION_BUSY"));
    await expect(
      e.outbox.restorePending(
        e.identity.video_id,
        5,
        join(e.root, "restored"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("LOCAL_COMPANION_BUSY");
    expect(records).toHaveBeenCalledTimes(1);
    expect((await e.outbox.records())[0]?.publication_ready).toBe(false);
  });
  it("does not repeatedly obtain grants when a held reservation already has a ready shared result", async () => {
    const e = await fixture();
    vi.spyOn(e.client, "uploadGrants").mockResolvedValue({
      ...e.contribution,
      state: "ready",
      producer: false,
    });
    await runCommunityPublisher(e.config, {
      outbox: e.outbox,
      client: async () => e.client,
    });
    await runCommunityPublisher(e.config, {
      outbox: e.outbox,
      client: async () => e.client,
    });
    expect(e.client.uploadGrants).toHaveBeenCalledTimes(1);
    expect(e.fetcher).not.toHaveBeenCalled();
    expect((await e.outbox.records())[0]).toMatchObject({
      state: "pending",
      publication_ready: false,
      publication_declared: true,
    });
  });
  it("keeps queued bytes when the publisher's independent deadline expires", async () => {
    const e = await fixture();
    await e.outbox.release(e.identity.video_id, e.identity.sha256);
    e.offline(true);
    const controller = new AbortController();
    await runCommunityPublisher(e.config, {
      outbox: e.outbox,
      client: async () => e.client,
      signal: controller.signal,
      wait: async () => {
        controller.abort();
      },
    });
    const record = (await e.outbox.records())[0]!;
    expect(record.state).toBe("pending");
    expect(await readFile(record.vocals.path, "utf8")).toBe("vocals");
  });
  it("does not let an unplayed old guest reservation block new acquisition metadata", async () => {
    const e = await fixture();
    e.missing(true);
    await e.outbox.declarePending(e.client);
    await runCommunityPublisher(e.config, {
      outbox: e.outbox,
      client: async () => e.client,
    });
    const record = (await e.outbox.records())[0]!;
    expect(record).toMatchObject({
      state: "pending",
      publication_ready: false,
      publication_declared: true,
    });
    expect(await readFile(record.original.path, "utf8")).toBe("original");
    expect(e.fetcher.mock.calls).toHaveLength(1);
  });
  it("primes metadata without uploading held audio, even across publisher restart", async () => {
    const e = await fixture();
    const run = () =>
      runCommunityPublisher(e.config, {
        outbox: e.outbox,
        client: async () => e.client,
      });
    await run();
    await run();
    expect(
      e.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(0);
    expect(e.fetcher.mock.calls).toHaveLength(1);
    expect((await e.outbox.records())[0]).toMatchObject({
      state: "pending",
      publication_ready: false,
      publication_declared: true,
    });
  });
  it("rebinds an expired preparation lease only after playback releases its immutable pair", async () => {
    const e = await fixture();
    await rm(e.work, { recursive: true });
    const replacementId = "0123456789abcdef01234568";
    const reserve = vi
      .spyOn(e.client, "reserve")
      .mockImplementation(async (_videoId, _signal, requestId) => ({
        ...e.contribution,
        contribution_id: replacementId,
        request_id: requestId!,
        lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
      }));
    vi.spyOn(e.client, "uploadGrants").mockImplementation(
      async (contribution) => {
        if (contribution.contribution_id === e.contribution.contribution_id)
          throw new DesktopApiError("YOUTUBE_CONTRIBUTION_EXPIRED", 410);
        return {
          ...contribution,
          state: "awaiting_upload",
          upload_grants: e.uploadGrants,
        };
      },
    );
    vi.spyOn(e.client, "complete").mockImplementation(async (contribution) => ({
      ...contribution,
      state: "ready",
      upload_grants: null,
    }));
    await e.outbox.declarePending(e.client);
    await runCommunityPublisher(e.config, {
      outbox: e.outbox,
      client: async () => e.client,
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(e.fetcher).not.toHaveBeenCalled();
    const pending = (await e.outbox.records())[0]!;
    expect(pending).toMatchObject({
      state: "pending",
      publication_ready: false,
      publication_declared: true,
    });
    expect(await readFile(pending.original.path, "utf8")).toBe("original");
    expect(await readFile(pending.vocals.path, "utf8")).toBe("vocals");
    await releaseCommunityPlayback(
      e.snapshot,
      e.identity,
      e.identity,
      e.outbox,
      async () => {},
    );
    const controller = new AbortController();
    const wait = vi.fn(async () => controller.abort());
    await runCommunityPublisher(e.config, {
      outbox: e.outbox,
      client: async () => e.client,
      signal: controller.signal,
      wait,
    });
    const receipt = (await e.outbox.records())[0]!;
    expect(receipt).toMatchObject({
      state: "committed",
      request_id: pending.request_id,
      contribution_id: replacementId,
      producer_request_id: expect.any(String),
      original: {
        sha256: pending.original.sha256,
        bytes: pending.original.bytes,
      },
      vocals: { sha256: pending.vocals.sha256, bytes: pending.vocals.bytes },
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(
      e.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(2);
  });
  it.each([
    [410, "OTHER_EXPIRY_FAILURE"],
    [403, "YOUTUBE_CONTRIBUTION_EXPIRED"],
  ])("does not rebind unrelated %i %s failures", async (status, code) => {
    const e = await fixture();
    await e.outbox.release(e.identity.video_id, e.identity.sha256);
    vi.spyOn(e.client, "uploadGrants").mockRejectedValue(
      new DesktopApiError(code, status),
    );
    const reserve = vi.spyOn(e.client, "reserve");
    await e.outbox.drain(e.client);
    expect(reserve).not.toHaveBeenCalled();
    expect(e.fetcher).not.toHaveBeenCalled();
    const record = (await e.outbox.records())[0]!;
    expect(record.state).toBe("pending");
    expect(await readFile(record.original.path, "utf8")).toBe("original");
  });
  it("releases the exact first-play pair, survives scratch removal and commits independently", async () => {
    const e = await fixture();
    await rm(e.work, { recursive: true });
    const start = vi.fn(async () => {});
    await expect(
      releaseCommunityPlayback(
        e.snapshot,
        e.identity,
        e.identity,
        e.outbox,
        start,
      ),
    ).resolves.toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    await runCommunityPublisher(e.config, {
      outbox: e.outbox,
      client: async () => e.client,
    });
    const record = (await e.outbox.records())[0]!;
    expect(record.state).toBe("committed");
    expect(
      e.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(2);
    await expect(readFile(record.vocals.path)).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    const receipt = await readFile(
      join(e.outbox.root, record.request_id, "record.json"),
      "utf8",
    );
    expect(receipt).not.toContain("signature");
    expect(receipt).not.toContain("gggg");
  });
  it("rejects old, stopped and cloud acknowledgements without releasing bytes", async () => {
    const e = await fixture();
    const start = vi.fn(async () => {});
    for (const snapshot of [
      null,
      { ...e.snapshot, state: "CANCELLED" as const },
      { ...e.snapshot, provider: "ONLINE_MUSICMUTE" as const },
      { ...e.snapshot, job_id: randomUUID() },
    ])
      await expect(
        releaseCommunityPlayback(
          snapshot,
          e.identity,
          e.identity,
          e.outbox,
          start,
        ),
      ).rejects.toThrow("STALE_JOB");
    expect(start).not.toHaveBeenCalled();
    expect((await e.outbox.records())[0]?.publication_ready).toBe(false);
    expect(await e.outbox.release(e.identity.video_id, "0".repeat(64))).toBe(
      false,
    );
  });
  it("keeps a released pair after launcher failure and retries offline transfers with bounded backoff", async () => {
    const e = await fixture();
    await expect(
      releaseCommunityPlayback(
        e.snapshot,
        e.identity,
        e.identity,
        e.outbox,
        async () => {
          throw new Error("COMMUNITY_PUBLISHER_UNAVAILABLE");
        },
      ),
    ).rejects.toThrow("COMMUNITY_PUBLISHER_UNAVAILABLE");
    expect((await e.outbox.records())[0]?.publication_ready).toBe(true);
    e.offline(true);
    const wait = vi.fn(async () => {
      const record = (await e.outbox.records())[0]!;
      expect(await readFile(record.vocals.path, "utf8")).toBe("vocals");
      e.offline(false);
    });
    await runCommunityPublisher(e.config, {
      outbox: e.outbox,
      client: async () => e.client,
      wait,
    });
    expect(wait).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    expect((await e.outbox.records())[0]?.state).toBe("committed");
  });
  it("serializes media transfer across independent outbox instances", async () => {
    const e = await fixture();
    await e.outbox.release(e.identity.video_id, e.identity.sha256);
    let done!: () => void;
    const gate = new Promise<void>((resolve) => {
      done = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (...args) => {
      if (args[1]?.method === "PUT") await gate;
      return e.fetcher(...args);
    });
    const first = new YouTubeCommunityOutbox(e.outbox.root, fetcher);
    const second = new YouTubeCommunityOutbox(e.outbox.root, fetcher);
    const running = first.drain(e.client);
    try {
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      await expect(second.drain(e.client)).rejects.toThrow(
        "LOCAL_COMPANION_BUSY",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      done();
      await running;
    }
    await second.drain(e.client);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("launches a detached uploader with private pipes and keeps it alive after its launcher exits", async () => {
    const e = await fixture();
    const completed = join(e.root, "detached-completed");
    const childScript = join(e.root, "cli.js");
    const launcher = join(e.root, "launcher.mjs");
    const publisher = join(e.root, "publisher.mjs");
    await build({
      entryPoints: [
        fileURLToPath(
          new URL("../src/companion/community-publisher.ts", import.meta.url),
        ),
      ],
      outfile: publisher,
      platform: "node",
      format: "esm",
      bundle: true,
      target: "node24",
    });
    await writeFile(
      childScript,
      `import { writeFile } from 'node:fs/promises'; setTimeout(() => { void writeFile(${JSON.stringify(completed)}, 'done'); }, 200);`,
      { mode: 0o600 },
    );
    await writeFile(
      launcher,
      `import { startCommunityPublisher } from ${JSON.stringify(pathToFileURL(publisher).href)}; await startCommunityPublisher(${JSON.stringify(e.config)});`,
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [launcher], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("launcher failed")),
      );
    });
    await vi.waitFor(async () =>
      expect(await readFile(completed, "utf8")).toBe("done"),
    );
    await expect(
      startCommunityPublisher({
        ...e.config,
        node_path: join(e.root, "missing-node"),
      }),
    ).rejects.toThrow("COMMUNITY_PUBLISHER_UNAVAILABLE");
  });
});
