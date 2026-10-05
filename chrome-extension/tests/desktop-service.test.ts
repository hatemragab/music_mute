import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeDesktopRequest } from "../src/companion/desktop-service.js";
import {
  LocalProcessingError,
  MODEL_SHA256,
} from "../src/companion/local-provider.js";
import { LocalSyncCaptureQueue } from "../src/companion/local-sync-capture.js";
import {
  CloudProcessingProvider,
  FULL_TIMELINE_RECIPE_DIGEST,
  parseJobMetadata,
} from "../src/companion/cloud-provider.js";
import * as fileProvider from "../src/companion/file-provider.js";
import { JobManager, localCacheKey } from "../src/companion/jobs.js";
import * as jobWorkspaces from "../src/companion/job-workspace.js";
import {
  pinPlaybackHandoff,
  withCacheMutation,
} from "../src/companion/cache-mutator.js";
import { offlineCacheBytes } from "../src/companion/cache-budget.js";
import { readOfflineCacheBudget } from "../src/companion/cache-settings.js";
import { LocalSyncOutbox } from "../src/companion/sync-outbox.js";
import { LocalPairSyncClient } from "../src/companion/local-sync-client.js";
import {
  ACCOUNT_RESTORE_DEADLINE_MS,
  AccountCacheRestoreQueue,
} from "../src/companion/account-cache-restore.js";
import { accountCacheKey } from "../src/companion/account-cache.js";
import { DesktopCatalog } from "../src/companion/desktop-catalog.js";
import type { LocalConfig } from "../src/companion/config.js";
import type { DesktopRequest } from "../src/shared/desktop-protocol.js";
import type { ProcessingProvider } from "../src/shared/protocol.js";
const roots: string[] = [];
async function fixtureToolGuard(config: LocalConfig, root: string) {
  config.python_path = join(root, "fixture-tool-guard");
  await writeFile(
    config.python_path,
    '#!/bin/sh\nwhile [ "$1" != "--run" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n',
    { mode: 0o700 },
  );
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function warmFileFixture() {
  const e = await fixture(),
    session = {
      firebase_uid: "file-owner-a",
      session_generation: randomUUID(),
      installation_id: randomUUID(),
    },
    owner = {
      uid: session.firebase_uid,
      session_generation: session.session_generation,
    },
    input = join(e.root, "user-original.wav"),
    original = Buffer.from("synthetic source fixture"),
    sourceSHA = createHash("sha256").update(original).digest("hex"),
    sourceDigest = createHash("sha256")
      .update(JSON.stringify([owner.uid, sourceSHA]))
      .digest("hex"),
    key = localCacheKey(
      { video_id: "local_file_", provider: "LOCAL_MACOS", duration_seconds: 5 },
      sourceDigest,
    ),
    cache = join(e.config.cache_root, "vocals", key),
    vocal = join(cache, "vocals.mp3"),
    metadata = join(cache, "result.json"),
    probe = join(e.root, "fixture-ffprobe");
  await writeFile(input, original, { mode: 0o600 });
  await writeFile(
    probe,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"format":{"duration":"5"},"streams":[{"codec_type":"audio"}]}\'\n',
    { mode: 0o700 },
  );
  e.config.ffprobe_path = probe;
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await writeFile(vocal, "fixture vocal", { mode: 0o600 });
  const retained = {
    output_path: vocal,
    source_duration_seconds: 5,
    duration_seconds: 5,
    bytes: 13,
    sha256: createHash("sha256").update("fixture vocal").digest("hex"),
    model_id: MODEL_SHA256,
    trim_enabled: false,
    timings_ms: {},
    owner_uid: owner.uid,
    original_declaration: {
      extension: "wav",
      content_type: "audio/wav",
      bytes: original.length,
      sha256: sourceSHA,
      duration_seconds: 5,
    },
  };
  await writeFile(metadata, JSON.stringify(retained), { mode: 0o600 });
  const request: DesktopRequest = {
      protocol_version: 1,
      request_id: randomUUID(),
      type: "LOCAL_START",
      session,
      payload: { source_kind: "file", source_path: input },
    },
    inference = vi
      .spyOn(fileProvider.FileLocalProvider.prototype, "prepare")
      .mockRejectedValue(new Error("UNEXPECTED_INFERENCE")),
    outbox = new LocalSyncOutbox(
      join(e.root, "sync-outbox"),
      e.config.cache_root,
    );
  return {
    ...e,
    session,
    owner,
    input,
    original,
    key,
    cache,
    vocal,
    metadata,
    retained,
    request,
    inference,
    outbox,
  };
}

