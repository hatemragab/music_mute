import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  statfs,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "../src/companion/diagnostics.js";
import {
  JobManager,
  localCacheKey,
  type JobManagerOptions,
} from "../src/companion/jobs.js";
import { offlineCacheBytes } from "../src/companion/cache-budget.js";
import { writeOfflineCacheBudget } from "../src/companion/cache-settings.js";
import { markJobWorkspace } from "../src/companion/job-workspace.js";
import * as processStart from "../src/companion/process-start.js";
import { LocalSyncOutbox } from "../src/companion/sync-outbox.js";
import {
  readPlaybackPins,
  withCacheMutation,
} from "../src/companion/cache-mutator.js";
import { MediaServer } from "../src/companion/media-server.js";
import { accountCacheKey } from "../src/companion/account-cache.js";
import { LocalProcessingError } from "../src/companion/local-provider.js";
import {
  FULL_TIMELINE_RECIPE_DIGEST,
  parseJobMetadata,
} from "../src/companion/cloud-provider.js";
import type { LocalLibraryOwner } from "../src/companion/sync-outbox.js";
import type {
  JobSnapshot,
  PreparedAudio,
  ProcessingProvider,
} from "../src/shared/protocol.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: vi.fn(),
    copyFile: vi.fn(actual.copyFile),
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat),
    readdir: vi.fn(actual.readdir),
    writeFile: vi.fn(actual.writeFile),
  };
});