async function accountFileFixture() {
  const e = await warmFileFixture();
  await writeFile(
    e.config.ffprobe_path,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"format":{"format_name":"mp3","duration":"5"},"streams":[{"codec_name":"mp3","codec_type":"audio","sample_rate":"44100","channels":2}]}\'\n',
    { mode: 0o700 },
  );
  e.config.app_resources = join(e.root, "public-resources");
  await fixtureToolGuard(e.config, e.root);
  await mkdir(e.config.app_resources, { mode: 0o700 });
  await writeFile(
    join(e.config.app_resources, "desktop-public-config.json"),
    JSON.stringify({ backend_base_url: "https://api.music-mute.com" }),
    { mode: 0o600 },
  );
  const request: DesktopRequest = {
    ...e.request,
    session: { ...e.session, id_token: "synthetic-fixture-token" },
  };
  const input = {
    ...e.retained.original_declaration,
    sha256: Buffer.from(e.retained.original_declaration.sha256, "hex").toString(
      "base64",
    ),
  };
  const job = parseJobMetadata({
    id: "0123456789abcdef01234567",
    request_id: randomUUID(),
    status: "ready",
    source_kind: "file",
    source_url: null,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    trim_enabled: false,
    input,
    output: {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: e.retained.bytes,
      duration_seconds: 5,
      sha256: Buffer.from(e.retained.sha256, "hex").toString("base64"),
    },
    can_download_input: true,
    can_download_output: true,
    error: null,
  });
  const lookup = vi
      .spyOn(CloudProcessingProvider.prototype, "findReusableFile")
      .mockResolvedValue(job),
    download = vi
      .spyOn(CloudProcessingProvider.prototype, "downloadJob")
      .mockResolvedValue({
        job,
        download_grant: {
          url: "https://fixture.r2.cloudflarestorage.com/output",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    creation = vi.spyOn(CloudProcessingProvider.prototype, "startFile"),
    stage = vi.spyOn(LocalSyncOutbox.prototype, "stage"),
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("fixture vocal", {
        headers: { "content-type": "audio/mpeg", "content-length": "13" },
      }),
    );
  return {
    ...e,
    request,
    inputDeclaration: input,
    job,
    lookup,
    download,
    creation,
    stage,
    fetcher,
    dependencies: { ...e.dependencies, fetcher },
  };
}

describe("selected-file account reuse before inference", () => {
  it("uses a fully verified same-owner local hit without account work", async () => {
    const e = await accountFileFixture();
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({ cache_hit: true, cache_key: e.key });
    expect(e.lookup).not.toHaveBeenCalled();
    expect(e.download).not.toHaveBeenCalled();
    expect(e.fetcher).not.toHaveBeenCalled();
    expect(e.inference).not.toHaveBeenCalled();
  });

  it.each(["evicted", "corrupt"])(
    "restores exact owned account vocals after a %s local entry without inference or pair upload",
    async (kind) => {
      const e = await accountFileFixture();
      if (kind === "evicted")
        await rm(e.cache, { recursive: true, force: true });
      else await writeFile(e.vocal, "wrong content", { mode: 0o600 });
      const output = await executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(e.lookup).toHaveBeenCalledExactlyOnceWith(
        e.inputDeclaration,
        undefined,
      );
      expect(e.download).toHaveBeenCalledExactlyOnceWith(
        e.job.id,
        e.inputDeclaration,
      );
      expect(output).toMatchObject({
        job_id: e.job.id,
        sync_state: "ready",
        cache_hit: false,
        duration_seconds: 5,
      });
      expect(await readFile(String(output.vocal_path), "utf8")).toBe(
        "fixture vocal",
      );
      expect(e.fetcher).toHaveBeenCalledOnce();
      expect(e.creation).not.toHaveBeenCalled();
      expect(e.inference).not.toHaveBeenCalled();
      expect(e.stage).not.toHaveBeenCalled();
      expect(await e.outbox.list(e.owner)).toEqual([]);
      expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
      expect(await readFile(e.input)).toEqual(e.original);
    },
  );

  it("uses an exact committed receipt as the first account lookup hint", async () => {
    const e = await accountFileFixture();
    await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    const [pending] = await e.outbox.list(e.owner);
    const attempt = await e.outbox.beginAttempt(e.owner, pending!.request_id);
    await e.outbox.commit(
      e.owner,
      pending!.request_id,
      {
        sync_id: "1123456789abcdef01234567",
        job_id: e.job.id,
        committed: true,
      },
      attempt.attempt_id!,
    );
    e.stage.mockClear();
    await rm(e.cache, { recursive: true, force: true });
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output.sync_state).toBe("ready");
    expect(e.lookup).toHaveBeenCalledExactlyOnceWith(
      e.inputDeclaration,
      e.job.id,
    );
    expect(e.stage).not.toHaveBeenCalled();
    expect(e.inference).not.toHaveBeenCalled();
  });

  it.each(["missing", "offline"])(
    "keeps local inference available when an account copy is %s",
    async (kind) => {
      const e = await accountFileFixture();
      await rm(e.cache, { recursive: true, force: true });
      if (kind === "missing") e.lookup.mockResolvedValue(null);
      else
        e.lookup.mockRejectedValue(
          new Error("private fixture network failure with synthetic token"),
        );
      e.inference.mockImplementation(async (...args) => {
        const { source: _source, ...audio } = await e.prepare(...args);
        return audio;
      });
      const output = await executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(output).toMatchObject({
        cache_hit: false,
        sync_state: "local_only",
      });
      expect(e.lookup).toHaveBeenCalledOnce();
      expect(e.inference).toHaveBeenCalledOnce();
      expect(e.download).not.toHaveBeenCalled();
      expect(e.creation).not.toHaveBeenCalled();
      expect(e.fetcher).not.toHaveBeenCalled();
      expect(
        await readFile(
          join(e.config.logs_root, "desktop", "events.jsonl"),
          "utf8",
        ),
      ).not.toContain("private fixture network failure");
    },
  );

  it.each(["account", "cancel"])(
    "fences a late account result before downloading or inference: %s",
    async (kind) => {
      const e = await accountFileFixture(),
        controller = new AbortController();
      await rm(e.cache, { recursive: true, force: true });
      let current = true;
      e.lookup.mockImplementation(async () => {
        if (kind === "account") current = false;
        else controller.abort();
        return e.job;
      });
      await expect(
        executeDesktopRequest(
          e.config,
          e.request,
          () => {},
          controller.signal,
          { ...e.dependencies, isCurrent: () => current },
        ),
      ).rejects.toMatchObject({
        code: kind === "account" ? "ACCOUNT_CHANGED" : "CANCELLED",
      });
      expect(e.fetcher).not.toHaveBeenCalled();
      expect(e.inference).not.toHaveBeenCalled();
      expect(e.stage).not.toHaveBeenCalled();
      expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
    },
  );
});