const disk = {
  type: 0,
  bsize: 4096,
  blocks: 4 * 1024 ** 2,
  bfree: 4 * 1024 ** 2,
  bavail: 4 * 1024 ** 2,
  files: 10_000,
  ffree: 10_000,
};
const roots: string[] = [];
beforeEach(async () => {
  // Admission is exercised without depending on the developer Mac's disk space.
  vi.mocked(statfs).mockReset().mockResolvedValue(disk);
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(copyFile).mockReset().mockImplementation(actual.copyFile);
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(readdir).mockReset().mockImplementation(actual.readdir);
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile);
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const request = {
  video_id: "BaW_jenozKc",
  duration_seconds: 10,
  provider: "LOCAL_MACOS" as const,
};
const model =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
function cacheKey(revision: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        video_id: request.video_id,
        provider: request.provider,
        model,
        revision,
        trim: false,
        source: "default",
      }),
    )
    .digest("hex");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  options: {
    hang?: boolean;
    mismatch?: boolean;
    validatedModel?: string;
    spoofedVerification?: string;
    resultModel?: string;
    managerOptions?: JobManagerOptions;
    original?: boolean;
    providerId?: ProcessingProvider["id"];
    resultDuration?: number;
    sourceTitle?: unknown;
    resultMetadata?: Pick<
      PreparedAudio,
      | "source"
      | "original_declaration"
      | "shared_youtube_profile"
      | "publication_pending"
    >;
    beforeSource?: (workRoot: string) => Promise<void>;
    captureHooks?: (
      hooks: Parameters<ProcessingProvider["prepare"]>[2],
    ) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mm-jobs-"));
  roots.push(root);
  const diagnostics = new Diagnostics(join(root, "logs"));
  const media = new MediaServer(
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  await media.start();
  let calls = 0;
  const snapshots: JobSnapshot[] = [];
  let terminal: ((value: JobSnapshot) => void) | null = null;
  const provider: ProcessingProvider = {
    id: options.providerId ?? "LOCAL_MACOS",
    async prepare(_request, workRoot, hooks) {
      calls++;
      options.captureHooks?.(hooks);
      await options.beforeSource?.(workRoot);
      if (options.hang && !hooks.signal.aborted)
        await new Promise<void>((resolve) => {
          hooks.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      hooks.onProgress("separation", 1, 1);
      const path = join(workRoot, "output.mp3");
      const bytes = Buffer.from("fixture vocals");
      await writeFile(path, bytes, { mode: 0o600 });
      const originalPath = join(workRoot, "source.mp3");
      const originalBytes = Buffer.from("fixture original");
      if (options.original)
        await writeFile(originalPath, originalBytes, { mode: 0o600 });
      if (options.validatedModel)
        hooks.onDiagnostic(
          {
            component: "companion",
            severity: "info",
            event: "local_pipeline_completed",
          },
          options.validatedModel,
        );
      return {
        output_path: path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        model_id: options.resultModel ?? model,
        ...(options.original
          ? {
              original: {
                path: originalPath,
                bytes: originalBytes.length,
                sha256: createHash("sha256")
                  .update(originalBytes)
                  .digest("hex"),
                extension: "mp3",
                content_type: "audio/mpeg",
                duration_seconds: 10,
              },
            }
          : {}),
        ...(options.spoofedVerification
          ? { verified_model_sha256: options.spoofedVerification }
          : {}),
        ...(options.sourceTitle !== undefined
          ? { source_title: options.sourceTitle as string }
          : {}),
        trim_enabled: false,
        duration_seconds: options.mismatch ? 5 : (options.resultDuration ?? 10),
        source_duration_seconds: options.resultDuration ?? 10,
        timings_ms: { separation: 1 },
        ...options.resultMetadata,
      };
    },
  };
  const manager = new JobManager(
    join(root, "cache"),
    provider,
    diagnostics,
    media,
    (snapshot) => {
      snapshots.push(snapshot);
      if (["READY", "FAILED", "CANCELLED"].includes(snapshot.state))
        terminal?.(snapshot);
    },
    options.managerOptions,
  );
  const outcome = () =>
    new Promise<JobSnapshot>((resolve) => {
      terminal = resolve;
    });
  const close = async () => {
    await manager.close();
    await media.close();
    diagnostics.close();
  };
  return {
    root,
    manager,
    media,
    snapshots,
    diagnostics,
    outcome,
    close,
    calls: () => calls,
  };
}
const residentOwner: LocalLibraryOwner = {
  uid: "resident-owner",
  session_generation: "12345678-1234-4123-8123-123456789abc",
};
async function seedResident(env: Awaited<ReturnType<typeof fixture>>) {
  const audio = Buffer.from("resident account vocals");
  const sha256 = createHash("sha256").update(audio).digest("hex");
  const job = parseJobMetadata({
    id: "0123456789abcdef01234567",
    request_id: "87654321-1234-4123-8123-123456789abc",
    status: "ready",
    source_kind: "url",
    source_url: `https://www.youtube.com/watch?v=${request.video_id}`,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    trim_enabled: false,
    can_download_input: true,
    can_download_output: true,
    input: {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: audio.length,
      duration_seconds: request.duration_seconds,
      sha256: Buffer.from(sha256, "hex").toString("base64"),
    },
    output: {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: audio.length,
      duration_seconds: request.duration_seconds,
      sha256: Buffer.from(sha256, "hex").toString("base64"),
    },
    error: null,
  });
  const key = accountCacheKey(
    {
      firebase_uid: residentOwner.uid,
      session_generation: residentOwner.session_generation,
    },
    job,
  );
  const root = join(env.root, "cache", "vocals", key);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "vocals.mp3");
  const metadata = {
    output_path: path,
    duration_seconds: request.duration_seconds,
    source_duration_seconds: request.duration_seconds,
    bytes: audio.length,
    sha256,
    model_id: model,
    trim_enabled: false,
    timings_ms: {},
    owner_uid: residentOwner.uid,
    account_job_id: job.id,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    validation_version: 1,
    source: { kind: "youtube", video_id: request.video_id },
  };
  await writeFile(path, audio, { mode: 0o600 });
  await writeFile(join(root, "result.json"), JSON.stringify(metadata), {
    mode: 0o600,
  });
  return { key, root, path, audio, metadata };
}
describe("resident account cache publication", () => {
  it("refuses cached START invalidated during authoritative admission without preparing or publishing", async () => {
    const entered = deferred(),
      release = deferred(),
      admission = new AbortController();
    const env = await fixture({
      managerOptions: {
        isCurrentOwner: async () => {
          entered.resolve();
          await release.promise;
          return true;
        },
      },
    });
    try {
      const resident = await seedResident(env);
      const start = env.manager.startCached(
        request,
        residentOwner,
        resident.key,
        admission.signal,
      );
      const refusal = expect(start).rejects.toThrow("CANCELLED");
      await entered.promise;
      admission.abort();
      release.resolve();
      await refusal;
      expect(env.manager.busy()).toBe(false);
      expect(env.calls()).toBe(0);
      expect(env.snapshots).toEqual([]);
      expect(await readFile(resident.path)).toEqual(resident.audio);
    } finally {
      release.resolve();
      await env.close();
    }
  });
  it("restores an owner miss outside the cache lease before fresh cache-only publication, including without GPU scratch space", async () => {
    let cacheRoot = "";
    let leaseHeld = false;
    let restoredKey = "";
    const resolver = vi.fn<NonNullable<JobManagerOptions["resolveCached"]>>();
    const env = await fixture({
      managerOptions: {
        isCurrentOwner: () => true,
        resolveCached: resolver,
        withCacheMutation: (operation) =>
          withCacheMutation(cacheRoot, async () => {
            leaseHeld = true;
            try {
              return await operation();
            } finally {
              leaseHeld = false;
            }
          }),
      },
    });
    cacheRoot = join(env.root, "cache");
    resolver.mockImplementation(async (input) => {
      expect(leaseHeld).toBe(false);
      expect(await readdir(cacheRoot)).not.toContain(".mutation.lock");
      expect(input).toMatchObject({
        owner: residentOwner,
        request,
        job_id: env.manager.current()!.job_id,
      });
      expect(input.signal.aborted).toBe(false);
      const restored = await withCacheMutation(cacheRoot, () =>
        seedResident(env),
      );
      restoredKey = restored.key;
      return restored.key;
    });
    try {
      vi.mocked(statfs).mockResolvedValue({ ...disk, bavail: 0 });
      const done = env.outcome();
      await env.manager.start(request, residentOwner);
      expect(await done).toMatchObject({ state: "READY", cache_hit: true });
      expect(resolver).toHaveBeenCalledOnce();
      expect(env.calls()).toBe(0);
      expect(copyFile).not.toHaveBeenCalled();
      expect(statfs).not.toHaveBeenCalled();
      expect(await readdir(join(cacheRoot, "vocals"))).toEqual([restoredKey]);
      expect(await readdir(cacheRoot)).not.toContain("jobs");
    } finally {
      await env.close();
    }
  });
  it("prioritizes verified local replay and performs no account resolution on an existing local hit", async () => {
    const resolver = vi
      .fn<NonNullable<JobManagerOptions["resolveCached"]>>()
      .mockResolvedValue(undefined);
    const env = await fixture({
      managerOptions: { isCurrentOwner: () => true, resolveCached: resolver },
    });
    try {
      let done = env.outcome();
      await env.manager.start(request, residentOwner);
      expect(await done).toMatchObject({ state: "READY", cache_hit: false });
      expect(resolver).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      resolver.mockClear();
      done = env.outcome();
      await env.manager.start(request, residentOwner);
      expect(await done).toMatchObject({ state: "READY", cache_hit: true });
      expect(resolver).not.toHaveBeenCalled();
      expect(env.calls()).toBe(1);
    } finally {
      await env.close();
    }
  });
  it.each(["guest", "file", "online"])(
    "keeps account restoration out of the %s processing path",
    async (scope) => {
      const resolver = vi
        .fn<NonNullable<JobManagerOptions["resolveCached"]>>()
        .mockResolvedValue(undefined);
      const env = await fixture({
        ...(scope === "online" ? { providerId: "ONLINE_MUSICMUTE" } : {}),
        managerOptions: { isCurrentOwner: () => true, resolveCached: resolver },
      });
      try {
        const done = env.outcome();
        await env.manager.start(
          scope === "online"
            ? { ...request, provider: "ONLINE_MUSICMUTE" }
            : request,
          scope === "guest" ? undefined : residentOwner,
          scope === "file" ? "f".repeat(64) : undefined,
        );
        expect(await done).toMatchObject({ state: "READY", cache_hit: false });
        expect(env.calls()).toBe(1);
        expect(resolver).not.toHaveBeenCalled();
      } finally {
        await env.close();
      }
    },
  );
  it.each(["missing", "bad-key", "switched"])(
    "does not infer or retry after a %s resolved account artifact",
    async (condition) => {
      let current = true;
      const resolver = vi.fn<NonNullable<JobManagerOptions["resolveCached"]>>();
      const env = await fixture({
        managerOptions: {
          isCurrentOwner: () => current,
          resolveCached: resolver,
        },
      });
      resolver.mockImplementation(async () => {
        if (condition === "bad-key") return "untrusted-key";
        const cached = await seedResident(env);
        if (condition === "missing") await rm(cached.root, { recursive: true });
        if (condition === "switched") current = false;
        return cached.key;
      });
      try {
        const issue = vi.spyOn(env.media, "issue");
        const done = env.outcome();
        await env.manager.start(request, residentOwner);
        expect(await done).toMatchObject({
          state: "FAILED",
          error_code:
            condition === "missing"
              ? "CACHE_MISS"
              : condition === "bad-key"
                ? "CACHE_UNSAFE"
                : "ACCOUNT_CHANGED",
        });
        expect(resolver).toHaveBeenCalledOnce();
        expect(env.calls()).toBe(0);
        expect(copyFile).not.toHaveBeenCalled();
        expect(issue).not.toHaveBeenCalled();
      } finally {
        await env.close();
      }
    },
  );
  it("publishes account restore while waiting and cancels without starting inference", async () => {
    const entered = deferred();
    const resolver = vi
      .fn<NonNullable<JobManagerOptions["resolveCached"]>>()
      .mockImplementation(async ({ signal }) => {
        entered.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        return undefined;
      });
    const env = await fixture({
      managerOptions: { isCurrentOwner: () => true, resolveCached: resolver },
    });
    try {
      const done = env.outcome();
      const started = await env.manager.start(request, residentOwner);
      await entered.promise;
      expect(env.snapshots.at(-1)).toMatchObject({
        job_id: started.job_id,
        state: "DOWNLOADING",
        stage: "account-restore",
      });
      await env.manager.cancel(started.job_id);
      expect(await done).toMatchObject({
        state: "CANCELLED",
        error_code: "CANCELLED",
      });
      expect(env.calls()).toBe(0);
      expect(copyFile).not.toHaveBeenCalled();
      expect(env.manager.busy()).toBe(false);
    } finally {
      await env.close();
    }
  });
  it("retains the inference disk admission check after account restoration reports no reusable result", async () => {
    const resolver = vi
      .fn<NonNullable<JobManagerOptions["resolveCached"]>>()
      .mockResolvedValue(undefined);
    const env = await fixture({
      managerOptions: { isCurrentOwner: () => true, resolveCached: resolver },
    });
    try {
      vi.mocked(statfs).mockResolvedValue({ ...disk, bavail: 0 });
      const done = env.outcome();
      await env.manager.start(request, residentOwner);
      expect(await done).toMatchObject({
        state: "FAILED",
        error_code: "DISK_SPACE_LOW",
      });
      expect(resolver).toHaveBeenCalledOnce();
      expect(env.calls()).toBe(0);
      expect(copyFile).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }
  });
  it("uses the exact pinned owner artifact under the cache lease with no inference, copy, backfill or metadata rewrite", async () => {
    let cacheRoot = "";
    let key = "";
    const prepared = vi.fn();
    const ready = vi.fn();
    const leaseCall = vi.fn();
    const isCurrent = vi.fn(
      (owner: LocalLibraryOwner) =>
        owner.uid === residentOwner.uid &&
        owner.session_generation === residentOwner.session_generation,
    );
    const env = await fixture({
      managerOptions: {
        isCurrentOwner: isCurrent,
        onPrepared: prepared,
        onReady: ready,
        pinnedCacheKeys: async () => new Set([key]),
        withCacheMutation: (operation) => {
          leaseCall();
          return withCacheMutation(cacheRoot, operation);
        },
      },
    });
    cacheRoot = join(env.root, "cache");
    try {
      const cached = await seedResident(env);
      key = cached.key;
      const manifest = await readFile(join(cached.root, "result.json"));
      const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      await utimes(cached.root, old, old);
      vi.mocked(copyFile).mockClear();
      vi.mocked(statfs).mockResolvedValue({ ...disk, bavail: 0 });
      const done = env.outcome();
      await env.manager.startCached(request, residentOwner, key);
      const result = await done;
      expect(result).toMatchObject({ state: "READY", cache_hit: true });
      expect(env.calls()).toBe(0);
      expect(copyFile).not.toHaveBeenCalled();
      expect(statfs).not.toHaveBeenCalled();
      expect(prepared).not.toHaveBeenCalled();
      expect(leaseCall).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready.mock.calls[0]?.[0]).toMatchObject({
        owner: residentOwner,
        cache_key: key,
        cache_hit: true,
        audio: {
          output_path: cached.path,
          owner_uid: residentOwner.uid,
          account_job_id: cached.metadata.account_job_id,
        },
      });
      const handedOff = ready.mock.calls[0]?.[0].audio;
      for (const field of [
        "source",
        "original",
        "original_declaration",
        "verified_model_sha256",
      ])
        expect(handedOff).not.toHaveProperty(field);
      expect(isCurrent.mock.calls.length).toBeGreaterThan(2);
      expect(await readFile(join(cached.root, "result.json"))).toEqual(
        manifest,
      );
      expect((await lstat(cached.root)).mtimeMs).toBeGreaterThan(old.getTime());
      expect(await readdir(join(cacheRoot, "vocals"))).toEqual([key]);
      expect(await readdir(cacheRoot)).not.toContain("jobs");
      const response = await fetch(result.media!.url, {
        headers: { Range: "bytes=0-7" },
      });
      expect(response.status).toBe(206);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        cached.audio.subarray(0, 8),
      );
    } finally {
      await env.close();
    }
  });
  it.each(["missing", "corrupt", "owner", "hash", "recipe", "trim"])(
    "freshly refuses a %s resident entry without inference, replacement or a media grant",
    async (damage) => {
      const env = await fixture({
        managerOptions: { isCurrentOwner: () => true },
      });
      try {
        const cached = await seedResident(env);
        const metadataPath = join(cached.root, "result.json");
        if (damage === "missing") await rm(cached.root, { recursive: true });
        else if (damage === "corrupt")
          await writeFile(metadataPath, "{interrupted", { mode: 0o600 });
        else if (damage === "hash")
          await writeFile(cached.path, Buffer.alloc(cached.audio.length, 65), {
            mode: 0o600,
          });
        else {
          const metadata = { ...cached.metadata };
          if (damage === "owner") metadata.owner_uid = "another-owner";
          if (damage === "recipe") metadata.recipe_digest = "f".repeat(64);
          if (damage === "trim") metadata.trim_enabled = true;
          await writeFile(metadataPath, JSON.stringify(metadata), {
            mode: 0o600,
          });
        }
        const before =
          damage === "missing" ? null : await readFile(metadataPath);
        const issue = vi.spyOn(env.media, "issue");
        vi.mocked(copyFile).mockClear();
        const done = env.outcome();
        await env.manager.startCached(request, residentOwner, cached.key);
        expect(await done).toMatchObject({
          state: "FAILED",
          error_code: "CACHE_MISS",
        });
        expect(env.calls()).toBe(0);
        expect(copyFile).not.toHaveBeenCalled();
        expect(issue).not.toHaveBeenCalled();
        expect(
          env.snapshots.some((snapshot) => snapshot.state === "READY"),
        ).toBe(false);
        expect(await readdir(join(env.root, "cache"))).not.toContain("jobs");
        if (before) expect(await readFile(metadataPath)).toEqual(before);
      } finally {
        await env.close();
      }
    },
  );
  it("refuses unsafe resident file links while preserving the linked source", async () => {
    const env = await fixture({
      managerOptions: { isCurrentOwner: () => true },
    });
    try {
      const cached = await seedResident(env);
      const outside = join(env.root, "outside.mp3");
      await writeFile(outside, cached.audio, { mode: 0o600 });
      await rm(cached.path);
      await symlink(outside, cached.path);
      const issue = vi.spyOn(env.media, "issue");
      const done = env.outcome();
      await env.manager.startCached(request, residentOwner, cached.key);
      expect(await done).toMatchObject({
        state: "FAILED",
        error_code: "CACHE_UNSAFE",
      });
      expect(issue).not.toHaveBeenCalled();
      expect(env.calls()).toBe(0);
      expect(await readFile(outside)).toEqual(cached.audio);
      expect((await lstat(cached.path)).isSymbolicLink()).toBe(true);
    } finally {
      await env.close();
    }
  });
  it("requires an authoritative current owner before admitting cached playback", async () => {
    const unfenced = await fixture();
    const stale = await fixture({
      managerOptions: { isCurrentOwner: () => false },
    });
    try {
      await expect(
        unfenced.manager.startCached(request, residentOwner, "a".repeat(64)),
      ).rejects.toThrow("CACHE_UNSAFE");
      await expect(
        stale.manager.startCached(request, residentOwner, "a".repeat(64)),
      ).rejects.toThrow("ACCOUNT_CHANGED");
      for (const env of [unfenced, stale]) {
        expect(env.calls()).toBe(0);
        expect(env.snapshots).toEqual([]);
        expect(env.manager.busy()).toBe(false);
        expect(await readdir(env.root)).not.toContain("cache");
      }
    } finally {
      await Promise.all([unfenced.close(), stale.close()]);
    }
  });
  it("fences an account switch after lookup and catalog handoff immediately before issuing media", async () => {
    let current = true;
    const ready = vi.fn(async () => {
      current = false;
    });
    const env = await fixture({
      managerOptions: { isCurrentOwner: () => current, onReady: ready },
    });
    try {
      const cached = await seedResident(env);
      const before = await readFile(join(cached.root, "result.json"));
      const issue = vi.spyOn(env.media, "issue");
      const done = env.outcome();
      await env.manager.startCached(request, residentOwner, cached.key);
      expect(await done).toMatchObject({
        state: "FAILED",
        error_code: "ACCOUNT_CHANGED",
      });
      expect(ready).toHaveBeenCalledOnce();
      expect(issue).not.toHaveBeenCalled();
      expect(env.calls()).toBe(0);
      expect(await readFile(join(cached.root, "result.json"))).toEqual(before);
    } finally {
      await env.close();
    }
  });
  it.each(["ACCOUNT_CHANGED", "CANCELLED"])(
    "preserves a %s account fence from onReady instead of treating it as a catalog warning",
    async (code) => {
      const env = await fixture({
        managerOptions: {
          isCurrentOwner: () => true,
          onReady: async () => {
            throw Object.assign(new Error("safe account fence"), { code });
          },
        },
      });
      try {
        const cached = await seedResident(env);
        const issue = vi.spyOn(env.media, "issue");
        const done = env.outcome();
        await env.manager.startCached(request, residentOwner, cached.key);
        expect(await done).toMatchObject({
          state: code === "CANCELLED" ? "CANCELLED" : "FAILED",
          error_code: code,
        });
        expect(issue).not.toHaveBeenCalled();
        expect(env.calls()).toBe(0);
        expect(
          env.diagnostics
            .snapshot()
            .recent_events.some(
              (event) => event.code === "CATALOG_SAVE_FAILED",
            ),
        ).toBe(false);
      } finally {
        await env.close();
      }
    },
  );
  it.each(["account", "cancel"])(
    "fences %s after asynchronous media protection before READY and revokes the unused capability",
    async (change) => {
      let current = true;
      const entered = deferred(),
        release = deferred();
      const env = await fixture({
        managerOptions: { isCurrentOwner: () => current },
      });
      let granted: string | undefined;
      const issue = env.media.issue.bind(env.media);
      vi.spyOn(env.media, "issue").mockImplementation(async (...args) => {
        granted = await issue(...args);
        entered.resolve();
        await release.promise;
        return granted;
      });
      try {
        const cached = await seedResident(env);
        const done = env.outcome();
        const start = await env.manager.startCached(
          request,
          residentOwner,
          cached.key,
        );
        await entered.promise;
        let cancelled: Promise<void> | undefined;
        if (change === "account") current = false;
        else cancelled = env.manager.cancel(start.job_id);
        release.resolve();
        expect(await done).toMatchObject({
          state: change === "account" ? "FAILED" : "CANCELLED",
          error_code: change === "account" ? "ACCOUNT_CHANGED" : "CANCELLED",
        });
        await cancelled;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(
          env.snapshots.some((snapshot) => snapshot.state === "READY"),
        ).toBe(false);
        expect(granted).toBeDefined();
        expect((await fetch(granted!)).status).toBe(403);
        expect(await readFile(cached.path)).toEqual(cached.audio);
        expect(env.calls()).toBe(0);
      } finally {
        release.resolve();
        await env.close();
      }
    },
  );
  it("cancels a cached result during its final handoff without publishing or removing the saved audio", async () => {
    const entered = deferred(),
      release = deferred();
    const env = await fixture({
      managerOptions: {
        isCurrentOwner: () => true,
        onReady: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    try {
      const cached = await seedResident(env);
      const issue = vi.spyOn(env.media, "issue");
      const done = env.outcome();
      const start = await env.manager.startCached(
        request,
        residentOwner,
        cached.key,
      );
      await entered.promise;
      const cancelled = env.manager.cancel(start.job_id);
      release.resolve();
      await cancelled;
      expect(await done).toMatchObject({
        state: "CANCELLED",
        error_code: "CANCELLED",
      });
      expect(issue).not.toHaveBeenCalled();
      expect(env.calls()).toBe(0);
      expect(await readFile(cached.path)).toEqual(cached.audio);
    } finally {
      release.resolve();
      await env.close();
    }
  });
});
describe("local job ownership and cache", () => {
  it.each([
    { phase: "cache_pin", code: "ENOENT" },
    { phase: "outbox_admission", code: "OUTBOX_BUSY" },
    { phase: "cache_lock", code: "EACCES" },
  ] as const)(
    "identifies the $phase failure before starting the provider",
    async ({ phase, code }) => {
      const failure = Object.assign(
        new Error("PRIVATE_MESSAGE /Users/private/source?token=PRIVATE_TOKEN"),
        { code, path: "/Users/private/source", stack: "PRIVATE_STACK" },
      );
      const fail = async () => {
        throw failure;
      };
      const env = await fixture({
        managerOptions: {
          ...(phase === "cache_pin" ? { pinnedCacheKeys: fail } : {}),
          ...(phase === "outbox_admission" ? { beforePrepare: fail } : {}),
          ...(phase === "cache_lock" ? { withCacheMutation: fail } : {}),
        },
      });
      try {
        const done = env.outcome();
        await env.manager.start(request, residentOwner);
        expect(await done).toMatchObject({ state: "FAILED", error_code: code });
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(env.calls()).toBe(0);
        const event = env.diagnostics
          .snapshot()
          .recent_errors.find((entry) => entry.event === "job_failed");
        expect(event).toMatchObject({
          code,
          metrics: { local_job_phase: phase },
        });
        if (code === "OUTBOX_BUSY")
          expect(event?.metrics).not.toHaveProperty("filesystem_errno");
        else expect(event?.metrics?.filesystem_errno).toBe(code);
        expect(event?.metrics).not.toHaveProperty("error_origin");
        env.diagnostics.close();
        const reader = new Diagnostics(join(env.root, "logs"), {
          readOnly: true,
        });
        try {
          const report = (await reader.export()).report;
          expect(
            report.recent_errors.find((entry) => entry.event === "job_failed"),
          ).toMatchObject({ code, metrics: event?.metrics });
          for (const value of [
            JSON.stringify(report),
            await readFile(join(env.root, "logs/events.jsonl"), "utf8"),
          ]) {
            expect(value).not.toContain("PRIVATE_");
            expect(value).not.toContain("/Users/private");
          }
        } finally {
          reader.close();
        }
      } finally {
        await env.close();
      }
    },
  );
  it("identifies workspace recovery filesystem failures before acquisition", async () => {
    const env = await fixture();
    const markers = join(env.root, "cache/job-workspaces");
    await mkdir(markers, { recursive: true, mode: 0o700 });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(readdir).mockImplementation(async (...args) => {
      if (args[0] === markers)
        throw Object.assign(new Error("PRIVATE_PATH"), { code: "ENOENT" });
      return actual.readdir(...args);
    });
    try {
      const done = env.outcome();
      await env.manager.start(request);
      expect(await done).toMatchObject({
        state: "FAILED",
        error_code: "ENOENT",
      });
      expect(env.calls()).toBe(0);
      expect(
        env.diagnostics
          .snapshot()
          .recent_errors.find((event) => event.event === "job_failed"),
      ).toMatchObject({
        metrics: { local_job_phase: "workspace", filesystem_errno: "ENOENT" },
      });
    } finally {
      await env.close();
    }
  });
  it("separates cache lookup failures from cache lease release failures", async () => {
    const failure = Object.assign(new Error("PRIVATE_CACHE_PATH"), {
      code: "EIO",
    });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    for (const phase of ["cache_lookup", "cache_lock"] as const) {
      const env = await fixture({
        managerOptions: {
          isCurrentOwner: () => true,
          resolveCached: async () => undefined,
          withCacheMutation: async (operation) => {
            const result = await operation();
            if (phase === "cache_lock") throw failure;
            return result;
          },
        },
      });
      if (phase === "cache_lookup")
        vi.mocked(lstat).mockImplementation(async (...args) => {
          if (args[0] === join(env.root, "cache/vocals")) throw failure;
          return actual.lstat(...args);
        });
      try {
        const done = env.outcome();
        await env.manager.start(request, residentOwner);
        expect(await done).toMatchObject({
          state: "FAILED",
          error_code: "EIO",
        });
        expect(env.calls()).toBe(0);
        expect(
          env.diagnostics
            .snapshot()
            .recent_errors.find((event) => event.event === "job_failed"),
        ).toMatchObject({
          metrics: { local_job_phase: phase, filesystem_errno: "EIO" },
        });
      } finally {
        await env.close();
        vi.mocked(lstat).mockImplementation(actual.lstat);
      }
    }
  });
  it("marks output timeline rejection as validation without invented filesystem evidence", async () => {
    const env = await fixture({ mismatch: true });
    try {
      const done = env.outcome();
      await env.manager.start(request);
      expect(await done).toMatchObject({
        state: "FAILED",
        error_code: "TIMELINE_MISMATCH",
      });
      const event = env.diagnostics
        .snapshot()
        .recent_errors.find((entry) => entry.event === "job_failed");
      expect(event?.metrics?.local_job_phase).toBe("validation");
      expect(event?.metrics).not.toHaveProperty("filesystem_errno");
    } finally {
      await env.close();
    }
  });
  it.each(["publication", "playback"] as const)(
    "identifies native $phase failures after successful provider preparation",
    async (phase) => {
      const env = await fixture();
      const failure = Object.assign(new Error("PRIVATE_FILE"), {
        code: "ENOSPC",
      });
      if (phase === "publication")
        vi.mocked(copyFile).mockRejectedValueOnce(failure);
      else vi.spyOn(env.media, "issue").mockRejectedValueOnce(failure);
      try {
        const done = env.outcome();
        await env.manager.start(request);
        expect(await done).toMatchObject({
          state: "FAILED",
          error_code: "ENOSPC",
        });
        expect(env.calls()).toBe(1);
        expect(
          env.diagnostics
            .snapshot()
            .recent_errors.find((event) => event.event === "job_failed"),
        ).toMatchObject({
          metrics: { local_job_phase: phase, filesystem_errno: "ENOSPC" },
        });
      } finally {
        await env.close();
      }
    },
  );
  it.each([
    {
      failure: Object.assign(new Error("PRIVATE_PROVIDER"), { code: "ENOENT" }),
      phase: "provider",
    },
    { failure: new Error("ENOENT"), phase: "cache_pin" },
    {
      failure: Object.assign(new Error("PRIVATE_CODE"), {
        code: "ENOENT /Users/private/source",
      }),
      phase: "cache_pin",
    },
  ] as const)(
    "does not infer filesystem evidence from provider errors or arbitrary text ($phase)",
    async ({ failure, phase }) => {
      const fail = async () => {
        throw failure;
      };
      const env = await fixture(
        phase === "provider"
          ? { beforeSource: fail }
          : { managerOptions: { pinnedCacheKeys: fail } },
      );
      try {
        const done = env.outcome();
        await env.manager.start(request);
        expect(await done).toMatchObject({ state: "FAILED" });
        const event = env.diagnostics
          .snapshot()
          .recent_errors.find((entry) => entry.event === "job_failed");
        expect(event?.metrics?.local_job_phase).toBe(phase);
        expect(event?.metrics).not.toHaveProperty("filesystem_errno");
        expect(event?.metrics).not.toHaveProperty("error_origin");
        expect(
          JSON.stringify((await env.diagnostics.export()).report),
        ).not.toContain("PRIVATE_");
      } finally {
        await env.close();
      }
    },
  );
  it("suppresses preparation details when cancellation races with an errno failure", async () => {
    const entered = deferred(),
      release = deferred();
    const env = await fixture({
      managerOptions: {
        pinnedCacheKeys: async () => {
          entered.resolve();
          await release.promise;
          throw Object.assign(new Error("PRIVATE_CANCELLED_PATH"), {
            code: "ENOENT",
          });
        },
      },
    });
    try {
      const done = env.outcome();
      const started = await env.manager.start(request);
      await entered.promise;
      const cancellation = env.manager.cancel(started.job_id);
      release.resolve();
      await cancellation;
      expect(await done).toMatchObject({
        state: "CANCELLED",
        error_code: "CANCELLED",
      });
      expect(env.calls()).toBe(0);
      const events = (
        await env.diagnostics.export()
      ).report.recent_events.filter((event) => event.event === "job_cancelled");
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.metrics).not.toHaveProperty("local_job_phase");
        expect(event.metrics).not.toHaveProperty("filesystem_errno");
      }
      expect(JSON.stringify(events)).not.toContain("PRIVATE_");
    } finally {
      release.resolve();
      await env.close();
    }
  });
  it("logs an interrupted-acquisition cooldown without inventing upstream evidence", async () => {
    const failure = new LocalProcessingError("ACQUISITION_COOLDOWN", {
      block_reason: "ACQUISITION_INTERRUPTED",
    });
    const env = await fixture({
      beforeSource: async () => {
        throw failure;
      },
    });
    try {
      const done = env.outcome();
      await env.manager.start(request);
      expect(await done).toMatchObject({
        state: "FAILED",
        error_code: "ACQUISITION_COOLDOWN",
      });
      const event = env.diagnostics
        .snapshot()
        .recent_errors.find((entry) => entry.event === "job_failed");
      expect(event?.metrics).toMatchObject({
        error_origin: "download",
        acquisition_block_reason: "ACQUISITION_INTERRUPTED",
      });
      for (const key of [
        "acquisition_stage",
        "exit_code",
        "http_status",
        "refusal_code",
      ])
        expect(event?.metrics).not.toHaveProperty(key);
    } finally {
      await env.close();
    }
  });
  it("plays verified cached vocals while fresh acquisition is in cooldown", async () => {
    let blocked = false;
    const env = await fixture({
      beforeSource: async () => {
        if (blocked) throw new LocalProcessingError("ACQUISITION_COOLDOWN");
      },
    });
    try {
      let done = env.outcome();
      await env.manager.start(request);
      expect(await done).toMatchObject({ state: "READY", cache_hit: false });
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      blocked = true;
      done = env.outcome();
      await env.manager.start(request);
      expect(await done).toMatchObject({ state: "READY", cache_hit: true });
      expect(env.calls()).toBe(1);
    } finally {
      await env.close();
    }
  });
  it.each(["SOURCE_BOT_CHALLENGE", "ACQUISITION_STATE_INVALID"])(
    "records %s acquisition evidence in the terminal job log without private text",
    async (code) => {
      const secondary =
        code === "ACQUISITION_STATE_INVALID"
          ? { refusal_code: "SOURCE_BOT_CHALLENGE" as const }
          : {};
      const failure = new LocalProcessingError(code, {
        stage: "metadata",
        exit_code: 1,
        http_status: 403,
        stderr_kind: "terminal_error",
        stderr_bytes: 123,
        ...secondary,
      });
      Object.assign(failure, {
        stderr: "PRIVATE_STDERR https://private.invalid/?token=PRIVATE_TOKEN",
        cookies: "PRIVATE_COOKIE",
      });
      const env = await fixture({
        beforeSource: async () => {
          throw failure;
        },
      });
      try {
        const done = env.outcome();
        await env.manager.start(request);
        expect(await done).toMatchObject({
          state: "FAILED",
          error_code: code,
        });
        const event = env.diagnostics
          .snapshot()
          .recent_errors.find((entry) => entry.event === "job_failed");
        expect(event).toMatchObject({
          code,
          metrics: {
            local_job_phase: "provider",
            error_origin: "download",
            acquisition_stage: "metadata",
            exit_code: 1,
            http_status: 403,
            acquisition_stderr_kind: "terminal_error",
            acquisition_stderr_bytes: 123,
            ...secondary,
          },
        });
        expect(event?.metrics).not.toHaveProperty("filesystem_errno");
        const exported = await env.diagnostics.export();
        expect(JSON.stringify(exported.report)).not.toContain("PRIVATE_");
        expect(
          await readFile(join(env.root, "logs/events.jsonl"), "utf8"),
        ).not.toContain("private.invalid");
      } finally {
        await env.close();
      }
    },
  );

  it("does not accept acquisition context attached to an ordinary provider exception", async () => {
    const failure = Object.assign(new Error("SOURCE_HTTP_FORBIDDEN"), {
      acquisition_failure: {
        stage: "download",
        exit_code: 1,
        http_status: 403,
      },
    });
    const env = await fixture({
      beforeSource: async () => {
        throw failure;
      },
    });
    try {
      const done = env.outcome();
      await env.manager.start(request);
      expect(await done).toMatchObject({ state: "FAILED" });
      const event = env.diagnostics
        .snapshot()
        .recent_errors.find((entry) => entry.event === "job_failed");
      expect(event?.metrics).not.toHaveProperty("http_status");
      expect(event?.metrics).not.toHaveProperty("acquisition_stage");
    } finally {
      await env.close();
    }
  });

  it("invalidates a READY predecessor while a new START is awaiting revocation and does not admit obsolete work", async () => {
    const env = await fixture();
    const entered = deferred(),
      release = deferred(),
      admission = new AbortController();
    try {
      const readyDone = env.outcome();
      const predecessor = await env.manager.start(request);
      const ready = await readyDone;
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const revoke = env.media.revoke.bind(env.media);
      vi.spyOn(env.media, "revoke").mockImplementationOnce(async () => {
        await revoke();
        entered.resolve();
        await release.promise;
      });
      const start = env.manager.start(
        request,
        undefined,
        undefined,
        admission.signal,
      );
      const refusal = expect(start).rejects.toThrow("CANCELLED");
      await entered.promise;
      admission.abort();
      await env.manager.cancel(predecessor.job_id, "ACCOUNT_CHANGED");
      release.resolve();
      await refusal;
      expect(
        env.snapshots.filter((value) => value.state === "DOWNLOADING"),
      ).toHaveLength(1);
      expect(env.manager.current()).toMatchObject({
        job_id: predecessor.job_id,
        state: "CANCELLED",
      });
      expect(env.manager.busy()).toBe(false);
      expect(env.calls()).toBe(1);
      expect((await fetch(ready.media!.url)).status).toBe(403);
    } finally {
      release.resolve();
      await env.close();
    }
  });
  it("ignores captured provider progress after invalidation and does not replace a successor", async () => {
    let oldHooks: Parameters<ProcessingProvider["prepare"]>[2] | undefined;
    const env = await fixture({
      hang: true,
      captureHooks: (hooks) => {
        oldHooks ??= hooks;
      },
    });
    try {
      const first = await env.manager.start(request);
      await vi.waitFor(() => expect(oldHooks).toBeDefined());
      await env.manager.cancel(first.job_id, "ACCOUNT_CHANGED");
      const successor = await env.manager.start(request);
      const before = env.snapshots.length;
      oldHooks!.onProgress("separation", 1, 1);
      expect(env.snapshots).toHaveLength(before);
      expect(env.manager.current()?.job_id).toBe(successor.job_id);
      await env.manager.cancel(successor.job_id);
    } finally {
      await env.close();
    }
  });
  it("drains in-flight READY invalidation before close can finish teardown", async () => {
    const env = await fixture();
    const release = deferred();
    try {
      const ready = env.outcome();
      const started = await env.manager.start(request);
      await ready;
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const revoke = env.media.revoke.bind(env.media);
      vi.spyOn(env.media, "revoke").mockImplementationOnce(async () => {
        await revoke();
        await release.promise;
      });
      const cancelled = env.manager.cancel(started.job_id, "ACCOUNT_CHANGED");
      let closed = false;
      const closing = env.manager.close().then(() => {
        closed = true;
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(closed).toBe(false);
      release.resolve();
      await Promise.all([cancelled, closing]);
      expect(env.manager.current()?.state).toBe("CANCELLED");
    } finally {
      release.resolve();
      await env.close();
    }
  });
  it.each(["ACCOUNT_CHANGED", "ACCOUNT_STATE_UNSAFE"] as const)(
    "publishes one cancelled snapshot for READY invalidation %s and fences a successor during async revocation",
    async (reason) => {
      const env = await fixture();
      const release = deferred();
      try {
        const readyDone = env.outcome();
        const started = await env.manager.start(request);
        const ready = await readyDone;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const revoke = env.media.revoke.bind(env.media);
        let calls = 0;
        vi.spyOn(env.media, "revoke").mockImplementation(async () => {
          await revoke();
          if (++calls === 1) await release.promise;
        });
        const cancelled = env.manager.cancel(started.job_id, reason);
        const duplicate = env.manager.cancel(started.job_id, reason);
        expect(env.manager.busy()).toBe(true);
        await expect(env.manager.start(request)).rejects.toThrow(
          "LOCAL_COMPANION_BUSY",
        );
        await expect(env.manager.clearCache()).rejects.toThrow(
          "LOCAL_COMPANION_BUSY",
        );
        await vi.waitFor(() => expect(calls).toBe(1));
        expect((await fetch(ready.media!.url)).status).toBe(403);
        release.resolve();
        await Promise.all([cancelled, duplicate]);
        expect(calls).toBe(2);
        expect(env.manager.busy()).toBe(false);
        expect(
          env.snapshots.filter((value) => value.state === "CANCELLED"),
        ).toEqual([
          expect.objectContaining({
            job_id: started.job_id,
            state: "CANCELLED",
            stage: "cancelled",
          }),
        ]);
        expect(env.manager.current()?.media).toBeUndefined();
        const events = env.diagnostics
          .snapshot()
          .recent_events.filter((event) => event.event === "job_cancelled");
        expect(events).toHaveLength(1);
        expect(events[0]?.code).toBe(reason);
        const successorDone = env.outcome();
        const successor = await env.manager.start(request);
        const successorReady = await successorDone;
        await expect(
          env.manager.cancel(started.job_id, reason),
        ).rejects.toThrow("STALE_JOB");
        expect((await fetch(successorReady.media!.url)).status).toBe(200);
        expect(env.manager.current()?.job_id).toBe(successor.job_id);
        expect(env.calls()).toBe(1);
      } finally {
        release.resolve();
        await env.close();
      }
    },
  );
  it.each(["ACCOUNT_CHANGED", "ACCOUNT_STATE_UNSAFE"] as const)(
    "aborts in-progress work for %s without a late READY or a second cancellation",
    async (reason) => {
      const env = await fixture({ hang: true });
      try {
        const terminal = env.outcome();
        const started = await env.manager.start(request);
        await vi.waitFor(() => expect(env.calls()).toBe(1));
        await Promise.all([
          env.manager.cancel(started.job_id, reason),
          env.manager.cancel(started.job_id, reason),
        ]);
        expect(await terminal).toMatchObject({
          state: "CANCELLED",
          error_code: reason,
        });
        expect(
          env.snapshots.filter((value) => value.state === "CANCELLED"),
        ).toHaveLength(1);
        expect(env.snapshots.some((value) => value.state === "READY")).toBe(
          false,
        );
        expect(await readdir(join(env.root, "cache/jobs"))).toEqual([]);
        expect(env.manager.busy()).toBe(false);
      } finally {
        await env.close();
      }
    },
  );
  it.each(["preflight", "revoke"])(
    "fences an invalidated START admission while awaiting %s before publishing or preparing",
    async (stage) => {
      const env = await fixture();
      const entered = deferred(),
        release = deferred(),
        admission = new AbortController();
      if (stage === "preflight")
        vi.mocked(statfs).mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return disk;
        });
      else {
        const revoke = env.media.revoke.bind(env.media);
        vi.spyOn(env.media, "revoke").mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          await revoke();
        });
      }
      try {
        const start = env.manager.start(
          request,
          undefined,
          undefined,
          admission.signal,
        );
        const refusal = expect(start).rejects.toThrow("CANCELLED");
        await entered.promise;
        admission.abort();
        expect(env.manager.busy()).toBe(true);
        release.resolve();
        await refusal;
        expect(env.calls()).toBe(0);
        expect(env.snapshots).toEqual([]);
        expect(env.manager.busy()).toBe(false);
      } finally {
        release.resolve();
        await env.close();
      }
    },
  );
  it("recovers dead owned scratch under the shared lease and marks before source bytes without disturbing engine layout", async () => {
    let root = "";
    const env = await fixture({
      managerOptions: {
        withCacheMutation: (operation) =>
          withCacheMutation(join(root, "cache"), operation),
      },
      beforeSource: async (workRoot) => {
        expect(await readdir(workRoot)).toEqual([]);
        const jobId = workRoot.split("/").at(-1)!;
        expect(
          JSON.parse(
            await readFile(
              join(root, "cache/job-workspaces", `${jobId}.json`),
              "utf8",
            ),
          ),
        ).toMatchObject({ version: 1, job_id: jobId, pid: process.pid });
        expect(await lstat(join(root, "cache/.mutation.lock"))).toBeDefined();
        expect(await readdir(join(root, "cache/jobs"))).toEqual([jobId]);
      },
    });
    root = env.root;
    try {
      const staleId = "87654321-1234-4123-8123-123456789abc";
      const stale = join(root, "cache/jobs", staleId);
      await mkdir(stale, { recursive: true, mode: 0o700 });
      await markJobWorkspace(join(root, "cache"), staleId);
      const marker = join(root, "cache/job-workspaces", `${staleId}.json`);
      const record = JSON.parse(await readFile(marker, "utf8"));
      await writeFile(
        marker,
        JSON.stringify({ ...record, pid: 2_147_483_647 }),
        { mode: 0o600 },
      );
      await writeFile(join(stale, "source.mp3"), "abandoned app source", {
        mode: 0o600,
      });
      const done = env.outcome();
      await env.manager.start(request);
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(env.calls()).toBe(1);
      expect(await readdir(join(root, "cache/jobs"))).toEqual([]);
      expect(await readdir(join(root, "cache/job-workspaces"))).toEqual([]);
    } finally {
      await env.close();
    }
  });
  it("requires process ownership before cold acquisition while valid warm playback requires no ownership query", async () => {
    const env = await fixture();
    const identity = vi.spyOn(processStart, "processStartIdentity");
    try {
      identity.mockRejectedValue(new Error("PROCESS_IDENTITY_UNAVAILABLE"));
      let done = env.outcome();
      await env.manager.start(request);
      expect(await done).toMatchObject({
        state: "FAILED",
        error_code: "PROCESS_IDENTITY_UNAVAILABLE",
      });
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(env.calls()).toBe(0);
      expect(await readdir(join(env.root, "cache/jobs"))).toEqual([]);
      identity.mockRestore();
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const warmIdentity = vi
        .spyOn(processStart, "processStartIdentity")
        .mockRejectedValue(new Error("PROCESS_IDENTITY_UNAVAILABLE"));
      try {
        done = env.outcome();
        await env.manager.start(request);
        expect(await done).toMatchObject({ state: "READY", cache_hit: true });
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(warmIdentity).not.toHaveBeenCalled();
        expect(env.calls()).toBe(1);
      } finally {
        warmIdentity.mockRestore();
      }
    } finally {
      identity.mockRestore();
      await env.close();
    }
  });
  it("retains bounded native title metadata across cold and warm playback without changing cache identity or leaking it to the page", async () => {
    const ready = vi.fn(),
      prepared = vi.fn();
    const env = await fixture({
      sourceTitle: "  Private display\0 title\n  ",
      original: true,
      validatedModel: model,
      managerOptions: { onReady: ready, onPrepared: prepared },
    });
    const owner = {
      uid: "title-owner",
      session_generation: "12345678-1234-4123-8123-123456789abc",
    };
    try {
      let done = env.outcome();
      await env.manager.start(request, owner);
      expect(await done).toMatchObject({ state: "READY", cache_hit: false });
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const path = join(env.root, "cache/vocals", cacheKey(8), "result.json");
      const before = await readFile(path);
      const retained = JSON.parse(before.toString("utf8"));
      expect(retained.source_title).toBe("Private display title");
      expect(retained.original_declaration).toBeDefined();
      expect(retained.verified_model_sha256).toBe(model);
      expect(prepared).toHaveBeenCalledOnce();
      expect(prepared.mock.calls[0]?.[0].audio.source_title).toBe(
        "Private display title",
      );
      expect((await env.manager.peekCache(request))?.source_title).toBe(
        "Private display title",
      );
      done = env.outcome();
      await env.manager.start(request, owner);
      expect(await done).toMatchObject({ state: "READY", cache_hit: true });
      expect(env.calls()).toBe(1);
      expect(ready.mock.calls.map(([item]) => item.audio.source_title)).toEqual(
        ["Private display title", "Private display title"],
      );
      expect(prepared).toHaveBeenCalledOnce();
      expect(await readFile(path)).toEqual(before);
      expect(await readdir(join(env.root, "cache/vocals"))).toEqual([
        cacheKey(8),
      ]);
      expect(JSON.stringify(env.snapshots)).not.toContain(
        "Private display title",
      );
      expect(JSON.stringify(env.diagnostics.snapshot())).not.toContain(
        "Private display title",
      );
    } finally {
      await env.close();
    }
  });
  it.each([
    [null, undefined],
    [17, undefined],
    [{ malformed: true }, undefined],
    ["\0 \n\t", undefined],
    ["  Replay\0 title\n  ", "Replay title"],
    ["x".repeat(400), "x".repeat(300)],
    ["x".repeat(299) + "🙂", "x".repeat(299)],
    ["\ud800 Replay\udc00", "Replay"],
  ])(
    "reuses valid cached audio independently of optional title %j without rewriting metadata",
    async (title, expected) => {
      const ready = vi.fn();
      const env = await fixture({ managerOptions: { onReady: ready } });
      try {
        let done = env.outcome();
        await env.manager.start(request);
        await done;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const path = join(env.root, "cache/vocals", cacheKey(8), "result.json");
        const metadata = JSON.parse(await readFile(path, "utf8"));
        metadata.source_title = title;
        await writeFile(path, JSON.stringify(metadata), { mode: 0o600 });
        const before = await readFile(path);
        expect((await env.manager.peekCache(request))?.source_title).toBe(
          expected,
        );
        done = env.outcome();
        await env.manager.start(request);
        expect(await done).toMatchObject({ state: "READY", cache_hit: true });
        expect(env.calls()).toBe(1);
        expect(ready.mock.calls[1]?.[0].audio.source_title).toBe(expected);
        expect(await readFile(path)).toEqual(before);
      } finally {
        await env.close();
      }
    },
  );
  it("peeks through the shared lease without inference, publication or recency mutation", async () => {
    let cacheRoot = "";
    const leaseCall = vi.fn();
    const lease: NonNullable<JobManagerOptions["withCacheMutation"]> = (
      operation,
    ) => {
      leaseCall();
      return withCacheMutation(cacheRoot, operation);
    };
    const ready = vi.fn();
    const env = await fixture({
      validatedModel: model,
      managerOptions: { withCacheMutation: lease, onReady: ready },
    });
    cacheRoot = join(env.root, "cache");
    const owner = {
      uid: "peek-owner",
      session_generation: "12345678-1234-4123-8123-123456789abc",
    };
    try {
      expect(await env.manager.peekCache(request)).toBeNull();
      expect(leaseCall).not.toHaveBeenCalled();
      expect(await readdir(env.root)).not.toContain("cache");
      expect(env.calls()).toBe(0);
      expect(env.manager.current()).toBeNull();
      const done = env.outcome();
      await env.manager.start(request, owner);
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const cache = join(cacheRoot, "vocals", cacheKey(8));
      const before = await readFile(join(cache, "result.json"));
      const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      await utimes(cache, old, old);
      const updated = (await lstat(cache)).mtimeMs;
      const current = env.manager.current();
      const snapshots = env.snapshots.length;
      const peeked = await env.manager.peekCache(request);
      expect(peeked).toMatchObject({
        owner_uid: owner.uid,
        model_id: model,
        verified_model_sha256: model,
        trim_enabled: false,
        output_path: join(cache, "vocals.mp3"),
      });
      expect(leaseCall).toHaveBeenCalledTimes(2);
      expect(env.calls()).toBe(1);
      expect(ready).toHaveBeenCalledOnce();
      expect(env.manager.current()).toEqual(current);
      expect(env.snapshots).toHaveLength(snapshots);
      expect((await lstat(cache)).mtimeMs).toBe(updated);
      expect(await readFile(join(cache, "result.json"))).toEqual(before);
      expect(await readdir(cacheRoot)).not.toContain(".mutation.lock");
      await expect(
        env.manager.peekCache(request, "bad-source"),
      ).rejects.toThrow("SOURCE_IDENTITY_INVALID");
      expect(await env.manager.peekCache(request, "f".repeat(64))).toBeNull();
    } finally {
      await env.close();
    }
  });
  it.each(["hash", "model", "owner"])(
    "refuses a cached %s mismatch during read-only lookup",
    async (damage) => {
      const env = await fixture();
      try {
        const done = env.outcome();
        await env.manager.start(request);
        await done;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const cache = join(env.root, "cache/vocals", cacheKey(8));
        const path = join(cache, "result.json");
        const metadata = JSON.parse(await readFile(path, "utf8"));
        if (damage === "hash")
          await writeFile(
            join(cache, "vocals.mp3"),
            Buffer.alloc(metadata.bytes, 65),
            { mode: 0o600 },
          );
        else {
          if (damage === "model") metadata.model_id = "f".repeat(64);
          else metadata.owner_uid = { uid: "untrusted-owner" };
          await writeFile(path, JSON.stringify(metadata), { mode: 0o600 });
        }
        const before = await readFile(path);
        expect(await env.manager.peekCache(request)).toBeNull();
        expect(env.calls()).toBe(1);
        expect(await readFile(path)).toEqual(before);
      } finally {
        await env.close();
      }
    },
  );
  it("does not upgrade legacy or mismatched verification provenance during lookup", async () => {
    const env = await fixture();
    try {
      const done = env.outcome();
      await env.manager.start(request);
      await done;
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(await env.manager.peekCache(request)).not.toHaveProperty(
        "verified_model_sha256",
      );
      const path = join(env.root, "cache/vocals", cacheKey(8), "result.json");
      const metadata = JSON.parse(await readFile(path, "utf8"));
      metadata.verified_model_sha256 = "f".repeat(64);
      await writeFile(path, JSON.stringify(metadata), { mode: 0o600 });
      const before = await readFile(path);
      expect(await env.manager.peekCache(request)).not.toHaveProperty(
        "verified_model_sha256",
      );
      expect(await readFile(path)).toEqual(before);
      expect(env.calls()).toBe(1);
    } finally {
      await env.close();
    }
  });
  it("does not race a read-only lookup against an active processing operation", async () => {
    const env = await fixture({ hang: true });
    try {
      await env.manager.start(request);
      await expect(env.manager.peekCache(request)).rejects.toThrow(
        "LOCAL_COMPANION_BUSY",
      );
    } finally {
      await env.close();
    }
  });
  it("allows an explicit native cloud duration up to thirty minutes while preserving the browser and local limits", async () => {
    const cloud = await fixture({
      providerId: "ONLINE_MUSICMUTE",
      resultDuration: 1800,
      managerOptions: { max_duration_seconds: 1800 },
    });
    const unchanged = await fixture({ providerId: "ONLINE_MUSICMUTE" });
    const wrongLocal = await fixture({
      managerOptions: { max_duration_seconds: 1800 },
    });
    const invalid = await fixture({
      providerId: "ONLINE_MUSICMUTE",
      managerOptions: { max_duration_seconds: 1801 },
    });
    try {
      let done = cloud.outcome();
      await cloud.manager.start({
        ...request,
        provider: "ONLINE_MUSICMUTE",
        duration_seconds: 1800,
      });
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(cloud.manager.busy()).toBe(false));
      done = cloud.outcome();
      await cloud.manager.start({
        ...request,
        provider: "ONLINE_MUSICMUTE",
        duration_seconds: 1800,
      });
      expect((await done).cache_hit).toBe(true);
      await vi.waitFor(() => expect(cloud.manager.busy()).toBe(false));
      await expect(
        cloud.manager.start({
          ...request,
          provider: "ONLINE_MUSICMUTE",
          duration_seconds: 1801,
        }),
      ).rejects.toThrow("UNSUPPORTED_VIDEO");
      await expect(
        unchanged.manager.start({
          ...request,
          provider: "ONLINE_MUSICMUTE",
          duration_seconds: 1201,
        }),
      ).rejects.toThrow("UNSUPPORTED_VIDEO");
      await expect(wrongLocal.manager.start(request)).rejects.toThrow(
        "PROVIDER_LIMIT_INVALID",
      );
      await expect(
        invalid.manager.start({ ...request, provider: "ONLINE_MUSICMUTE" }),
      ).rejects.toThrow("PROVIDER_LIMIT_INVALID");
    } finally {
      await Promise.all([
        cloud.close(),
        unchanged.close(),
        wrongLocal.close(),
        invalid.close(),
      ]);
    }
  });
  it("calls the native catalog handoff for both cold and warm results including guest playback", async () => {
    const ready = vi.fn();
    const env = await fixture({ managerOptions: { onReady: ready } });
    try {
      for (const cached of [false, true]) {
        const done = env.outcome();
        await env.manager.start(request);
        expect((await done).cache_hit).toBe(cached);
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      }
      expect(ready).toHaveBeenCalledTimes(2);
      expect(ready.mock.calls[0]?.[0]).toMatchObject({
        cache_hit: false,
        cache_key: cacheKey(8),
      });
      expect(ready.mock.calls[1]?.[0]).toMatchObject({
        cache_hit: true,
        cache_key: cacheKey(8),
      });
      expect(ready.mock.calls[0]?.[0]).not.toHaveProperty("owner");
    } finally {
      await env.close();
    }
  });
  it("keeps local playback usable if native catalog persistence fails", async () => {
    const env = await fixture({
      managerOptions: {
        onReady: async () => {
          throw new Error("private file path unavailable");
        },
      },
    });
    try {
      const done = env.outcome();
      await env.manager.start(request);
      const ready = await done;
      expect(ready.state).toBe("READY");
      expect((await fetch(ready.media!.url)).status).toBe(200);
      expect(
        env.diagnostics
          .snapshot()
          .recent_events.some(
            (event) =>
              event.event === "diagnostic_error" &&
              event.severity === "warning",
          ),
      ).toBe(true);
    } finally {
      await env.close();
    }
  });
  it("does not require inference scratch space to replay already verified offline vocals", async () => {
    const env = await fixture();
    try {
      let done = env.outcome();
      await env.manager.start(request);
      await done;
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      vi.mocked(statfs).mockResolvedValue({ ...disk, bavail: 0 });
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(true);
      expect(env.calls()).toBe(1);
    } finally {
      await env.close();
    }
  });
  it("reports a shared cache ownership conflict without inference or leftover media and fences clear operations", async () => {
    const env = await fixture({
      managerOptions: {
        withCacheMutation: async () => {
          throw new Error("LOCAL_COMPANION_BUSY");
        },
      },
    });
    try {
      const done = env.outcome();
      await env.manager.start(request);
      expect((await done).error_code).toBe("LOCAL_COMPANION_BUSY");
      expect(env.calls()).toBe(0);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      await expect(env.manager.clearCache()).rejects.toThrow(
        "LOCAL_COMPANION_BUSY",
      );
    } finally {
      await env.close();
    }
  });
  it("retains old vocals and refreshes access recency instead of expiring reusable audio after seven days", async () => {
    const env = await fixture();
    try {
      let done = env.outcome();
      await env.manager.start(request);
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const root = join(env.root, "cache/vocals", cacheKey(8));
      const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      await utimes(root, old, old);
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(true);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(env.calls()).toBe(1);
      expect((await lstat(root)).mtimeMs).toBeGreaterThan(old.getTime());
    } finally {
      await env.close();
    }
  });
  it("a resident manager uses the default2GB budget and observes a saved reduction on its next cached start", async () => {
    const env = await fixture();
    try {
      let done = env.outcome();
      await env.manager.start(request);
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const cacheRoot = join(env.root, "cache");
      const key = "c".repeat(64);
      const root = join(cacheRoot, "vocals", key);
      await mkdir(root, { mode: 0o700 });
      const file = await open(join(root, "vocals.mp3"), "wx", 0o600);
      try {
        await file.truncate(1_500_000_000);
      } finally {
        await file.close();
      }
      await writeFile(join(root, "result.json"), "{}", { mode: 0o600 });
      await utimes(root, 1, 1);
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(true);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect((await lstat(join(root, "vocals.mp3"))).size).toBe(1_500_000_000);
      await withCacheMutation(cacheRoot, () =>
        writeOfflineCacheBudget(cacheRoot, 1_000_000_000),
      );
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(true);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(env.calls()).toBe(1);
    } finally {
      await env.close();
    }
  });
  it("evicts the least recently used entry within the shared budget and preserves pinned pending uploads on clear", async () => {
    const pinned = new Set<string>();
    const options: JobManagerOptions = { pinnedCacheKeys: async () => pinned };
    const env = await fixture({ managerOptions: options });
    try {
      let done = env.outcome();
      await env.manager.start(request);
      await done;
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const active = join(env.root, "cache/vocals", cacheKey(8));
      const activeBytes =
        (await lstat(join(active, "vocals.mp3"))).size +
        (await lstat(join(active, "result.json"))).size;
      for (const [key, age] of [
        ["a".repeat(64), 30],
        ["b".repeat(64), 20],
      ] as const) {
        const root = join(env.root, "cache/vocals", key);
        await mkdir(root, { mode: 0o700 });
        await writeFile(join(root, "vocals.mp3"), "x".repeat(100), {
          mode: 0o600,
        });
        await writeFile(join(root, "result.json"), "{}", { mode: 0o600 });
        const timestamp = new Date(Date.now() - age * 1000);
        await utimes(root, timestamp, timestamp);
      }
      options.offline_bytes_limit = activeBytes + 102;
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(true);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(await readdir(join(env.root, "cache/vocals"))).toEqual(
        expect.arrayContaining([cacheKey(8), "b".repeat(64)]),
      );
      await expect(
        lstat(join(env.root, "cache/vocals", "a".repeat(64))),
      ).rejects.toMatchObject({ code: "ENOENT" });
      pinned.add(cacheKey(8));
      await env.manager.clearCache();
      expect(await readFile(join(active, "vocals.mp3"), "utf8")).toBe(
        "fixture vocals",
      );
      expect(await readdir(join(env.root, "cache/vocals"))).toEqual([
        cacheKey(8),
      ]);
      options.offline_bytes_limit = activeBytes - 1;
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).error_code).toBe("OFFLINE_CACHE_FULL");
      expect(await readFile(join(active, "vocals.mp3"), "utf8")).toBe(
        "fixture vocals",
      );
    } finally {
      await env.close();
    }
  });
  it.each([-1, 0])(
    "accounts for the final manifest bytes before publication with a pinned entry and %i bytes of budget margin",
    async (margin) => {
      const pinned = new Set<string>();
      const options: JobManagerOptions = {
        pinnedCacheKeys: async () => pinned,
      };
      const env = await fixture({
        managerOptions: options,
        validatedModel: model,
        sourceTitle: "Budget voice • épisode 🙂",
      });
      try {
        let done = env.outcome();
        await env.manager.start(request);
        expect((await done).state).toBe("READY");
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const cacheRoot = join(env.root, "cache");
        const firstKey = localCacheKey(request);
        const firstRoot = join(cacheRoot, "vocals", firstKey);
        const vocal = await readFile(join(firstRoot, "vocals.mp3"));
        const manifest = await readFile(join(firstRoot, "result.json"));
        const entryBytes = vocal.length + manifest.length;
        expect(await offlineCacheBytes(cacheRoot)).toBe(entryBytes);
        pinned.add(firstKey);
        options.offline_bytes_limit = entryBytes * 2 + margin;
        vi.mocked(copyFile).mockClear();
        const issue = vi.spyOn(env.media, "issue");
        const sourceDigest = "b".repeat(64);
        const secondRoot = join(
          cacheRoot,
          "vocals",
          localCacheKey(request, sourceDigest),
        );
        done = env.outcome();
        await env.manager.start(request, undefined, sourceDigest);
        const result = await done;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(env.calls()).toBe(2);
        expect(await readFile(join(firstRoot, "vocals.mp3"))).toEqual(vocal);
        expect(await readFile(join(firstRoot, "result.json"))).toEqual(
          manifest,
        );
        if (margin < 0) {
          expect(result).toMatchObject({
            state: "FAILED",
            error_code: "OFFLINE_CACHE_FULL",
          });
          expect(copyFile).not.toHaveBeenCalled();
          expect(issue).not.toHaveBeenCalled();
          expect(await readdir(secondRoot)).toEqual([]);
          expect(await offlineCacheBytes(cacheRoot)).toBe(entryBytes);
        } else {
          expect(result).toMatchObject({ state: "READY", cache_hit: false });
          expect(await readFile(join(secondRoot, "vocals.mp3"))).toEqual(vocal);
          expect((await readFile(join(secondRoot, "result.json"))).length).toBe(
            manifest.length,
          );
          expect(await offlineCacheBytes(cacheRoot)).toBe(
            options.offline_bytes_limit,
          );
          expect(issue).toHaveBeenCalledOnce();
        }
        expect(await readdir(join(cacheRoot, "jobs"))).toEqual([]);
      } finally {
        await env.close();
      }
    },
  );
  it("stages the captured account's actual original before workspace cleanup and avoids automatic backfill on cache hits", async () => {
    const account = {
      uid: "firebase-owner-a",
      session_generation: "12345678-1234-4123-8123-123456789abc",
    };
    const staged = vi.fn();
    let outbox: LocalSyncOutbox;
    const env = await fixture({
      original: true,
      managerOptions: {
        onPrepared: async (prepared) => {
          staged(prepared.owner);
          await outbox.stage({
            owner: prepared.owner,
            request_id: prepared.request_id,
            cache_key: prepared.cache_key,
            original: prepared.audio.original!,
            vocals: {
              path: prepared.audio.output_path,
              bytes: prepared.audio.bytes,
              sha256: prepared.audio.sha256,
              extension: "mp3",
              content_type: "audio/mpeg",
              duration_seconds: prepared.audio.duration_seconds,
            },
          });
        },
      },
    });
    outbox = new LocalSyncOutbox(
      join(env.root, "outbox"),
      join(env.root, "cache"),
      { minimum_free_bytes: 0 },
    );
    try {
      let done = env.outcome();
      const accepted = env.manager.start(request, account);
      account.uid = "firebase-owner-b";
      await accepted;
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(staged).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "firebase-owner-a" }),
      );
      const [record] = await outbox.list({
        ...account,
        uid: "firebase-owner-a",
      });
      expect(await readFile(record!.original.path, "utf8")).toBe(
        "fixture original",
      );
      expect(await readdir(join(env.root, "cache/jobs"))).toEqual([]);
      const metadata = await readFile(
        join(env.root, "cache/vocals", cacheKey(8), "result.json"),
        "utf8",
      );
      const retained = JSON.parse(metadata);
      expect(retained).not.toHaveProperty("original");
      expect(retained.original_declaration).toEqual({
        extension: "mp3",
        content_type: "audio/mpeg",
        duration_seconds: 10,
        bytes: Buffer.byteLength("fixture original"),
        sha256: createHash("sha256").update("fixture original").digest("hex"),
      });
      expect(retained.original_declaration).not.toHaveProperty("path");
      expect(JSON.parse(metadata).owner_uid).toBe("firebase-owner-a");
      done = env.outcome();
      await env.manager.start(request, account);
      expect((await done).cache_hit).toBe(true);
      expect(staged).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(
          await readFile(
            join(env.root, "cache/vocals", cacheKey(8), "result.json"),
            "utf8",
          ),
        ).owner_uid,
      ).toBe("firebase-owner-a");
    } finally {
      await env.close();
    }
  });
  it("retains a guest original declaration for a later signed-in warm result without inference or auto-pairing", async () => {
    const ready = vi.fn();
    const prepared = vi.fn();
    const env = await fixture({
      original: true,
      validatedModel: model,
      managerOptions: { onReady: ready, onPrepared: prepared },
    });
    try {
      let done = env.outcome();
      await env.manager.start(request);
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const owner = { uid: "owner-new", session_generation: "session-new" };
      done = env.outcome();
      await env.manager.start(request, owner);
      expect((await done).cache_hit).toBe(true);
      expect(env.calls()).toBe(1);
      expect(prepared).not.toHaveBeenCalled();
      const cold = ready.mock.calls[0]![0].audio;
      const warm = ready.mock.calls[1]![0].audio;
      expect(warm.original_declaration).toEqual(cold.original_declaration);
      expect(warm.original_declaration).toMatchObject({
        extension: "mp3",
        content_type: "audio/mpeg",
        bytes: 16,
        duration_seconds: 10,
        sha256: createHash("sha256").update("fixture original").digest("hex"),
      });
      expect(warm.original_declaration).not.toHaveProperty("path");
      expect(warm).not.toHaveProperty("original");

      // An older manifest can still play, but cannot invent discarded original evidence.
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const path = join(env.root, "cache/vocals", cacheKey(8), "result.json");
      const legacy = JSON.parse(await readFile(path, "utf8"));
      delete legacy.original_declaration;
      await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
      done = env.outcome();
      await env.manager.start(request, owner);
      expect((await done).cache_hit).toBe(true);
      expect(env.calls()).toBe(1);
      expect(ready.mock.calls[2]![0].audio).not.toHaveProperty(
        "original_declaration",
      );
      expect(prepared).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }
  });
  it("retains a shared original declaration while publishing vocals without original bytes", async () => {
    const prepared = vi.fn(),
      ready = vi.fn();
    const declaration = {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: 16,
      duration_seconds: 10,
      sha256: createHash("sha256").update("shared original").digest("hex"),
    };
    const env = await fixture({
      managerOptions: { onReady: ready, onPrepared: prepared },
      resultMetadata: {
        shared_youtube_profile: "kim-vocal-2-full-timeline-v1",
        original_declaration: declaration,
        source: {
          kind: "youtube",
          video_id: request.video_id,
          format_id: "shared-cache",
          audio_track_id: null,
          audio_is_default: null,
          language: null,
        },
      },
    });
    try {
      let done = env.outcome();
      await env.manager.start(request, residentOwner);
      expect(await done).toMatchObject({ state: "READY", cache_hit: false });
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(prepared).not.toHaveBeenCalled();
      const retained = JSON.parse(
        await readFile(
          join(env.root, "cache/vocals", cacheKey(8), "result.json"),
          "utf8",
        ),
      );
      expect(retained.original_declaration).toEqual(declaration);
      expect(retained.shared_youtube_profile).toBe(
        "kim-vocal-2-full-timeline-v1",
      );
      expect(retained).not.toHaveProperty("original");
      done = env.outcome();
      await env.manager.start(request, residentOwner);
      expect(await done).toMatchObject({ state: "READY", cache_hit: true });
      expect(env.calls()).toBe(1);
      expect(ready.mock.calls[1]![0].audio.original_declaration).toEqual(
        declaration,
      );
      expect(prepared).not.toHaveBeenCalled();
    } finally {
      await env.close();
    }
  });
  it.each(["timeline", "source"])(
    "rejects shared declaration %s mismatches before publishing playable media",
    async (mismatch) => {
      const env = await fixture({
        resultMetadata: {
          shared_youtube_profile: "kim-vocal-2-full-timeline-v1",
          original_declaration: {
            extension: "m4a",
            content_type: "audio/mp4",
            bytes: 16,
            duration_seconds: mismatch === "timeline" ? 12 : 10,
            sha256: "a".repeat(64),
          },
          source: {
            kind: "youtube",
            video_id: mismatch === "source" ? "different__" : request.video_id,
            format_id: "shared-cache",
            audio_track_id: null,
            audio_is_default: null,
            language: null,
          },
        },
      });
      try {
        const done = env.outcome();
        await env.manager.start(request);
        expect(await done).toMatchObject({
          state: "FAILED",
          error_code: "ORIGINAL_DECLARATION_INVALID",
        });
        expect(env.manager.current()).not.toHaveProperty("media");
      } finally {
        await env.close();
      }
    },
  );
  it("publishes deferred save progress for the current player without replacing its media or persisting attempt state", async () => {
    const env = await fixture({
      original: true,
      resultMetadata: {
        shared_youtube_profile: "kim-vocal-2-full-timeline-v1",
        publication_pending: true,
      },
    });
    try {
      let done = env.outcome();
      const started = await env.manager.start(request);
      expect(
        env.manager.setSaveState(started.job_id, started.video_id, "saving"),
      ).toBe(false);
      const ready = await done;
      expect(ready.save_state).toBe("pending");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const metadata = JSON.parse(
        await readFile(
          join(env.root, "cache/vocals", cacheKey(8), "result.json"),
          "utf8",
        ),
      );
      expect(metadata).not.toHaveProperty("publication_pending");
      expect(metadata).not.toHaveProperty("save_state");
      expect(
        env.manager.setSaveState("retired-job", ready.video_id, "saved"),
      ).toBe(false);
      expect(
        env.manager.setSaveState(ready.job_id, "different__", "saved"),
      ).toBe(false);
      expect(
        env.manager.setSaveState(ready.job_id, ready.video_id, "saving"),
      ).toBe(true);
      expect(env.manager.current()).toMatchObject({
        media: ready.media,
        save_state: "saving",
      });
      const count = env.snapshots.length;
      expect(
        env.manager.setSaveState(ready.job_id, ready.video_id, "saving"),
      ).toBe(true);
      expect(env.snapshots).toHaveLength(count);
      expect(
        env.manager.setSaveState(ready.job_id, ready.video_id, "saved"),
      ).toBe(true);
      expect(env.manager.current()).toMatchObject({
        media: ready.media,
        save_state: "saved",
      });
      await env.manager.cancel(ready.job_id);
      expect(
        env.manager.setSaveState(ready.job_id, ready.video_id, "saving"),
      ).toBe(false);
      done = env.outcome();
      await env.manager.start(request);
      const replay = await done;
      expect(replay.cache_hit).toBe(true);
      expect(replay).not.toHaveProperty("save_state");
      expect(
        env.manager.setSaveState(ready.job_id, ready.video_id, "saved"),
      ).toBe(false);
    } finally {
      await env.close();
    }
  });
  it("does not apply shared publication progress to cloud results", async () => {
    const env = await fixture({ providerId: "ONLINE_MUSICMUTE" });
    try {
      const done = env.outcome();
      await env.manager.start({ ...request, provider: "ONLINE_MUSICMUTE" });
      const ready = await done;
      expect(ready.state).toBe("READY");
      expect(
        env.manager.setSaveState(ready.job_id, ready.video_id, "saving"),
      ).toBe(false);
      expect(env.manager.current()).not.toHaveProperty("save_state");
    } finally {
      await env.close();
    }
  });
  it.each([
    { path: "/private/disallowed" },
    { sha256: "x".repeat(64) },
    { bytes: 256 * 1024 ** 2 + 1 },
    { bytes: 0 },
    { extension: "wav" },
    { content_type: "audio/wav" },
    { duration_seconds: 12 },
    { extension: "__proto__" },
  ])(
    "refuses a malformed retained original declaration: %j",
    async (change) => {
      const env = await fixture({ original: true });
      try {
        let done = env.outcome();
        await env.manager.start(request);
        expect((await done).state).toBe("READY");
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const path = join(env.root, "cache/vocals", cacheKey(8), "result.json");
        const value = JSON.parse(await readFile(path, "utf8"));
        value.original_declaration = {
          ...value.original_declaration,
          ...change,
        };
        await writeFile(path, JSON.stringify(value), { mode: 0o600 });
        done = env.outcome();
        await env.manager.start(request);
        expect((await done).cache_hit).toBe(false);
        expect(env.calls()).toBe(2);
        expect(
          JSON.parse(await readFile(path, "utf8")).original_declaration,
        ).toMatchObject({
          extension: "mp3",
          content_type: "audio/mpeg",
          bytes: 16,
          duration_seconds: 10,
        });
      } finally {
        await env.close();
      }
    },
  );
  it.each([
    "ACCOUNT_CHANGED",
    "OUTBOX_FULL",
    "OUTBOX_BUSY",
    "OUTBOX_WRITE_FAILED",
  ])(
    "preserves successful local playback and the account's original when staging fails with %s",
    async (failure) => {
      const env = await fixture({
        original: true,
        sourceTitle: "  Recovery\0 voice title\n  ",
        managerOptions: {
          onPrepared: async () => {
            throw new Error(failure);
          },
        },
      });
      try {
        const done = env.outcome();
        await env.manager.start(request, {
          uid: "firebase-owner",
          session_generation: "12345678-1234-4123-8123-123456789abc",
        });
        const ready = await done;
        expect(ready.state).toBe("READY");
        expect((await fetch(ready.media!.url)).status).toBe(200);
        expect(
          env.diagnostics
            .snapshot()
            .recent_events.some(
              (event) => event.code === "LOCAL_SYNC_STAGING_FAILED",
            ),
        ).toBe(true);
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const work = join(env.root, "cache", "jobs", ready.job_id);
        expect((await readdir(work)).sort()).toEqual([
          "local-sync-recovery.json",
          "source.mp3",
        ]);
        expect(await readFile(join(work, "source.mp3"), "utf8")).toBe(
          "fixture original",
        );
        const recovery = JSON.parse(
          await readFile(join(work, "local-sync-recovery.json"), "utf8"),
        );
        expect(recovery.owner.uid).toBe("firebase-owner");
        expect(recovery.title).toBe("Recovery voice title");
        expect(JSON.stringify(recovery)).not.toContain(env.root);
        const outbox = new LocalSyncOutbox(
          join(env.root, "outbox"),
          join(env.root, "cache"),
          { minimum_free_bytes: 0 },
        );
        expect(await outbox.pinnedCacheKeys()).toEqual(new Set([cacheKey(8)]));
        await expect(outbox.assertAdmission()).rejects.toThrow("OUTBOX_FULL");
        await outbox.recover();
        expect(
          await outbox.list({
            uid: "firebase-other-owner",
            session_generation: "12345678-1234-4123-8123-123456789abc",
          }),
        ).toEqual([]);
        const [record] = await outbox.list(recovery.owner);
        expect(record?.request_id).toBe(ready.job_id);
        expect(record?.title).toBe("Recovery voice title");
        expect(await readFile(record!.original.path, "utf8")).toBe(
          "fixture original",
        );
        expect(await readdir(join(env.root, "cache", "jobs"))).toEqual([]);
        expect((await fetch(ready.media!.url)).status).toBe(200);
      } finally {
        await env.close();
      }
    },
  );
  it("uses the full native file digest for reuse instead of a shortened display identity", async () => {
    const env = await fixture();
    try {
      for (const [digest, cached] of [
        ["a".repeat(64), false],
        ["b".repeat(64), false],
        ["a".repeat(64), true],
      ] as const) {
        const done = env.outcome();
        await env.manager.start(request, undefined, digest);
        expect((await done).cache_hit).toBe(cached);
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      }
      expect(env.calls()).toBe(2);
      await expect(
        env.manager.start(request, undefined, "short"),
      ).rejects.toThrow("SOURCE_IDENTITY_INVALID");
    } finally {
      await env.close();
    }
  });
  it("retries a recovery ticket after freeing disposable scratch when its first creation runs out of space", async () => {
    const onPrepared = vi.fn();
    const env = await fixture({
      original: true,
      managerOptions: { onPrepared },
    });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let failed = false;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (
        !failed &&
        typeof path === "string" &&
        path.includes(".local-sync-")
      ) {
        failed = true;
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return actual.open(path, flags, mode);
    });
    try {
      const done = env.outcome();
      const owner = {
        uid: "firebase-owner",
        session_generation: "12345678-1234-4123-8123-123456789abc",
      };
      await env.manager.start(request, owner);
      const ready = await done;
      expect(ready.state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(failed).toBe(true);
      expect(onPrepared).not.toHaveBeenCalled();
      const work = join(env.root, "cache", "jobs", ready.job_id);
      expect((await readdir(work)).sort()).toEqual([
        "local-sync-recovery.json",
        "source.mp3",
      ]);
      const outbox = new LocalSyncOutbox(
        join(env.root, "outbox"),
        join(env.root, "cache"),
        { minimum_free_bytes: 0 },
      );
      await outbox.recover();
      const [record] = await outbox.list(owner);
      expect(await readFile(record!.original.path, "utf8")).toBe(
        "fixture original",
      );
    } finally {
      await env.close();
    }
  });
  it("measures current cache replay without re-emitting historical inference timings", async () => {
    const env = await fixture();
    try {
      let done = env.outcome();
      await env.manager.start(request);
      const initial = await done;
      expect(initial.cache_hit).toBe(false);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const entry = join(env.root, "cache/vocals", cacheKey(8));
      const metadataBefore = await readFile(join(entry, "result.json"));
      expect(JSON.parse(metadataBefore.toString("utf8"))).not.toHaveProperty(
        "verified_model_sha256",
      );
      const audioBefore = await readFile(join(entry, "vocals.mp3"));
      expect(
        env.diagnostics
          .snapshot()
          .jobs.find((job) => job.job_id === initial.job_id)?.stages_ms
          .separation,
      ).toBe(1);

      done = env.outcome();
      await env.manager.start(request);
      const replay = await done;
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(replay.cache_hit).toBe(true);
      expect(env.calls()).toBe(1);
      const exported = await env.diagnostics.export();
      const events = exported.report.recent_events.filter(
        (event) => event.job_id === replay.job_id,
      );
      expect(events.some((event) => event.event === "cache_hit")).toBe(true);
      expect(
        events.find((event) => event.event === "cache_hit"),
      ).not.toHaveProperty("verified_model_sha256");
      expect(
        events.find((event) => event.event === "job_ready"),
      ).not.toHaveProperty("verified_model_sha256");
      expect(
        exported.report.recent_events.find(
          (event) =>
            event.job_id === initial.job_id && event.event === "job_ready",
        ),
      ).not.toHaveProperty("verified_model_sha256");
      const stages = events.filter(
        (event) => event.event === "stage_completed",
      );
      expect(stages.map((event) => event.metrics?.stage)).toEqual([
        "cache-lookup",
        "cache-validation",
        "media-grant",
      ]);
      for (const event of stages) {
        expect(event.component).toBe("companion");
        expect(event.metrics?.cache_hit).toBe(true);
        expect(event.metrics?.duration_ms).toBeGreaterThanOrEqual(0);
      }
      expect(events.some((event) => event.component === "engine")).toBe(false);
      const summary = exported.report.jobs.find(
        (job) => job.job_id === replay.job_id,
      );
      expect(Object.keys(summary!.stages_ms).sort()).toEqual([
        "cache-lookup",
        "cache-validation",
        "media-grant",
      ]);
      expect(await readFile(join(entry, "result.json"))).toEqual(
        metadataBefore,
      );
      expect(await readFile(join(entry, "vocals.mp3"))).toEqual(audioBefore);
    } finally {
      await env.close();
    }
  });
  it.each([model, "a".repeat(64)])(
    "claims prepared model verification only from a matching trusted pipeline validation",
    async (validatedModel) => {
      const env = await fixture({ validatedModel });
      try {
        let done = env.outcome();
        await env.manager.start(request);
        const job = await done;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(job.state).toBe("READY");
        const report = (await env.diagnostics.export()).report;
        const completed = report.recent_events.find(
          (event) => event.event === "local_pipeline_completed",
        );
        const ready = report.recent_events.find(
          (event) => event.event === "job_ready",
        );
        if (validatedModel === model) {
          expect(completed?.verified_model_sha256).toBe(model);
          expect(ready?.verified_model_sha256).toBe(model);
        } else {
          expect(completed).not.toHaveProperty("verified_model_sha256");
          expect(ready).not.toHaveProperty("verified_model_sha256");
        }
        const entry = join(env.root, "cache/vocals", cacheKey(8));
        const metadata = await readFile(join(entry, "result.json"));
        if (validatedModel === model)
          expect(
            JSON.parse(metadata.toString("utf8")).verified_model_sha256,
          ).toBe(model);
        else
          expect(JSON.parse(metadata.toString("utf8"))).not.toHaveProperty(
            "verified_model_sha256",
          );
        done = env.outcome();
        await env.manager.start(request);
        const replay = await done;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(replay.cache_hit).toBe(true);
        expect(env.calls()).toBe(1);
        const replayEvents = (
          await env.diagnostics.export()
        ).report.recent_events.filter(
          (event) => event.job_id === replay.job_id,
        );
        for (const event of replayEvents.filter((event) =>
          ["cache_hit", "job_ready"].includes(event.event),
        )) {
          if (validatedModel === model)
            expect(event.verified_model_sha256).toBe(model);
          else expect(event).not.toHaveProperty("verified_model_sha256");
        }
        expect(replayEvents.some((event) => event.component === "engine")).toBe(
          false,
        );
        expect(await readFile(join(entry, "result.json"))).toEqual(metadata);
      } finally {
        await env.close();
      }
    },
  );
  it("does not accept provider-result verification properties as recorder-owned provenance", async () => {
    const env = await fixture({ spoofedVerification: model });
    try {
      for (let index = 0; index < 2; index++) {
        const done = env.outcome();
        await env.manager.start(request);
        const job = await done;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(job.state).toBe("READY");
        expect(job.cache_hit).toBe(index > 0);
        const events = (
          await env.diagnostics.export()
        ).report.recent_events.filter((event) => event.job_id === job.job_id);
        expect(
          events.every((event) => event.verified_model_sha256 === undefined),
        ).toBe(true);
      }
      const retained = JSON.parse(
        await readFile(
          join(env.root, "cache/vocals", cacheKey(8), "result.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(retained).not.toHaveProperty("verified_model_sha256");
      expect(env.calls()).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("writes no provenance when trusted validation does not match the returned model", async () => {
    const env = await fixture({
      validatedModel: model,
      resultModel: "a".repeat(64),
    });
    try {
      const done = env.outcome();
      await env.manager.start(request);
      const job = await done;
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const retained = JSON.parse(
        await readFile(
          join(env.root, "cache/vocals", cacheKey(8), "result.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(retained).not.toHaveProperty("verified_model_sha256");
      const ready = (await env.diagnostics.export()).report.recent_events.find(
        (event) => event.job_id === job.job_id && event.event === "job_ready",
      );
      expect(ready).not.toHaveProperty("verified_model_sha256");
    } finally {
      await env.close();
    }
  });

  it.each([undefined, null, "a".repeat(64), "/private/unverified-model"])(
    "keeps legacy or invalid provenance caches usable without upgrading verification",
    async (provenance) => {
      const env = await fixture({ validatedModel: model });
      try {
        let done = env.outcome();
        await env.manager.start(request);
        await done;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const entry = join(env.root, "cache/vocals", cacheKey(8));
        const path = join(entry, "result.json");
        const metadata = JSON.parse(await readFile(path, "utf8")) as Record<
          string,
          unknown
        >;
        delete metadata.verified_model_sha256;
        if (provenance !== undefined)
          metadata.verified_model_sha256 = provenance;
        await writeFile(path, JSON.stringify(metadata), { mode: 0o600 });
        const before = await readFile(path);
        done = env.outcome();
        await env.manager.start(request);
        const replay = await done;
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(replay.state).toBe("READY");
        expect(replay.cache_hit).toBe(true);
        expect(env.calls()).toBe(1);
        const events = (
          await env.diagnostics.export()
        ).report.recent_events.filter(
          (event) => event.job_id === replay.job_id,
        );
        expect(
          events.every((event) => event.verified_model_sha256 === undefined),
        ).toBe(true);
        expect(JSON.stringify(events)).not.toContain(
          "/private/unverified-model",
        );
        expect(await readFile(path)).toEqual(before);
      } finally {
        await env.close();
      }
    },
  );
  it("preserves revision-seven cache bytes without reusing them for revision eight", async () => {
    const env = await fixture();
    try {
      const historicalRoot = join(env.root, "cache/vocals", cacheKey(7));
      await mkdir(historicalRoot, { recursive: true, mode: 0o700 });
      const audio = Buffer.from("historical profile-only vocals");
      const historicalAudio = join(historicalRoot, "vocals.mp3");
      const historicalMetadata = JSON.stringify({
        output_path: historicalAudio,
        bytes: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
        model_id: model,
        trim_enabled: false,
        duration_seconds: request.duration_seconds,
        source_duration_seconds: request.duration_seconds,
        timings_ms: { separation: 1 },
      });
      await writeFile(historicalAudio, audio, { mode: 0o600 });
      await writeFile(join(historicalRoot, "result.json"), historicalMetadata, {
        mode: 0o600,
      });

      let done = env.outcome();
      await env.manager.start(request);
      const fresh = await done;
      expect(fresh.state).toBe("READY");
      expect(fresh.cache_hit).toBe(false);
      expect(env.calls()).toBe(1);
      expect(await (await fetch(fresh.media!.url)).text()).toBe(
        "fixture vocals",
      );
      expect(await readFile(historicalAudio)).toEqual(audio);
      expect(await readFile(join(historicalRoot, "result.json"), "utf8")).toBe(
        historicalMetadata,
      );
      expect(await readdir(join(env.root, "cache/vocals"))).toEqual(
        expect.arrayContaining([cacheKey(7), cacheKey(8)]),
      );

      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      done = env.outcome();
      await env.manager.start(request);
      const replay = await done;
      expect(replay.state).toBe("READY");
      expect(replay.cache_hit).toBe(true);
      expect(env.calls()).toBe(1);
      expect(await (await fetch(replay.media!.url)).text()).toBe(
        "fixture vocals",
      );
      expect(await readFile(historicalAudio)).toEqual(audio);
      expect(await readFile(join(historicalRoot, "result.json"), "utf8")).toBe(
        historicalMetadata,
      );
    } finally {
      await env.close();
    }
  });
  it("rejects wrong-model revision-eight metadata before cache playback", async () => {
    const env = await fixture();
    try {
      let done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(false);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const metadataPath = join(
        env.root,
        "cache/vocals",
        cacheKey(8),
        "result.json",
      );
      const retained = JSON.parse(await readFile(metadataPath, "utf8"));
      await writeFile(
        metadataPath,
        JSON.stringify({ ...retained, model_id: "f".repeat(64) }),
      );

      done = env.outcome();
      await env.manager.start(request);
      const result = await done;
      expect(result.state).toBe("READY");
      expect(result.cache_hit).toBe(false);
      expect(result.media?.model_id).toBe(model);
      expect(env.calls()).toBe(2);
      expect(JSON.parse(await readFile(metadataPath, "utf8")).model_id).toBe(
        model,
      );

      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(true);
      expect(env.calls()).toBe(2);
    } finally {
      await env.close();
    }
  });
  it.each(["copy", "write", "prune"])(
    "cancellation during retained %s cannot publish READY or leave a capability",
    async (stage) => {
      const env = await fixture();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      const entered = deferred();
      const release = deferred();
      const vocalsRoot = join(env.root, "cache/vocals");
      let held = false;
      const hold = async () => {
        if (held) return;
        held = true;
        entered.resolve();
        await release.promise;
      };
      if (stage === "copy")
        vi.mocked(copyFile).mockImplementation(async (from, to, mode) => {
          await actual.copyFile(from, to, mode);
          if (
            String(to).startsWith(vocalsRoot + "/") &&
            String(to).endsWith("vocals.mp3")
          )
            await hold();
        });
      if (stage === "write")
        vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
          await actual.writeFile(path, data, options);
          if (
            String(path).startsWith(vocalsRoot + "/") &&
            String(path).endsWith("result.json")
          )
            await hold();
        });
      if (stage === "prune")
        vi.mocked(readdir).mockImplementation((async (
          path: Parameters<typeof readdir>[0],
          options: Parameters<typeof readdir>[1],
        ) => {
          const entries = await actual.readdir(path, options);
          if (String(path) === vocalsRoot && entries.length > 0) {
            const names = await actual.readdir(vocalsRoot);
            if (
              await actual
                .lstat(join(vocalsRoot, names[0]!, "result.json"))
                .catch(() => null)
            )
              await hold();
          }
          return entries;
        }) as typeof readdir);
      const issue = vi.spyOn(env.media, "issue");
      try {
        const started = await env.manager.start(request);
        await vi.waitFor(() => expect(held).toBe(true));
        await entered.promise;
        const cancellation = env.manager.cancel(started.job_id);
        release.resolve();
        await cancellation;
        for (const result of issue.mock.results)
          if (result.type === "return") {
            const response = await fetch(await result.value);
            expect(response.status).toBe(403);
          }
        expect(env.snapshots.map((snapshot) => snapshot.state)).not.toContain(
          "READY",
        );
        expect(env.manager.current()?.state).toBe("CANCELLED");
        expect(env.manager.current()?.media).toBeUndefined();
        expect(env.manager.busy()).toBe(false);
        expect(await actual.readdir(join(env.root, "cache/jobs"))).toEqual([]);
        expect(issue).not.toHaveBeenCalled();

        const successorDone = env.outcome();
        await env.manager.start(request);
        const successor = await successorDone;
        expect(successor.state).toBe("READY");
        expect(successor.job_id).not.toBe(started.job_id);
        expect((await fetch(successor.media!.url)).status).toBe(200);
        await env.manager.cancel(successor.job_id);
        expect((await fetch(successor.media!.url)).status).toBe(403);
      } finally {
        release.resolve();
        await env.close();
      }
    },
  );
  it.each([
    "symlink",
    "permissions",
    "owner",
    "file-symlink",
    "file-hardlink",
    "file-permissions",
  ])(
    "refuses %s cache descendants without deleting foreign bytes",
    async (unsafe) => {
      const env = await fixture();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      const vocalsRoot = join(env.root, "cache/vocals");
      const outside = join(env.root, "foreign");
      const entry = join(
        unsafe === "symlink" ? outside : vocalsRoot,
        "a".repeat(64),
      );
      await mkdir(join(env.root, "cache"), { mode: 0o700 });
      await mkdir(entry, { recursive: true, mode: 0o700 });
      const audio = join(entry, "vocals.mp3");
      if (["file-symlink", "file-hardlink"].includes(unsafe)) {
        await mkdir(outside, { recursive: true, mode: 0o700 });
        const original = join(outside, "original.mp3");
        await writeFile(original, "foreign audio bytes", { mode: 0o600 });
        if (unsafe === "file-symlink") await symlink(original, audio);
        else await link(original, audio);
      } else await writeFile(audio, "foreign audio bytes", { mode: 0o600 });
      await writeFile(join(entry, "result.json"), "foreign record bytes", {
        mode: 0o600,
      });
      if (unsafe === "symlink") await symlink(outside, vocalsRoot);
      if (unsafe === "permissions") await actual.chmod(vocalsRoot, 0o755);
      if (unsafe === "file-permissions") await actual.chmod(audio, 0o644);
      if (unsafe === "owner")
        vi.mocked(lstat).mockImplementation((async (path, options) => {
          const info = await actual.lstat(path, options);
          if (String(path) === entry)
            Object.assign(info, { uid: (process.getuid?.() ?? 0) + 1 });
          return info;
        }) as typeof lstat);
      try {
        await expect(env.manager.clearCache()).rejects.toThrow("CACHE_UNSAFE");
        expect(await readFile(join(entry, "vocals.mp3"), "utf8")).toBe(
          "foreign audio bytes",
        );
        expect(await readFile(join(entry, "result.json"), "utf8")).toBe(
          "foreign record bytes",
        );
        expect(env.manager.busy()).toBe(false);
        expect(env.calls()).toBe(0);
        if (unsafe === "symlink") {
          const done = env.outcome();
          await env.manager.start(request);
          expect((await done).error_code).toBe("CACHE_UNSAFE");
          await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
          expect(env.calls()).toBe(0);
          expect(await readFile(join(entry, "vocals.mp3"), "utf8")).toBe(
            "foreign audio bytes",
          );
        }
      } finally {
        await env.close();
      }
    },
  );
  it.each([0, (3 * 1024 ** 3) / disk.bsize - 1])(
    "refuses %s available blocks before preparation and releases admission",
    async (bavail) => {
      const env = await fixture();
      try {
        vi.mocked(statfs).mockResolvedValueOnce({ ...disk, bavail });
        await expect(env.manager.start(request)).rejects.toThrow(
          "DISK_SPACE_LOW",
        );
        expect(env.calls()).toBe(0);
        expect(env.manager.current()).toBeNull();
        expect(env.manager.busy()).toBe(false);
        expect(await readdir(join(env.root, "cache"))).toEqual([]);

        // The documented reserve itself is sufficient; a refusal must not keep
        // the admission lock or prevent a later successful job.
        vi.mocked(statfs).mockResolvedValueOnce({
          ...disk,
          bavail: (3 * 1024 ** 3) / disk.bsize,
        });
        const done = env.outcome();
        await env.manager.start(request);
        expect((await done).state).toBe("READY");
        expect(env.calls()).toBe(1);
      } finally {
        await env.close();
      }
    },
  );
  it("reserves admission before asynchronous disk checks", async () => {
    const env = await fixture({ hang: true });
    try {
      const first = env.manager.start(request);
      await expect(env.manager.start(request)).rejects.toThrow(
        "LOCAL_COMPANION_BUSY",
      );
      const started = await first;
      const done = env.outcome();
      await env.manager.cancel(started.job_id);
      expect((await done).state).toBe("CANCELLED");
      expect(env.manager.busy()).toBe(false);
      expect(await readdir(join(env.root, "cache/jobs"))).toEqual([]);
    } finally {
      await env.close();
    }
  });
  it("reuses verified untrimmed bytes and reprocesses corrupted cache", async () => {
    const env = await fixture();
    try {
      let done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(false);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(true);
      expect(env.calls()).toBe(1);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const cache = join(env.root, "cache/vocals");
      const [entry] = await readdir(cache);
      await writeFile(join(cache, entry!, "vocals.mp3"), "corrupted");
      done = env.outcome();
      await env.manager.start(request);
      expect((await done).cache_hit).toBe(false);
      expect(env.calls()).toBe(2);
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const foreign = join(cache, "user-data");
      await mkdir(foreign);
      await writeFile(join(foreign, "keep.txt"), "preserve");
      await env.manager.clearCache();
      expect(env.manager.current()).toBeNull();
      expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe(
        "preserve",
      );
    } finally {
      await env.close();
    }
  });
  it.each(["missing", "corrupt"])(
    "preserves pending vocals with a %s manifest without inference or replacement",
    async (damage) => {
      const account = {
        uid: "firebase-pinned-owner",
        session_generation: "12345678-1234-4123-8123-123456789abc",
      };
      let outbox: LocalSyncOutbox;
      const env = await fixture({
        original: true,
        managerOptions: {
          pinnedCacheKeys: () => outbox.pinnedCacheKeys(),
          onPrepared: async (prepared) => {
            await outbox.stage({
              owner: prepared.owner,
              request_id: prepared.request_id,
              cache_key: prepared.cache_key,
              original: prepared.audio.original!,
              vocals: {
                path: prepared.audio.output_path,
                bytes: prepared.audio.bytes,
                sha256: prepared.audio.sha256,
                extension: "mp3",
                content_type: "audio/mpeg",
                duration_seconds: prepared.audio.duration_seconds,
              },
            });
          },
        },
      });
      outbox = new LocalSyncOutbox(
        join(env.root, "outbox"),
        join(env.root, "cache"),
        { minimum_free_bytes: 0 },
      );
      try {
        let done = env.outcome();
        await env.manager.start(request, account);
        expect((await done).state).toBe("READY");
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const [pending] = await outbox.list(account);
        expect(pending?.state).toBe("pending");
        const vocal = await readFile(pending!.vocals.path);
        const original = await readFile(pending!.original.path);
        done = env.outcome();
        await env.manager.start(request, account);
        expect((await done).cache_hit).toBe(true);
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        const metadata = join(
          env.root,
          "cache/vocals",
          cacheKey(8),
          "result.json",
        );
        if (damage === "missing") await rm(metadata);
        else await writeFile(metadata, "{interrupted", { mode: 0o600 });
        vi.mocked(copyFile).mockClear();
        done = env.outcome();
        await env.manager.start(request, account);
        expect(await done).toMatchObject({
          state: "FAILED",
          error_code: "CACHE_UNSAFE",
        });
        await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
        expect(env.calls()).toBe(1);
        expect(copyFile).not.toHaveBeenCalled();
        expect(await readFile(pending!.vocals.path)).toEqual(vocal);
        expect(createHash("sha256").update(vocal).digest("hex")).toBe(
          pending!.vocals.sha256,
        );
        expect(await readFile(pending!.original.path)).toEqual(original);
        expect(await outbox.list(account)).toEqual([pending]);
        expect(await readdir(join(env.root, "cache/jobs"))).toEqual([]);
        if (damage === "missing")
          await expect(readFile(metadata)).rejects.toMatchObject({
            code: "ENOENT",
          });
        else expect(await readFile(metadata, "utf8")).toBe("{interrupted");
      } finally {
        await env.close();
      }
    },
  );
  it("rechecks replacement pins published by another process after initial admission", async () => {
    let cacheRoot = "";
    let publishPin = false;
    const env = await fixture({
      managerOptions: {
        pinnedCacheKeys: async () => {
          const pins = await readPlaybackPins(cacheRoot);
          if (publishPin) {
            publishPin = false;
            execFileSync(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
const [root,key,pid] = process.argv.slice(1);
writeFileSync(join(root,'pins','playback-'+randomUUID()+'.json'),
JSON.stringify({version:1,cache_key:key,pid:Number(pid)}),{flag:'wx',mode:0o600});`,
                cacheRoot,
                cacheKey(8),
                String(process.pid),
              ],
              { env: {}, timeout: 5000 },
            );
          }
          return pins;
        },
      },
    });
    cacheRoot = join(env.root, "cache");
    try {
      await mkdir(join(cacheRoot, "pins"), { recursive: true, mode: 0o700 });
      let done = env.outcome();
      await env.manager.start(request);
      expect((await done).state).toBe("READY");
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      const vocal = join(cacheRoot, "vocals", cacheKey(8), "vocals.mp3");
      const bytes = await readFile(vocal);
      const metadata = join(cacheRoot, "vocals", cacheKey(8), "result.json");
      await rm(metadata);
      publishPin = true;
      vi.mocked(copyFile).mockClear();
      done = env.outcome();
      await env.manager.start(request);
      expect(await done).toMatchObject({
        state: "FAILED",
        error_code: "CACHE_UNSAFE",
      });
      await vi.waitFor(() => expect(env.manager.busy()).toBe(false));
      expect(env.calls()).toBe(2);
      expect(copyFile).not.toHaveBeenCalled();
      expect(await readFile(vocal)).toEqual(bytes);
      expect(await readPlaybackPins(cacheRoot)).toEqual(new Set([cacheKey(8)]));
      await expect(readFile(metadata)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(join(cacheRoot, "jobs"))).toEqual([]);
    } finally {
      await env.close();
    }
  });
  it("refuses mismatched timelines before issuing media", async () => {
    const env = await fixture({ mismatch: true });
    try {
      const done = env.outcome();
      await env.manager.start(request);
      const result = await done;
      expect(result.state).toBe("FAILED");
      expect(result.error_code).toBe("TIMELINE_MISMATCH");
      expect(result.media).toBeUndefined();
    } finally {
      await env.close();
    }
  });
  it("does not silently route unavailable local/online providers", async () => {
    const env = await fixture();
    try {
      await expect(
        env.manager.start({ ...request, provider: "ONLINE_MUSICMUTE" }),
      ).rejects.toThrow("PROVIDER_NOT_AVAILABLE");
      expect(env.calls()).toBe(0);
    } finally {
      await env.close();
    }
  });
  it("prevents admission while cache clearing owns the storage", async () => {
    const env = await fixture();
    try {
      const clearing = env.manager.clearCache();
      await expect(env.manager.start(request)).rejects.toThrow(
        "LOCAL_COMPANION_BUSY",
      );
      await clearing;
      expect(env.manager.busy()).toBe(false);
    } finally {
      await env.close();
    }
  });
});