async function residentYouTubeFixture() {
  const e = await accountFileFixture();
  const videoId = "abcdefghijk";
  const job = parseJobMetadata({
    ...e.job,
    source_kind: "url",
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
  });
  e.download.mockResolvedValue({
    job,
    download_grant: {
      url: "https://fixture.r2.cloudflarestorage.com/output",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const cached = await executeDesktopRequest(
    e.config,
    {
      protocol_version: 1,
      request_id: randomUUID(),
      type: "LIBRARY_DOWNLOAD",
      session: e.request.session!,
      payload: { job_id: job.id },
    },
    () => {},
    new AbortController().signal,
    e.dependencies,
  );
  e.fetcher.mockClear();
  e.download.mockClear();
  const lookup = vi.spyOn(
    CloudProcessingProvider.prototype,
    "findReusableYouTube",
  );
  const request: DesktopRequest = {
    protocol_version: 1,
    request_id: randomUUID(),
    type: "LOCAL_START",
    session: e.session,
    payload: {
      source_kind: "url",
      youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
  return { ...e, request, cached, lookup };
}

async function restoreQueueFixture() {
  const e = await accountFileFixture();
  const videoId = "abcdefghijk";
  const job = parseJobMetadata({
    ...e.job,
    source_kind: "url",
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
  });
  const lookup = vi
    .spyOn(CloudProcessingProvider.prototype, "findReusableYouTube")
    .mockResolvedValue(job);
  e.download.mockResolvedValue({
    job,
    download_grant: {
      url: "https://fixture.r2.cloudflarestorage.com/output",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const queue = new AccountCacheRestoreQueue(join(e.root, "cache-restores"));
  const ticket = await queue.stage({
    owner: e.owner,
    request_id: randomUUID(),
    video_id: videoId,
    duration_seconds: 5,
  });
  const request: DesktopRequest = {
    protocol_version: 1,
    request_id: randomUUID(),
    type: "SYNC",
    session: e.request.session!,
    payload: {},
  };
  const creation = vi.spyOn(CloudProcessingProvider.prototype, "startYouTube");
  const saves = vi.spyOn(LocalPairSyncClient.prototype, "savePending");
  const complete = vi.spyOn(AccountCacheRestoreQueue.prototype, "complete");
  const cacheKey = accountCacheKey(e.request.session!, job);
  const readReceipt = () =>
    queue.waitForReceipt(
      e.owner,
      ticket.request_id,
      new AbortController().signal,
      () => true,
    );
  return {
    ...e,
    request,
    job,
    lookup,
    queue,
    ticket,
    creation,
    saves,
    complete,
    cacheKey,
    readReceipt,
  };
}

describe("native authenticated cache-restore queue consumer", () => {
  it("keeps the in-flight restore within the foreground deadline even if the wall clock moves backward", async () => {
    const e = await restoreQueueFixture();
    vi.spyOn(Date, "now").mockReturnValue(e.ticket.created_at - 1000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(timeout.mock.calls[0]).toEqual([ACCOUNT_RESTORE_DEADLINE_MS]);
    expect(await e.readReceipt()).toMatchObject({ state: "ready" });
    expect(e.creation).not.toHaveBeenCalled();
  });

  it("restores one ready account result before pair uploads and saves only a private cache receipt", async () => {
    const e = await restoreQueueFixture();
    e.saves.mockImplementation(async () => {
      expect(await e.readReceipt()).toMatchObject({
        state: "ready",
        cache_key: e.cacheKey,
        job_id: e.job.id,
      });
      return [];
    });
    const result = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(result).toMatchObject({
      cache_restore_more_pending: false,
      pending_count: 0,
    });
    expect(e.lookup).toHaveBeenCalledExactlyOnceWith("abcdefghijk", 5);
    expect(e.download).toHaveBeenCalledExactlyOnceWith(e.job.id, {
      video_id: "abcdefghijk",
      duration_seconds: 5,
    });
    expect(e.fetcher).toHaveBeenCalledOnce();
    expect(e.saves).toHaveBeenCalledOnce();
    expect(e.creation).not.toHaveBeenCalled();
    expect(e.inference).not.toHaveBeenCalled();
    expect(e.prepare).not.toHaveBeenCalled();
    expect(e.stage).not.toHaveBeenCalled();
    expect(
      await readFile(
        join(e.config.cache_root, "vocals", e.cacheKey, "vocals.mp3"),
        "utf8",
      ),
    ).toBe("fixture vocal");
    expect(JSON.stringify(await e.readReceipt())).not.toContain(
      "synthetic-fixture-token",
    );
    expect(JSON.stringify(await e.readReceipt())).not.toContain("https:");
  });

  it("consumes one ticket per command and reports another unexpired pending restore", async () => {
    const e = await restoreQueueFixture();
    await e.queue.stage({
      owner: e.owner,
      request_id: randomUUID(),
      video_id: "abcdefghijk",
      duration_seconds: 5,
    });
    const first = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(first.cache_restore_more_pending).toBe(true);
    expect(e.lookup).toHaveBeenCalledOnce();
    const second = await executeDesktopRequest(
      e.config,
      { ...e.request, request_id: randomUUID() },
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(second.cache_restore_more_pending).toBe(false);
    expect(e.lookup).toHaveBeenCalledTimes(2);
    expect(e.fetcher).toHaveBeenCalledOnce();
    expect(e.creation).not.toHaveBeenCalled();
    expect(e.prepare).not.toHaveBeenCalled();
  });

  it.each(["missing", "offline"])(
    "settles %s once without inference, intake or automatic retries",
    async (kind) => {
      const e = await restoreQueueFixture();
      if (kind === "missing") e.lookup.mockResolvedValue(null);
      else
        e.lookup.mockRejectedValue(
          new Error("private fixture restore failure with synthetic token"),
        );
      await executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(await e.readReceipt()).toMatchObject({
        state: kind === "missing" ? "missing" : "deferred",
      });
      await executeDesktopRequest(
        e.config,
        { ...e.request, request_id: randomUUID() },
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(e.lookup).toHaveBeenCalledOnce();
      expect(e.download).not.toHaveBeenCalled();
      expect(e.creation).not.toHaveBeenCalled();
      expect(e.fetcher).not.toHaveBeenCalled();
      expect(e.prepare).not.toHaveBeenCalled();
      expect(
        await readFile(
          join(e.config.logs_root, "desktop", "events.jsonl"),
          "utf8",
        ),
      ).not.toContain("private fixture restore failure");
    },
  );

  it.each(["deadline", "cancel"])(
    "refuses cache/ready publication after %s while the download is in flight",
    async (kind) => {
      const e = await restoreQueueFixture();
      e.fetcher.mockImplementation(async () => {
        if (kind === "deadline")
          vi.spyOn(Date, "now").mockReturnValue(e.ticket.expires_at + 1);
        else await e.queue.cancel(e.owner, e.ticket.request_id);
        return new Response("fixture vocal", {
          headers: { "content-type": "audio/mpeg", "content-length": "13" },
        });
      });
      const result = await executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(result.cache_restore_more_pending).toBe(false);
      expect(
        e.complete.mock.calls.some(([, outcome]) => outcome.state === "ready"),
      ).toBe(false);
      await expect(
        readFile(join(e.config.cache_root, "vocals", e.cacheKey, "vocals.mp3")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(e.fetcher).toHaveBeenCalledOnce();
      expect(e.saves).toHaveBeenCalledOnce();
      expect(e.creation).not.toHaveBeenCalled();
      expect(e.prepare).not.toHaveBeenCalled();
      expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
    },
  );

  it("fences an owner-generation change during a download before cache, receipt or pair uploads", async () => {
    const e = await restoreQueueFixture();
    let current = true;
    e.fetcher.mockImplementation(async () => {
      current = false;
      return new Response("fixture vocal", {
        headers: { "content-type": "audio/mpeg", "content-length": "13" },
      });
    });
    await expect(
      executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        { ...e.dependencies, isCurrent: () => current },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(
      e.complete.mock.calls.some(([, outcome]) => outcome.state === "ready"),
    ).toBe(false);
    await expect(
      readFile(join(e.config.cache_root, "vocals", e.cacheKey, "vocals.mp3")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(e.saves).not.toHaveBeenCalled();
    expect(e.creation).not.toHaveBeenCalled();
    expect(e.prepare).not.toHaveBeenCalled();
  });
});

describe("native resident account YouTube reuse", () => {
  it("prefers fully verified exact local vocals over a resident account copy", async () => {
    const e = await residentYouTubeFixture();
    const { session: _session, ...guest } = e.request;
    const local = await executeDesktopRequest(
      e.config,
      guest,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    e.prepare.mockClear();
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({
      cache_hit: true,
      cache_key: local.cache_key,
      vocal_path: local.vocal_path,
    });
    expect(output.cache_key).not.toBe(e.cached.cache_key);
    expect(e.prepare).not.toHaveBeenCalled();
    expect(e.lookup).not.toHaveBeenCalled();
    expect(e.fetcher).not.toHaveBeenCalled();
  });

  it("plays verified same-owner resident vocals without tokens, account I/O, GPU or pair staging", async () => {
    const e = await residentYouTubeFixture();
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({
      cache_hit: true,
      cache_key: e.cached.cache_key,
      vocal_path: e.cached.vocal_path,
      job_id: e.job.id,
      sync_state: "ready",
    });
    expect(e.lookup).not.toHaveBeenCalled();
    expect(e.download).not.toHaveBeenCalled();
    expect(e.fetcher).not.toHaveBeenCalled();
    expect(e.prepare).not.toHaveBeenCalled();
    expect(e.inspectYouTube).not.toHaveBeenCalled();
    expect(e.stage).not.toHaveBeenCalled();
  });

  it("falls back once to local preparation when validated resident bytes disappear before publication", async () => {
    const e = await residentYouTubeFixture();
    const startCached = JobManager.prototype.startCached;
    vi.spyOn(JobManager.prototype, "startCached").mockImplementation(
      async function (this: JobManager, request, owner, key) {
        await rm(join(e.config.cache_root, "vocals", key), {
          recursive: true,
          force: true,
        });
        return startCached.call(this, request, owner, key);
      },
    );
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({
      cache_hit: false,
      sync_state: "local_only",
    });
    expect(e.prepare).toHaveBeenCalledOnce();
    expect(e.lookup).not.toHaveBeenCalled();
    expect(e.download).not.toHaveBeenCalled();
    expect(e.fetcher).not.toHaveBeenCalled();
  });

  it("fences an owner-generation change between resident lookup and publication", async () => {
    const e = await residentYouTubeFixture();
    let current = true;
    const startCached = JobManager.prototype.startCached;
    vi.spyOn(JobManager.prototype, "startCached").mockImplementation(
      async function (this: JobManager, request, owner, key) {
        current = false;
        return startCached.call(this, request, owner, key);
      },
    );
    await expect(
      executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        { ...e.dependencies, isCurrent: () => current },
      ),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect(e.prepare).not.toHaveBeenCalled();
    expect(e.lookup).not.toHaveBeenCalled();
    expect(e.fetcher).not.toHaveBeenCalled();
    expect(e.stage).not.toHaveBeenCalled();
  });
});

describe("native cloud result titles", () => {
  it("falls back to the source title when an account display name is whitespace", async () => {
    const e = await accountFileFixture();
    const job = parseJobMetadata({
      ...e.job,
      source_title: "Usable source title",
      display_name: "   ",
    });
    e.download.mockResolvedValue({
      job,
      download_grant: {
        url: "https://fixture.r2.cloudflarestorage.com/output",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const output = await executeDesktopRequest(
      e.config,
      {
        protocol_version: 1,
        request_id: randomUUID(),
        type: "LIBRARY_DOWNLOAD",
        session: e.request.session!,
        payload: { job_id: job.id },
      },
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output.source_title).toBe("Usable source title");
  });

  it.each(["CLOUD_START", "LIBRARY_DOWNLOAD"] as const)(
    "returns the account custom name and canonical video identity for %s",
    async (type) => {
      const e = await accountFileFixture();
      const job = parseJobMetadata({
        ...e.job,
        source_kind: "url",
        source_url: "https://www.youtube.com/watch?v=abcdefghijk",
        source_title: "Original title",
        display_name: "Account custom title",
      });
      const remote = {
        job,
        download_grant: {
          url: "https://fixture.r2.cloudflarestorage.com/output",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
      vi.spyOn(
        CloudProcessingProvider.prototype,
        "startYouTube",
      ).mockResolvedValue(remote);
      e.download.mockResolvedValue(remote);
      const request: DesktopRequest =
        type === "CLOUD_START"
          ? {
              protocol_version: 1,
              request_id: randomUUID(),
              type,
              session: e.request.session!,
              payload: { source_kind: "url", youtube_url: job.source_url! },
            }
          : {
              protocol_version: 1,
              request_id: randomUUID(),
              type,
              session: e.request.session!,
              payload: { job_id: job.id },
            };
      const output = await executeDesktopRequest(
        e.config,
        request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(output).toMatchObject({
        source_title: "Account custom title",
        video_id: "abcdefghijk",
        job_id: job.id,
        sync_state: "ready",
      });
      expect(e.inference).not.toHaveBeenCalled();
      expect(e.prepare).not.toHaveBeenCalled();
    },
  );
});

describe("same-owner selected-file warm account saving", () => {
  it.each([false, true])(
    "returns and saves a sanitized retained title with explicit title precedence: %s",
    async (custom) => {
      const e = await warmFileFixture();
      await writeFile(
        e.metadata,
        JSON.stringify({
          ...e.retained,
          source_title: "  Cached\u0000 file title  ",
        }),
        { mode: 0o600 },
      );
      const title = custom ? "My custom mix" : "Cached file title";
      const request: DesktopRequest = {
        ...e.request,
        type: "LOCAL_START",
        payload: {
          source_kind: "file",
          source_path: e.input,
          ...(custom ? { source_title: title } : {}),
        },
      };
      const output = await executeDesktopRequest(
        e.config,
        request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(output).toMatchObject({ source_title: title, cache_hit: true });
      expect((await e.outbox.list(e.owner))[0]?.title).toBe(title);
      expect(e.inference).not.toHaveBeenCalled();
      expect(e.inspectYouTube).not.toHaveBeenCalled();
    },
  );

  it("stages the exact fresh original and cached vocal pair without inference or YouTube capture", async () => {
    const e = await warmFileFixture(),
      output = await executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      ),
      [record] = await e.outbox.list(e.owner);
    expect(output).toMatchObject({
      cache_key: e.key,
      cache_hit: true,
      sync_state: "pending",
    });
    expect(record).toMatchObject({
      owner: e.owner,
      cache_key: e.key,
      original: e.retained.original_declaration,
      vocals: { sha256: e.retained.sha256 },
      state: "pending",
    });
    expect(await readFile(record!.original.path)).toEqual(e.original);
    expect(await readFile(record!.vocals.path, "utf8")).toBe("fixture vocal");
    expect(await readFile(e.input)).toEqual(e.original);
    expect(e.inference).not.toHaveBeenCalled();
    expect(e.prepare).not.toHaveBeenCalled();
    expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
    expect(
      await new LocalSyncCaptureQueue(
        join(e.root, "sync-captures"),
        e.config.cache_root,
      ).list(e.owner),
    ).toEqual([]);
  });

  it.each(["digest", "legacy"])(
    "keeps cached playback while refusing an unverified original declaration: %s",
    async (kind) => {
      const e = await warmFileFixture(),
        retained: Record<string, unknown> = { ...e.retained };
      if (kind === "digest")
        retained.original_declaration = {
          ...e.retained.original_declaration,
          sha256: "a".repeat(64),
        };
      else delete retained.original_declaration;
      await writeFile(e.metadata, JSON.stringify(retained), { mode: 0o600 });
      const output = await executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(output).toMatchObject({
        cache_hit: true,
        sync_state: "unavailable",
      });
      expect(await e.outbox.list(e.owner)).toEqual([]);
      expect(await readFile(e.vocal, "utf8")).toBe("fixture vocal");
      expect(await readFile(e.input)).toEqual(e.original);
      expect(e.inference).not.toHaveBeenCalled();
    },
  );

  it("refuses an inconsistent other-owner file cache without exposing or staging it", async () => {
    const e = await warmFileFixture();
    await writeFile(
      e.metadata,
      JSON.stringify({ ...e.retained, owner_uid: "file-owner-b" }),
      { mode: 0o600 },
    );
    await expect(
      executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      ),
    ).rejects.toThrow("CATALOG_OWNER_MISMATCH");
    expect(await e.outbox.list(e.owner)).toEqual([]);
    expect(await readFile(e.vocal, "utf8")).toBe("fixture vocal");
    expect(await readFile(e.input)).toEqual(e.original);
    expect(e.inference).not.toHaveBeenCalled();
  });

  it("verifies the fresh private snapshot's actual bytes rather than trusting its recorded digest", async () => {
    const e = await warmFileFixture(),
      prepare = fileProvider.prepareDesktopFile;
    const selected = vi
      .spyOn(fileProvider, "prepareDesktopFile")
      .mockImplementation(async (...args) => {
        const snapshot = await prepare(...args);
        await writeFile(
          snapshot.input_path,
          Buffer.alloc(snapshot.bytes, 0x73),
          { mode: 0o600 },
        );
        return snapshot;
      });
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(selected).toHaveBeenCalledOnce();
    expect(output).toMatchObject({
      cache_hit: true,
      sync_state: "unavailable",
    });
    expect(await e.outbox.list(e.owner)).toEqual([]);
    expect(await readFile(e.input)).toEqual(e.original);
    expect(await readFile(e.vocal, "utf8")).toBe("fixture vocal");
    expect(e.inference).not.toHaveBeenCalled();
  });

  it("refuses full pending-original admission while retaining cache playback and the user's selected source", async () => {
    const e = await warmFileFixture();
    vi.spyOn(
      LocalSyncOutbox.prototype,
      "assertAdmission",
    ).mockRejectedValueOnce(new Error("OUTBOX_FULL"));
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({
      cache_hit: true,
      sync_state: "unavailable",
    });
    expect(await e.outbox.list(e.owner)).toEqual([]);
    expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
    expect(await readFile(e.input)).toEqual(e.original);
    expect(e.inference).not.toHaveBeenCalled();
  });

  it("replays an existing pending pair across session generations without duplicate originals", async () => {
    const e = await warmFileFixture();
    await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    const [before] = await e.outbox.list(e.owner),
      output = await executeDesktopRequest(
        e.config,
        {
          ...e.request,
          request_id: randomUUID(),
          session: { ...e.session, session_generation: randomUUID() },
        },
        () => {},
        new AbortController().signal,
        e.dependencies,
      ),
      after = await e.outbox.list(e.owner);
    expect(output).toMatchObject({ cache_hit: true, sync_state: "pending" });
    expect(after).toHaveLength(1);
    expect(after[0]?.request_id).toBe(before!.request_id);
    expect(await readFile(after[0]!.original.path)).toEqual(e.original);
    expect(e.inference).not.toHaveBeenCalled();
  });

  it.each(["account", "cancel"])(
    "fences a warm pair before staging without removing ready vocals or the user's file: %s",
    async (kind) => {
      const e = await warmFileFixture(),
        controller = new AbortController();
      let current = true,
        checks = 0;
      const dependencies = {
        ...e.dependencies,
        isCurrent: () => current,
        verifyCurrent: async () => {
          if (++checks > 1) {
            if (kind === "account") current = false;
            else controller.abort();
          }
          return current;
        },
      };
      await expect(
        executeDesktopRequest(
          e.config,
          e.request,
          () => {},
          controller.signal,
          dependencies,
        ),
      ).rejects.toMatchObject({
        code: kind === "account" ? "ACCOUNT_CHANGED" : "CANCELLED",
      });
      expect(await e.outbox.list(e.owner)).toEqual([]);
      expect(
        await e.outbox.list({
          uid: "file-owner-b",
          session_generation: randomUUID(),
        }),
      ).toEqual([]);
      expect(await readFile(e.vocal, "utf8")).toBe("fixture vocal");
      expect(await readFile(e.input)).toEqual(e.original);
      expect(e.inference).not.toHaveBeenCalled();
    },
  );

  it("retains a bounded exact original and recovery ticket after staging failure, then recovers its same-owner pair", async () => {
    const e = await warmFileFixture();
    vi.spyOn(LocalSyncOutbox.prototype, "stage").mockRejectedValueOnce(
      new Error("OUTBOX_BUSY"),
    );
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({
      cache_hit: true,
      sync_state: "unavailable",
    });
    const jobs = join(e.config.cache_root, "jobs"),
      [id] = await readdir(jobs),
      root = join(jobs, id!);
    expect((await readdir(root)).sort()).toEqual([
      "local-sync-recovery.json",
      "source.wav",
    ]);
    const ticket = JSON.parse(
      await readFile(join(root, "local-sync-recovery.json"), "utf8"),
    );
    expect(ticket).toMatchObject({
      owner: e.owner,
      cache_key: e.key,
      original: e.retained.original_declaration,
    });
    expect(JSON.stringify(ticket)).not.toContain(e.input);
    expect(await readFile(join(root, "source.wav"))).toEqual(e.original);
    expect(await e.outbox.pinnedCacheKeys()).toEqual(new Set([e.key]));
    const replay = await executeDesktopRequest(
      e.config,
      {
        ...e.request,
        request_id: randomUUID(),
        session: { ...e.session, session_generation: randomUUID() },
      },
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(replay).toMatchObject({ cache_hit: true, sync_state: "pending" });
    const [record] = await e.outbox.list({
      ...e.owner,
      session_generation: randomUUID(),
    });
    expect(record).toMatchObject({
      owner: e.owner,
      cache_key: e.key,
      state: "pending",
    });
    expect(await readFile(record!.original.path)).toEqual(e.original);
    expect(await readdir(jobs)).toEqual([]);
    expect(await readFile(e.input)).toEqual(e.original);
    expect(e.inference).not.toHaveBeenCalled();
  });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-desktop-service-"));
  roots.push(root);
  const config: LocalConfig = {
    root,
    cache_root: join(root, "cache"),
    logs_root: join(root, "logs"),
    models_root: join(root, "models"),
    python_path: "/usr/bin/true",
    node_path: process.execPath,
    ffmpeg_path: "/usr/bin/true",
    ffprobe_path: "/usr/bin/true",
    yt_dlp_path: "/usr/bin/true",
    js_runtime_path: process.execPath,
    engine_root: root,
    runner_path: join(root, "runner.py"),
  };
  const prepare = vi
    .fn()
    .mockImplementation(async (_request, work: string, hooks) => {
      hooks.onProgress("local-fixture");
      await mkdir(work, { recursive: true, mode: 0o700 });
      const path = join(work, "vocals.mp3");
      await writeFile(path, "fixture vocal", { mode: 0o600 });
      return {
        output_path: path,
        source_duration_seconds: 5,
        duration_seconds: 5,
        bytes: 13,
        sha256: createHash("sha256").update("fixture vocal").digest("hex"),
        model_id: MODEL_SHA256,
        trim_enabled: false,
        timings_ms: { fixture: 1 },
        source: {
          kind: "youtube",
          video_id: "abcdefghijk",
          format_id: "140",
          audio_track_id: null,
          audio_is_default: null,
          language: null,
        },
      };
    });
  const provider: ProcessingProvider = { id: "LOCAL_MACOS", prepare };
  const request: DesktopRequest = {
    protocol_version: 1,
    request_id: randomUUID(),
    type: "LOCAL_START",
    payload: {
      source_kind: "url",
      youtube_url: "https://www.youtube.com/watch?v=abcdefghijk",
    },
  };
  const inspectYouTube = vi
    .fn()
    .mockResolvedValue({ duration_seconds: 5, source_title: "Fixture" });
  const dependencies = {
    isCurrent: () => true,
    localProvider: provider,
    inspectYouTube,
  };
  return { root, config, prepare, request, dependencies, inspectYouTube };
}
describe("native desktop command integration", () => {
  it("saves a custom local budget without evicting offline vocals and reports it to library and clear", async () => {
    const e = await fixture();
    const key = "e".repeat(64);
    const directory = join(e.config.cache_root, "vocals", key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(join(directory, "vocals.mp3"), "wx", 0o600);
    try {
      await file.truncate(1_500_000_000);
    } finally {
      await file.close();
    }
    await writeFile(join(directory, "result.json"), "{}", { mode: 0o600 });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("UNEXPECTED_NETWORK"));
    const emit = vi.fn();
    const dependencies = { ...e.dependencies, fetcher };
    const execute = (request: DesktopRequest) =>
      executeDesktopRequest(
        e.config,
        request,
        emit,
        new AbortController().signal,
        dependencies,
      );
    expect(
      await execute({
        protocol_version: 1,
        request_id: randomUUID(),
        type: "SET_CACHE_BUDGET",
        payload: { budget_bytes: 1_000_000_000 },
      }),
    ).toEqual({ cache_bytes: 1_500_000_002, budget_bytes: 1_000_000_000 });
    expect(await readOfflineCacheBudget(e.config.cache_root)).toBe(
      1_000_000_000,
    );
    expect((await lstat(join(directory, "vocals.mp3"))).size).toBe(
      1_500_000_000,
    );
    expect(
      await execute({
        protocol_version: 1,
        request_id: randomUUID(),
        type: "LIBRARY_CACHE",
        payload: {},
      }),
    ).toMatchObject({
      cache_bytes: 1_500_000_002,
      budget_bytes: 1_000_000_000,
    });
    expect(
      await execute({
        protocol_version: 1,
        request_id: randomUUID(),
        type: "CLEAR_CACHE",
        payload: {},
      }),
    ).toEqual({
      cache_bytes: 0,
      budget_bytes: 1_000_000_000,
      cleared_entries: 1,
    });
    expect(await readOfflineCacheBudget(e.config.cache_root)).toBe(
      1_000_000_000,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(e.prepare).not.toHaveBeenCalled();
    expect(e.inspectYouTube).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it("fences an aborted settings command before creating or replacing a preference", async () => {
    const e = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeDesktopRequest(
        e.config,
        {
          protocol_version: 1,
          request_id: randomUUID(),
          type: "SET_CACHE_BUDGET",
          payload: { budget_bytes: 5_000_000_000 },
        },
        () => {},
        controller.signal,
        e.dependencies,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await readOfflineCacheBudget(e.config.cache_root)).toBe(
      2_000_000_000,
    );
  });
  it("logs an interrupted-acquisition cooldown before job admission without claiming a bot refusal", async () => {
    const e = await fixture();
    const failure = new LocalProcessingError("ACQUISITION_COOLDOWN", {
      block_reason: "ACQUISITION_INTERRUPTED",
    });
    e.inspectYouTube.mockRejectedValue(failure);
    await expect(
      executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        e.dependencies,
      ),
    ).rejects.toBe(failure);
    expect(e.prepare).not.toHaveBeenCalled();
    const text = await readFile(
      join(e.config.logs_root, "desktop/events.jsonl"),
      "utf8",
    );
    const event = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.code === "ACQUISITION_COOLDOWN");
    expect(event.metrics).toEqual({
      error_origin: "download",
      acquisition_block_reason: "ACQUISITION_INTERRUPTED",
    });
  });
  it.each(["SOURCE_AGE_RESTRICTED", "ACQUISITION_STATE_INVALID"])(
    "logs safe %s acquisition context before a job starts",
    async (code) => {
      const e = await fixture();
      const secondary =
        code === "ACQUISITION_STATE_INVALID"
          ? { refusal_code: "ACQUISITION_RATE_LIMITED" as const }
          : {};
      const failure = new LocalProcessingError(code, {
        stage: "metadata",
        exit_code: 1,
        stderr_kind: "terminal_error",
        stderr_bytes: 123,
        ...secondary,
      });
      Object.assign(failure, {
        stderr: "PRIVATE_STDERR https://private.invalid/?token=PRIVATE_TOKEN",
      });
      e.inspectYouTube.mockRejectedValue(failure);
      await expect(
        executeDesktopRequest(
          e.config,
          e.request,
          () => {},
          new AbortController().signal,
          e.dependencies,
        ),
      ).rejects.toBe(failure);
      expect(e.prepare).not.toHaveBeenCalled();
      const text = await readFile(
        join(e.config.logs_root, "desktop/events.jsonl"),
        "utf8",
      );
      const events = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.find((entry) => entry.code === code)).toMatchObject({
        event: "diagnostic_error",
        request_id: e.request.request_id,
        metrics: {
          error_origin: "download",
          acquisition_stage: "metadata",
          exit_code: 1,
          acquisition_stderr_kind: "terminal_error",
          acquisition_stderr_bytes: 123,
          ...secondary,
        },
      });
      expect(text).not.toContain("PRIVATE_");
      expect(text).not.toContain("private.invalid");
    },
  );

  it.each(["LIBRARY_CACHE", "SYNC", "CLEAR_CACHE"] as const)(
    "%s startup recovers only proven dead job scratch under the shared lease without processing",
    async (type) => {
      const e = await fixture();
      const dead = randomUUID(),
        live = randomUUID(),
        unknown = randomUUID(),
        jobs = join(e.config.cache_root, "jobs"),
        markers = join(e.config.cache_root, "job-workspaces"),
        selected = join(e.root, "selected-original.wav");
      await writeFile(selected, "user-selected original", { mode: 0o600 });
      for (const id of [dead, live, unknown])
        await mkdir(join(jobs, id), { recursive: true, mode: 0o700 });
      await writeFile(join(jobs, dead, "source.m4a.part"), "abandoned source", {
        mode: 0o600,
      });
      await writeFile(join(jobs, dead, "prepared.wav"), "abandoned PCM", {
        mode: 0o600,
      });
      await writeFile(join(jobs, live, "source.m4a"), "active source", {
        mode: 0o600,
      });
      await writeFile(join(jobs, unknown, "foreign.txt"), "unknown user data", {
        mode: 0o600,
      });
      await withCacheMutation(e.config.cache_root, async () => {
        await jobWorkspaces.markJobWorkspace(e.config.cache_root, dead);
        await jobWorkspaces.markJobWorkspace(e.config.cache_root, live);
        const path = join(markers, `${dead}.json`);
        const marker = JSON.parse(await readFile(path, "utf8"));
        // Only this synthetic sidecar is changed to a provably absent PID.
        marker.pid = 2_147_483_647;
        await writeFile(path, JSON.stringify(marker), { mode: 0o600 });
      });
      const recover = jobWorkspaces.recoverJobWorkspaces;
      const recovery = vi
        .spyOn(jobWorkspaces, "recoverJobWorkspaces")
        .mockImplementation(async (cacheRoot) => {
          const lock = JSON.parse(
            await readFile(join(cacheRoot, ".mutation.lock"), "utf8"),
          );
          expect(lock.pid).toBe(process.pid);
          return recover(cacheRoot);
        });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("UNEXPECTED_NETWORK"));
      e.config.app_resources = join(e.root, "public-resources");
      await fixtureToolGuard(e.config, e.root);
      await mkdir(e.config.app_resources, { mode: 0o700 });
      await writeFile(
        join(e.config.app_resources, "desktop-public-config.json"),
        JSON.stringify({ backend_base_url: "https://api.music-mute.com" }),
        { mode: 0o600 },
      );
      const request: DesktopRequest = {
        protocol_version: 1,
        request_id: randomUUID(),
        type,
        ...(type === "SYNC"
          ? {
              session: {
                firebase_uid: "workspace-fixture-owner",
                session_generation: randomUUID(),
                installation_id: randomUUID(),
                id_token: "synthetic-fixture-token",
              },
            }
          : {}),
        payload: {},
      };
      const result = await executeDesktopRequest(
        e.config,
        request,
        () => {},
        new AbortController().signal,
        { ...e.dependencies, fetcher },
      );
      expect(result).toMatchObject(
        type === "SYNC"
          ? { pending_count: 0 }
          : type === "CLEAR_CACHE"
            ? { cleared_entries: 0, cache_bytes: 0 }
            : { total: 0 },
      );
      expect(recovery).toHaveBeenCalledExactlyOnceWith(e.config.cache_root);
      await expect(lstat(join(jobs, dead))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(join(markers, `${dead}.json`))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(jobs, live, "source.m4a"), "utf8")).toBe(
        "active source",
      );
      expect(await readFile(join(jobs, unknown, "foreign.txt"), "utf8")).toBe(
        "unknown user data",
      );
      expect(await readFile(selected, "utf8")).toBe("user-selected original");
      expect((await readdir(jobs)).sort()).toEqual([live, unknown].sort());
      expect(await readdir(markers)).toEqual([`${live}.json`]);
      await expect(
        lstat(join(e.config.cache_root, ".mutation.lock")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(e.prepare).not.toHaveBeenCalled();
      expect(e.inspectYouTube).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("clears only unpinned offline entries and returns bounded cache usage", async () => {
    const e = await fixture(),
      vocalsRoot = join(e.config.cache_root, "vocals"),
      owner = {
        uid: "clear-cache-owner",
        session_generation: randomUUID(),
      },
      session = {
        firebase_uid: owner.uid,
        session_generation: owner.session_generation,
        installation_id: randomUUID(),
      };
    await mkdir(vocalsRoot, { recursive: true, mode: 0o700 });
    const cacheEntry = async (label: string) => {
      const key = createHash("sha256").update(label).digest("hex"),
        root = join(vocalsRoot, key),
        audio = Buffer.from(`vocal-${label}`),
        path = join(root, "vocals.mp3");
      await mkdir(root, { mode: 0o700 });
      await writeFile(path, audio, { mode: 0o600 });
      await writeFile(join(root, "result.json"), "{}", { mode: 0o600 });
      return {
        key,
        root,
        artifact: {
          path,
          extension: "mp3",
          content_type: "audio/mpeg",
          duration_seconds: 5,
          bytes: audio.length,
          sha256: createHash("sha256").update(audio).digest("hex"),
        },
      };
    };
    const outboxEntry = await cacheEntry("outbox-pinned"),
      captureEntry = await cacheEntry("capture-pinned"),
      playbackEntry = await cacheEntry("playback-pinned"),
      evictableEntry = await cacheEntry("evictable"),
      original = Buffer.from("pending account original"),
      originalPath = join(e.config.cache_root, "pending-original.wav");
    await writeFile(originalPath, original, { mode: 0o600 });
    const outbox = new LocalSyncOutbox(
      join(e.root, "sync-outbox"),
      e.config.cache_root,
      { minimum_free_bytes: 0 },
    );
    await outbox.stage({
      owner,
      request_id: randomUUID(),
      cache_key: outboxEntry.key,
      original: {
        path: originalPath,
        extension: "wav",
        content_type: "audio/wav",
        duration_seconds: 5,
        bytes: original.length,
        sha256: createHash("sha256").update(original).digest("hex"),
      },
      vocals: outboxEntry.artifact,
    });
    await new LocalSyncCaptureQueue(
      join(e.root, "sync-captures"),
      e.config.cache_root,
    ).stage({
      owner,
      request_id: randomUUID(),
      cache_key: captureEntry.key,
      video_id: "abcdefghijk",
    });
    await pinPlaybackHandoff(e.config.cache_root, playbackEntry.key);
    const foreign = join(vocalsRoot, "user-data");
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, "keep.txt"), "preserve", { mode: 0o600 });
    const isCurrent = vi.fn(() => true);
    const request: DesktopRequest = {
      protocol_version: 1,
      request_id: randomUUID(),
      type: "CLEAR_CACHE",
      session,
      payload: {},
    };
    const result = await executeDesktopRequest(
      e.config,
      request,
      () => {},
      new AbortController().signal,
      { ...e.dependencies, isCurrent },
    );
    expect(result).toEqual({
      cleared_entries: 1,
      cache_bytes: await offlineCacheBytes(e.config.cache_root),
      budget_bytes: 2_000_000_000,
    });
    expect(Object.keys(result).sort()).toEqual([
      "budget_bytes",
      "cache_bytes",
      "cleared_entries",
    ]);
    expect((await readdir(vocalsRoot)).sort()).toEqual(
      [
        outboxEntry.key,
        captureEntry.key,
        playbackEntry.key,
        "user-data",
      ].sort(),
    );
    await expect(lstat(evictableEntry.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe("preserve");
    expect(isCurrent).toHaveBeenCalledWith(owner);
    const events = (
      await readFile(join(e.config.logs_root, "desktop/events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "cache_evicted",
        request_id: request.request_id,
        metrics: { cache_bytes: result.cache_bytes },
      }),
    );
  });

  it("fails cache clearing closed when a managed entry contains unsafe data", async () => {
    const e = await fixture(),
      vocalsRoot = join(e.config.cache_root, "vocals"),
      safeKey = createHash("sha256").update("safe-entry").digest("hex"),
      unsafeKey = createHash("sha256").update("unsafe-entry").digest("hex");
    for (const key of [safeKey, unsafeKey]) {
      const root = join(vocalsRoot, key);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(join(root, "vocals.mp3"), "voice", { mode: 0o600 });
      await writeFile(join(root, "result.json"), "{}", { mode: 0o600 });
    }
    await writeFile(join(vocalsRoot, unsafeKey, "unknown.bin"), "preserve", {
      mode: 0o600,
    });
    await expect(
      executeDesktopRequest(
        e.config,
        {
          protocol_version: 1,
          request_id: randomUUID(),
          type: "CLEAR_CACHE",
          payload: {},
        },
        () => {},
        new AbortController().signal,
        e.dependencies,
      ),
    ).rejects.toThrow("CACHE_UNSAFE");
    expect(
      await readFile(join(vocalsRoot, safeKey, "vocals.mp3"), "utf8"),
    ).toBe("voice");
    expect(
      await readFile(join(vocalsRoot, unsafeKey, "unknown.bin"), "utf8"),
    ).toBe("preserve");
  });

  it.each([false, true])(
    "retains cold URL title for warm playback and keeps a saved custom title first: %s",
    async (custom) => {
      const e = await fixture();
      const prepare = e.prepare.getMockImplementation()!;
      e.prepare.mockImplementation(async (...args) => ({
        ...(await prepare(...args)),
        source_title: "  Acquired\u0000 title  ",
      }));
      e.inspectYouTube.mockResolvedValue({
        duration_seconds: 5,
        source_title: "Acquired title",
      });
      const coldRequest: DesktopRequest = {
        ...e.request,
        type: "LOCAL_START",
        payload: {
          source_kind: "url",
          youtube_url: "https://www.youtube.com/watch?v=abcdefghijk",
          ...(custom ? { source_title: "My custom title" } : {}),
        },
      };
      const cold = await executeDesktopRequest(
        e.config,
        coldRequest,
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      const title = custom ? "My custom title" : "Acquired title";
      expect(cold).toMatchObject({
        source_title: title,
        video_id: "abcdefghijk",
        cache_hit: false,
      });
      const retained = JSON.parse(
        await readFile(
          join(
            e.config.cache_root,
            "vocals",
            String(cold.cache_key),
            "result.json",
          ),
          "utf8",
        ),
      );
      expect(retained.source_title).toBe("Acquired title");
      e.prepare.mockClear();
      e.inspectYouTube.mockClear();
      const warm = await executeDesktopRequest(
        e.config,
        { ...e.request, request_id: randomUUID() },
        () => {},
        new AbortController().signal,
        e.dependencies,
      );
      expect(warm).toMatchObject({
        source_title: title,
        video_id: "abcdefghijk",
        cache_hit: true,
      });
      expect(e.prepare).not.toHaveBeenCalled();
      expect(e.inspectYouTube).not.toHaveBeenCalled();
      const catalog = new DesktopCatalog(
        join(e.root, "desktop-catalog"),
        e.config.cache_root,
      );
      expect((await catalog.list(undefined)).entries[0]?.source_title).toBe(
        title,
      );
    },
  );

  it("publishes local playback and complete offline metadata with no account calls", async () => {
    const e = await fixture(),
      emit = vi.fn();
    const output = await executeDesktopRequest(
      e.config,
      e.request,
      emit,
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({
      duration_seconds: 5,
      cache_hit: false,
      sync_state: "local_only",
    });
    expect(await readFile(String(output.vocal_path), "utf8")).toBe(
      "fixture vocal",
    );
    expect(
      emit.mock.calls.some(
        ([event]) => event.payload.stage === "local_fixture",
      ),
    ).toBe(true);
    const library = await executeDesktopRequest(
      e.config,
      {
        protocol_version: 1,
        request_id: randomUUID(),
        type: "LIBRARY_CACHE",
        payload: {},
      },
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(library).toMatchObject({
      budget_bytes: 2000000000,
      total: 1,
      items: [
        {
          cache_key: output.cache_key,
          source_duration_seconds: 5,
          trim_enabled: false,
        },
      ],
    });
    expect(library.cache_bytes).toBeGreaterThan(13);
    expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
  });
  it("reuses verified local vocals without metadata acquisition or inference", async () => {
    const e = await fixture();
    await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    const output = await executeDesktopRequest(
      e.config,
      { ...e.request, request_id: randomUUID() },
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output.cache_hit).toBe(true);
    expect(e.prepare).toHaveBeenCalledTimes(1);
    expect(e.inspectYouTube).toHaveBeenCalledTimes(1);
  });
  it("refuses a stale account before any acquisition and propagates cancellation", async () => {
    const e = await fixture();
    await expect(
      executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        new AbortController().signal,
        { ...e.dependencies, isCurrent: () => false },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(e.prepare).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeDesktopRequest(
        e.config,
        e.request,
        () => {},
        controller.signal,
        e.dependencies,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("returns a guest's cached voice immediately and queues its current-owner account save", async () => {
    const e = await fixture();
    const prepare = e.prepare.getMockImplementation()!;
    e.prepare.mockImplementation(async (...args) => {
      const audio = await prepare(...args);
      const original = join(args[1], "source.m4a");
      await writeFile(original, "same", { mode: 0o600 });
      return {
        ...audio,
        original: {
          path: original,
          extension: "m4a",
          content_type: "audio/mp4",
          duration_seconds: 5,
          bytes: 4,
          sha256: createHash("sha256").update("same").digest("hex"),
        },
      };
    });
    await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    const session = {
      firebase_uid: "account-a",
      session_generation: randomUUID(),
      installation_id: randomUUID(),
    };
    const output = await executeDesktopRequest(
      e.config,
      { ...e.request, request_id: randomUUID(), session },
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({ cache_hit: true, sync_state: "pending" });
    expect(e.prepare).toHaveBeenCalledOnce();
    expect(e.inspectYouTube).toHaveBeenCalledOnce();
    const captures = new LocalSyncCaptureQueue(
      join(e.root, "sync-captures"),
      e.config.cache_root,
    );
    expect(
      await captures.list({
        uid: session.firebase_uid,
        session_generation: session.session_generation,
      }),
    ).toMatchObject([
      {
        cache_key: output.cache_key,
        state: "pending",
        owner: { uid: "account-a" },
      },
    ]);
  });
  it("keeps legacy cached playback available without claiming an account save", async () => {
    const e = await fixture();
    await executeDesktopRequest(
      e.config,
      e.request,
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    const output = await executeDesktopRequest(
      e.config,
      {
        ...e.request,
        request_id: randomUUID(),
        session: {
          firebase_uid: "account-a",
          session_generation: randomUUID(),
          installation_id: randomUUID(),
        },
      },
      () => {},
      new AbortController().signal,
      e.dependencies,
    );
    expect(output).toMatchObject({
      cache_hit: true,
      sync_state: "unavailable",
    });
    expect(e.prepare).toHaveBeenCalledOnce();
    expect(await readFile(String(output.vocal_path), "utf8")).toBe(
      "fixture vocal",
    );
  });
});
