import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cacheAccountResult,
  accountCacheKey,
  findResidentAccountYouTube,
  readResidentAccountYouTube,
} from "../src/companion/account-cache.js";
import {
  FULL_TIMELINE_RECIPE_DIGEST,
  parseJobMetadata,
  type DownloadGrant,
  type JobMetadata,
} from "../src/companion/cloud-provider.js";
import { DesktopCatalog } from "../src/companion/desktop-catalog.js";
import { type LocalConfig } from "../src/companion/config.js";
import { type AccountScope } from "../src/companion/account-api.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";

let audio: Buffer;
let ffmpeg: string, ffprobe: string;
const roots: string[] = [];
beforeAll(() => {
  ffmpeg = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  ffprobe = execFileSync("which", ["ffprobe"], { encoding: "utf8" }).trim();
  audio = execFileSync(
    ffmpeg,
    [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=2",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "160k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { maxBuffer: 1024 * 1024 },
  );
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(overrides: Record<string, unknown> = {}, body = audio) {
  const root = await mkdtemp(join(tmpdir(), "mm-account-cache-"));
  roots.push(root);
  const config: LocalConfig = {
    root,
    cache_root: join(root, "cache"),
    logs_root: join(root, "logs"),
    models_root: join(root, "models"),
    python_path: "/unused/python",
    node_path: process.execPath,
    ffmpeg_path: ffmpeg,
    ffprobe_path: ffprobe,
    yt_dlp_path: "/unused/downloader",
    js_runtime_path: process.execPath,
    engine_root: "/unused/engine",
    runner_path: "/unused/runner",
  };
  const scope: AccountScope = {
    firebase_uid: "owner-a",
    session_generation: randomUUID(),
  };
  const sha256 = createHash("sha256").update(body).digest("base64");
  const job: JobMetadata = parseJobMetadata({
    id: "0123456789abcdef01234567",
    request_id: randomUUID(),
    status: "ready",
    source_kind: "url",
    source_url: "https://www.youtube.com/watch?v=bZxrIoCPsOc",
    source_title: "Test vocals",
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    trim_enabled: false,
    can_download_input: true,
    can_download_output: true,
    input: {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: body.length,
      duration_seconds: 2,
      sha256,
    },
    output: {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: body.length,
      sha256,
      duration_seconds: null,
    },
    error: null,
    ...overrides,
  });
  const grant: DownloadGrant = {
    url: "https://abc.r2.cloudflarestorage.com/private-vocals?signature=private",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(new Uint8Array(body), {
        headers: {
          "content-type": "audio/mpeg",
          "content-length": String(body.length),
        },
      }),
  );
  const controller = new AbortController();
  let current = true;
  const isCurrent = vi.fn(
    async (candidate: AccountScope) =>
      current &&
      candidate.firebase_uid === scope.firebase_uid &&
      candidate.session_generation === scope.session_generation,
  );
  const options = { signal: controller.signal, isCurrent, fetcher };
  return {
    root,
    config,
    scope,
    job,
    grant,
    fetcher,
    controller,
    isCurrent,
    options,
    setCurrent(value: boolean) {
      current = value;
    },
  };
}
async function emptyAttempts(env: Awaited<ReturnType<typeof fixture>>) {
  expect(await readdir(join(env.config.cache_root, "jobs"))).toEqual([]);
  expect(await readdir(env.config.cache_root)).not.toContain(".mutation.lock");
}
async function clearHandoffs(env: Awaited<ReturnType<typeof fixture>>) {
  await rm(join(env.config.cache_root, "pins"), {
    recursive: true,
    force: true,
  });
}
async function residentFixture() {
  const env = await fixture();
  const catalog = new DesktopCatalog(
    join(env.root, "catalog"),
    env.config.cache_root,
  );
  const cached = await cacheAccountResult(
    env.config,
    env.scope,
    env.job,
    env.grant,
    { ...env.options, catalog },
  );
  const owner = {
    uid: env.scope.firebase_uid,
    session_generation: env.scope.session_generation,
  };
  const options = {
    signal: env.controller.signal,
    catalog,
    isCurrent: async (value: typeof owner) =>
      env.isCurrent({
        firebase_uid: value.uid,
        session_generation: value.session_generation,
      }),
  };
  const manifestPath = join(
    env.config.cache_root,
    "vocals",
    cached.cache_key,
    "result.json",
  );
  async function mutate(change: Record<string, unknown>) {
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...JSON.parse(await readFile(manifestPath, "utf8")),
        ...change,
      }),
      { mode: 0o600 },
    );
  }
  return {
    ...env,
    catalog,
    cached,
    owner,
    residentOptions: options,
    manifestPath,
    mutate,
  };
}
describe("resident full-timeline owner YouTube reuse", () => {
  it("preserves custom catalog names over acquisition fallback and ignores malformed optional titles", async () => {
    const env = await residentFixture();
    const entry = (await env.catalog.list(env.owner)).entries[0]!;
    await env.catalog.remember(env.owner, {
      ...entry,
      source_title: "My podcast",
    });
    const before = await readFile(env.manifestPath);
    await expect(
      findResidentAccountYouTube(
        env.config,
        env.owner,
        { video_id: "bZxrIoCPsOc", duration_seconds: 2 },
        env.residentOptions,
      ),
    ).resolves.toMatchObject({ source_title: "My podcast" });
    expect(await readFile(env.manifestPath)).toEqual(before);
    await env.mutate({ source_title: { untrusted: true } });
    const read = await readResidentAccountYouTube(
      env.config.cache_root,
      env.owner,
      { video_id: "bZxrIoCPsOc", duration_seconds: 2 },
      env.cached.cache_key,
      env.residentOptions,
    );
    expect(read).not.toBeNull();
    expect(read?.source_title).toBeUndefined();
  });
  it("finds validated resident vocals without credentials, transfer, decoding, inference or manifest rewriting", async () => {
    const env = await residentFixture();
    const before = await readFile(env.manifestPath),
      identity = await stat(env.cached.vocal_path);
    env.fetcher.mockRejectedValue(
      new Error("resident lookup must never transfer"),
    );
    const value = await findResidentAccountYouTube(
      { root: env.root, cache_root: env.config.cache_root },
      env.owner,
      { video_id: "bZxrIoCPsOc", duration_seconds: 2 },
      env.residentOptions,
    );
    expect(value).toEqual({
      cache_key: env.cached.cache_key,
      duration_seconds: env.cached.duration_seconds,
      source_duration_seconds: 2,
      job_id: env.job.id,
      source_title: "Test vocals",
    });
    expect(env.fetcher).toHaveBeenCalledOnce();
    expect(await readFile(env.manifestPath)).toEqual(before);
    expect((await stat(env.cached.vocal_path)).ino).toBe(identity.ino);
    expect(await readdir(join(env.config.cache_root, "vocals"))).toEqual([
      env.cached.cache_key,
    ]);
    const decoded = await readResidentAccountYouTube(
      env.config.cache_root,
      env.owner,
      { video_id: "bZxrIoCPsOc", duration_seconds: 2 },
      env.cached.cache_key,
      env.residentOptions,
    );
    expect(decoded).toMatchObject({
      account_job_id: env.job.id,
      owner_uid: env.owner.uid,
      model_id: MODEL_SHA256,
      trim_enabled: false,
      timings_ms: {},
    });
    expect(decoded?.original).toBeUndefined();
    expect(decoded?.original_declaration).toBeUndefined();
    expect(decoded?.source).toBeUndefined();
  });
  it.each([
    { model_id: "another-model" },
    { recipe_digest: "a".repeat(64) },
    { validation_version: 0 },
    { trim_enabled: true },
    { owner_uid: "owner-b" },
    { account_job_id: "a".repeat(24) },
    { bytes: 1 },
    { sha256: "a".repeat(64) },
    { duration_seconds: 1 },
    { source_duration_seconds: 1201, duration_seconds: 1201 },
    { source: { kind: "youtube", video_id: "abcdefghijk" } },
    { output_path: "/untrusted/vocals.mp3" },
  ])("refuses incompatible resident metadata %j", async (change) => {
    const env = await residentFixture();
    await env.mutate(change);
    await expect(
      findResidentAccountYouTube(
        env.config,
        env.owner,
        { video_id: "bZxrIoCPsOc", duration_seconds: 2 },
        env.residentOptions,
      ),
    ).resolves.toBeNull();
    expect(env.fetcher).toHaveBeenCalledOnce();
  });
  it("does not trust a matching filename when its original owner/job/hash/recipe key differs", async () => {
    const env = await residentFixture(),
      key = "b".repeat(64);
    const target = join(env.config.cache_root, "vocals", key);
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "vocals.mp3"), audio, { mode: 0o600 });
    await writeFile(
      join(target, "result.json"),
      JSON.stringify({
        ...JSON.parse(await readFile(env.manifestPath, "utf8")),
        output_path: join(target, "vocals.mp3"),
      }),
      { mode: 0o600 },
    );
    await expect(
      readResidentAccountYouTube(
        env.config.cache_root,
        env.owner,
        { video_id: "bZxrIoCPsOc", duration_seconds: 2 },
        key,
        env.residentOptions,
      ),
    ).resolves.toBeNull();
  });
  it("requires measured video duration alignment and permits optional duration only for the native pre-acquisition lookup", async () => {
    const env = await residentFixture();
    await expect(
      findResidentAccountYouTube(
        env.config,
        env.owner,
        { video_id: "bZxrIoCPsOc", duration_seconds: 2.3 },
        env.residentOptions,
      ),
    ).resolves.toBeNull();
    await expect(
      findResidentAccountYouTube(
        env.config,
        env.owner,
        { video_id: "bZxrIoCPsOc" },
        env.residentOptions,
      ),
    ).resolves.toMatchObject({ cache_key: env.cached.cache_key });
  });
  it("refuses another owner namespace and fences the current generation after catalog discovery", async () => {
    const env = await residentFixture();
    await expect(
      findResidentAccountYouTube(
        env.config,
        { ...env.owner, uid: "owner-b" },
        { video_id: "bZxrIoCPsOc" },
        { ...env.residentOptions, isCurrent: () => true },
      ),
    ).resolves.toBeNull();
    const candidates = await env.catalog.youtubeCandidates(
      env.owner,
      "bZxrIoCPsOc",
    );
    const catalog = {
      youtubeCandidates: vi.fn(async () => {
        env.setCurrent(false);
        return candidates;
      }),
    };
    await expect(
      findResidentAccountYouTube(
        env.config,
        env.owner,
        { video_id: "bZxrIoCPsOc" },
        { ...env.residentOptions, catalog },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
  });
  it("detects corrupted or removed bytes without re-downloading or repairing the account entry", async () => {
    const env = await residentFixture();
    const corrupted = Buffer.from(audio);
    corrupted[100] = (corrupted[100]! + 1) % 256;
    await writeFile(env.cached.vocal_path, corrupted, { mode: 0o600 });
    await expect(
      findResidentAccountYouTube(
        env.config,
        env.owner,
        { video_id: "bZxrIoCPsOc" },
        env.residentOptions,
      ),
    ).resolves.toBeNull();
    await rm(env.cached.vocal_path);
    await expect(
      findResidentAccountYouTube(
        env.config,
        env.owner,
        { video_id: "bZxrIoCPsOc" },
        env.residentOptions,
      ),
    ).resolves.toBeNull();
    expect(env.fetcher).toHaveBeenCalledOnce();
  });
  it.each(["symlink", "hardlink"])(
    "rejects an unsafe %s vocal instead of following it",
    async (kind) => {
      const env = await residentFixture(),
        external = join(env.root, "external.mp3");
      await writeFile(external, audio, { mode: 0o600 });
      await rm(env.cached.vocal_path);
      if (kind === "symlink") await symlink(external, env.cached.vocal_path);
      else await link(external, env.cached.vocal_path);
      await expect(
        findResidentAccountYouTube(
          env.config,
          env.owner,
          { video_id: "bZxrIoCPsOc" },
          env.residentOptions,
        ),
      ).rejects.toThrow("CACHE_UNSAFE");
    },
  );
  it("fences cancellation and a generation change during actual hash validation", async () => {
    const env = await residentFixture();
    let checks = 0;
    const isCurrent = () => ++checks < 2;
    await expect(
      readResidentAccountYouTube(
        env.config.cache_root,
        env.owner,
        { video_id: "bZxrIoCPsOc", duration_seconds: 2 },
        env.cached.cache_key,
        { ...env.residentOptions, isCurrent },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    env.controller.abort();
    await expect(
      findResidentAccountYouTube(
        env.config,
        env.owner,
        { video_id: "bZxrIoCPsOc" },
        env.residentOptions,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
describe("private owner account audio cache", () => {
  it("streams a capability with no bearer, verifies real MP3, publishes private metadata and records the catalog", async () => {
    const env = await fixture();
    const catalog = new DesktopCatalog(
      join(env.root, "catalog"),
      env.config.cache_root,
    );
    const value = await cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      { ...env.options, catalog },
    );
    expect(value.cache_hit).toBe(false);
    expect(value.duration_seconds).toBeGreaterThanOrEqual(2);
    expect(value.duration_seconds).toBeLessThan(2.25);
    expect(value.bytes).toBe(audio.length);
    expect(value.sha256).toBe(createHash("sha256").update(audio).digest("hex"));
    expect(await readFile(value.vocal_path)).toEqual(audio);
    const [, request] = env.fetcher.mock.calls[0]!;
    expect(request?.method).toBe("GET");
    expect(request?.redirect).toBe("error");
    expect(request?.headers).toEqual({
      Accept: "audio/mpeg",
      "Accept-Encoding": "identity",
    });
    const metadata = JSON.parse(
      await readFile(
        join(env.config.cache_root, "vocals", value.cache_key, "result.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      owner_uid: env.scope.firebase_uid,
      account_job_id: env.job.id,
      validation_version: 1,
      trim_enabled: false,
      source: { kind: "youtube", video_id: "bZxrIoCPsOc" },
    });
    expect(JSON.stringify(metadata)).not.toContain("signature");
    expect(JSON.stringify(metadata)).not.toContain(
      env.scope.session_generation,
    );
    expect(metadata.verified_model_sha256).toBeUndefined();
    expect((await stat(value.vocal_path)).mode & 0o077).toBe(0);
    const page = await catalog.list({
      uid: env.scope.firebase_uid,
      session_generation: env.scope.session_generation,
    });
    expect(page.entries[0]).toMatchObject({
      cache_key: value.cache_key,
      job_id: env.job.id,
      trim_enabled: false,
      source_duration_seconds: 2,
    });
    expect(await readdir(join(env.config.cache_root, "pins"))).toHaveLength(1);
    await emptyAttempts(env);
  });
  it("uses a validated warm entry with stable byte/hash checks and no network or repeated media decode", async () => {
    const env = await fixture();
    const cold = await cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      env.options,
    );
    env.fetcher.mockRejectedValue(new Error("network should not run"));
    const warm = await cacheAccountResult(
      {
        ...env.config,
        ffmpeg_path: "/missing/ffmpeg",
        ffprobe_path: "/missing/ffprobe",
      },
      env.scope,
      env.job,
      env.grant,
      env.options,
    );
    expect(warm).toEqual({ ...cold, cache_hit: true });
    expect(env.fetcher).toHaveBeenCalledOnce();
    await emptyAttempts(env);
  });
  it.each(["account", "cancel"])(
    "rolls back newly promoted audio and its catalog after late %s invalidation",
    async (kind) => {
      const env = await fixture();
      const catalog = new DesktopCatalog(
        join(env.root, "catalog"),
        env.config.cache_root,
      );
      const remember = vi.fn(
        async (...args: Parameters<DesktopCatalog["remember"]>) => {
          const entry = await catalog.remember(...args);
          if (kind === "account") env.setCurrent(false);
          else env.controller.abort();
          return entry;
        },
      );
      await expect(
        cacheAccountResult(env.config, env.scope, env.job, env.grant, {
          ...env.options,
          catalog: { remember, discard: catalog.discard.bind(catalog) },
        }),
      ).rejects.toMatchObject({
        code: kind === "account" ? "ACCOUNT_CHANGED" : "CANCELLED",
      });
      expect(remember).toHaveBeenCalledOnce();
      expect(await readdir(join(env.config.cache_root, "vocals"))).toEqual([]);
      expect(
        (
          await catalog.list({
            uid: env.scope.firebase_uid,
            session_generation: env.scope.session_generation,
          })
        ).total,
      ).toBe(0);
      await emptyAttempts(env);
    },
  );
  it("retains a server custom name before acquisition title without changing cache identity", async () => {
    const env = await fixture({ display_name: "My Arabic podcast" });
    const catalog = new DesktopCatalog(
      join(env.root, "catalog"),
      env.config.cache_root,
    );
    const value = await cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      { ...env.options, catalog },
    );
    const manifest = JSON.parse(
      await readFile(
        join(env.config.cache_root, "vocals", value.cache_key, "result.json"),
        "utf8",
      ),
    );
    expect(manifest.source_title).toBe("My Arabic podcast");
    expect(value.cache_key).toBe(accountCacheKey(env.scope, env.job));
    expect(
      await catalog.sourceTitle(
        {
          uid: env.scope.firebase_uid,
          session_generation: env.scope.session_generation,
        },
        value.cache_key,
      ),
    ).toBe("My Arabic podcast");
  });
  it("uses distinct cache namespaces for accounts and server recipe/output identity", async () => {
    const env = await fixture();
    const first = accountCacheKey(env.scope, env.job);
    expect(
      accountCacheKey({ ...env.scope, firebase_uid: "owner-b" }, env.job),
    ).not.toBe(first);
    expect(
      accountCacheKey(env.scope, { ...env.job, recipe_digest: "a".repeat(64) }),
    ).not.toBe(first);
    expect(
      accountCacheKey(env.scope, {
        ...env.job,
        output: {
          ...env.job.output!,
          sha256: Buffer.alloc(32, 2).toString("base64"),
        },
      }),
    ).not.toBe(first);
  });
  it("repairs unpinned corruption through a fresh verified download without claiming a warm hit", async () => {
    const env = await fixture();
    const first = await cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      env.options,
    );
    await clearHandoffs(env);
    await writeFile(first.vocal_path, Buffer.alloc(audio.length), {
      mode: 0o600,
    });
    const repaired = await cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      env.options,
    );
    expect(repaired.cache_hit).toBe(false);
    expect(env.fetcher).toHaveBeenCalledTimes(2);
    expect(await readFile(first.vocal_path)).toEqual(audio);
  });
  it("preserves a pinned corrupt entry and does not download or replace it", async () => {
    const env = await fixture();
    const first = await cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      env.options,
    );
    await writeFile(first.vocal_path, Buffer.alloc(audio.length), {
      mode: 0o600,
    });
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        env.grant,
        env.options,
      ),
    ).rejects.toMatchObject({ code: "CACHE_CORRUPT_PINNED" });
    expect(env.fetcher).toHaveBeenCalledOnce();
    expect((await readFile(first.vocal_path))[0]).toBe(0);
  });
  it("permits standalone trimmed results and stores actual vocals duration apart from the original timeline", async () => {
    const env = await fixture({
      source_kind: "file",
      source_url: null,
      trim_enabled: true,
      recipe_digest: "a".repeat(64),
    });
    env.job = { ...env.job, input: { ...env.job.input, duration_seconds: 20 } };
    const catalog = new DesktopCatalog(
      join(env.root, "catalog"),
      env.config.cache_root,
    );
    const value = await cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      { ...env.options, catalog },
    );
    expect(value.trim_enabled).toBe(true);
    expect(value.source_duration_seconds).toBe(20);
    expect(value.duration_seconds).toBeLessThan(2.25);
    const entries = (
      await catalog.list({
        uid: env.scope.firebase_uid,
        session_generation: env.scope.session_generation,
      })
    ).entries;
    expect(entries[0]).toMatchObject({
      trim_enabled: true,
      source_duration_seconds: 20,
    });
    expect(entries[0]?.video_id).toBeUndefined();
  });
  it.each([
    "https://evil.example/private?token=secret",
    "http://abc.r2.cloudflarestorage.com/media",
    "https://user:secret@abc.r2.cloudflarestorage.com/media",
  ])("rejects unsafe grant %s before transfer", async (url) => {
    const env = await fixture();
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        { ...env.grant, url },
        env.options,
      ),
    ).rejects.toMatchObject({ code: "DOWNLOAD_GRANT_INVALID" });
    expect(env.fetcher).not.toHaveBeenCalled();
  });
  it.each(["text/html", "application/octet-stream"])(
    "rejects unexpected media type %s",
    async (type) => {
      const env = await fixture();
      env.fetcher.mockResolvedValue(
        new Response(new Uint8Array(audio), {
          headers: { "content-type": type },
        }),
      );
      await expect(
        cacheAccountResult(
          env.config,
          env.scope,
          env.job,
          env.grant,
          env.options,
        ),
      ).rejects.toMatchObject({ code: "ACCOUNT_DOWNLOAD_INVALID" });
      await emptyAttempts(env);
    },
  );
  it("refuses redirect responses and never follows signed capabilities to another host", async () => {
    const env = await fixture();
    env.fetcher.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/private" },
      }),
    );
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        env.grant,
        env.options,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_DOWNLOAD_INVALID" });
    expect(env.fetcher).toHaveBeenCalledOnce();
    await emptyAttempts(env);
  });
  it.each(["header", "truncated", "oversized"])(
    "bounds actual received bytes for %s lengths",
    async (kind) => {
      const env = await fixture();
      const body =
        kind === "truncated"
          ? audio.subarray(0, audio.length - 1)
          : kind === "oversized"
            ? Buffer.concat([audio, Buffer.from("extra")])
            : audio;
      env.fetcher.mockResolvedValue(
        new Response(new Uint8Array(body), {
          headers: {
            "content-type": "audio/mpeg",
            ...(kind === "header"
              ? { "content-length": String(audio.length + 1) }
              : {}),
          },
        }),
      );
      await expect(
        cacheAccountResult(
          env.config,
          env.scope,
          env.job,
          env.grant,
          env.options,
        ),
      ).rejects.toMatchObject({ code: "ACCOUNT_DOWNLOAD_LENGTH_MISMATCH" });
      await emptyAttempts(env);
    },
  );
  it("validates a lengthless stream against the authoritative bytes/hash", async () => {
    const env = await fixture();
    env.fetcher.mockResolvedValue(
      new Response(new Uint8Array(audio), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    expect(
      (
        await cacheAccountResult(
          env.config,
          env.scope,
          env.job,
          env.grant,
          env.options,
        )
      ).bytes,
    ).toBe(audio.length);
  });
  it("rejects mismatched checksums and invalid codec bytes even if the declaration matches the bytes", async () => {
    const env = await fixture();
    env.job = {
      ...env.job,
      output: {
        ...env.job.output!,
        sha256: Buffer.alloc(32, 3).toString("base64"),
      },
    };
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        env.grant,
        env.options,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_DOWNLOAD_CHECKSUM_MISMATCH" });
    await emptyAttempts(env);
    const invalid = await fixture(
      {},
      Buffer.from("server-declared but not audio"),
    );
    await expect(
      cacheAccountResult(
        invalid.config,
        invalid.scope,
        invalid.job,
        invalid.grant,
        invalid.options,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_AUDIO_INVALID" });
    await emptyAttempts(invalid);
  });
  it("rejects actual untrimmed timeline mismatch before publishing", async () => {
    const env = await fixture();
    env.job = { ...env.job, input: { ...env.job.input, duration_seconds: 20 } };
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        env.grant,
        env.options,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_AUDIO_INVALID" });
    expect(await readdir(join(env.config.cache_root, "vocals"))).toEqual([]);
    await emptyAttempts(env);
  });
  it("fences an account switch during response receipt, cancels the unread body and removes owned staging", async () => {
    const env = await fixture();
    const cancelled = vi.fn();
    env.fetcher.mockImplementation(async () => {
      env.setCurrent(false);
      return new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { "content-type": "audio/mpeg" },
      });
    });
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        env.grant,
        env.options,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await readdir(join(env.config.cache_root, "vocals"))).toEqual([]);
    await emptyAttempts(env);
  });
  it("cancels an active stalled stream without leaving a mutation lease or temporary audio", async () => {
    const env = await fixture();
    const cancelled = vi.fn();
    let pulled: () => void = () => {};
    const pull = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    env.fetcher.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            pulled();
          },
          cancel: cancelled,
        }),
        { headers: { "content-type": "audio/mpeg" } },
      ),
    );
    const result = cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      env.options,
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await pull;
    await vi.waitFor(() => expect(env.fetcher).toHaveBeenCalledOnce());
    env.controller.abort();
    await rejection;
    expect(cancelled).toHaveBeenCalledOnce();
    await emptyAttempts(env);
  });
  it("honors pinned aggregate budget and counts result metadata against the final limit", async () => {
    const env = await fixture();
    const pinned = "a".repeat(64);
    const directory = join(env.config.cache_root, "vocals", pinned);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "vocals.mp3"), Buffer.alloc(audio.length), {
      mode: 0o600,
    });
    await writeFile(join(directory, "result.json"), "{}", { mode: 0o600 });
    await expect(
      cacheAccountResult(env.config, env.scope, env.job, env.grant, {
        ...env.options,
        pinnedCacheKeys: new Set([pinned]),
        offline_bytes_limit: audio.length + 2,
      }),
    ).rejects.toMatchObject({ code: "OFFLINE_CACHE_FULL" });
    expect(env.fetcher).not.toHaveBeenCalled();
    expect(await stat(directory)).toBeDefined();
    const exact = await fixture();
    await expect(
      cacheAccountResult(exact.config, exact.scope, exact.job, exact.grant, {
        ...exact.options,
        offline_bytes_limit: audio.length,
      }),
    ).rejects.toMatchObject({ code: "OFFLINE_CACHE_FULL" });
    expect(await readdir(join(exact.config.cache_root, "vocals"))).toEqual([]);
    await emptyAttempts(exact);
  });
  it("refuses symlink/hardlink contamination and never mutates a foreign target", async () => {
    const env = await fixture();
    const target = join(
      env.config.cache_root,
      "vocals",
      accountCacheKey(env.scope, env.job),
    );
    await mkdir(join(env.config.cache_root, "vocals"), {
      recursive: true,
      mode: 0o700,
    });
    const foreign = join(env.root, "foreign");
    await mkdir(foreign, { mode: 0o700 });
    await symlink(foreign, target);
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        env.grant,
        env.options,
      ),
    ).rejects.toMatchObject({ code: "CACHE_UNSAFE" });
    expect(env.fetcher).not.toHaveBeenCalled();
    expect(await readdir(foreign)).toEqual([]);
    const linked = await fixture();
    const result = await cacheAccountResult(
      linked.config,
      linked.scope,
      linked.job,
      linked.grant,
      linked.options,
    );
    await link(result.vocal_path, join(linked.root, "other-link"));
    await expect(
      cacheAccountResult(
        linked.config,
        linked.scope,
        linked.job,
        linked.grant,
        linked.options,
      ),
    ).rejects.toMatchObject({ code: "CACHE_UNSAFE" });
  });
  it("retains only stable error codes when a transfer throws private exception text", async () => {
    const env = await fixture();
    env.fetcher.mockRejectedValue(new Error("private URL and credentials"));
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        env.grant,
        env.options,
      ),
    ).rejects.toMatchObject({ message: "ACCOUNT_DOWNLOAD_UNAVAILABLE" });
    await emptyAttempts(env);
  });
  it("recovers only marked dead-process staging and leaves unmarked work intact", async () => {
    const env = await fixture();
    const nonce = randomUUID();
    const jobs = join(env.config.cache_root, "jobs");
    const stale = join(jobs, `account-${nonce}`);
    await mkdir(stale, { recursive: true, mode: 0o700 });
    await writeFile(join(stale, "vocals.mp3"), "partial download", {
      mode: 0o600,
    });
    await writeFile(
      join(jobs, `.account-${nonce}.json`),
      JSON.stringify({
        version: 1,
        nonce,
        pid: 99_999_999,
        owner_uid: env.scope.firebase_uid,
        job_id: env.job.id,
      }),
      { mode: 0o600 },
    );
    const unmarked = join(jobs, `account-${randomUUID()}`);
    await mkdir(unmarked, { mode: 0o700 });
    await writeFile(join(unmarked, "private-note.txt"), "preserve", {
      mode: 0o600,
    });
    await cacheAccountResult(
      env.config,
      env.scope,
      env.job,
      env.grant,
      env.options,
    );
    expect(await readdir(jobs)).toEqual([unmarked.split("/").at(-1)]);
    expect(await readFile(join(unmarked, "private-note.txt"), "utf8")).toBe(
      "preserve",
    );
  });
  it("preserves suspicious children in a marked stale folder and refuses unsafe recovery", async () => {
    const env = await fixture();
    const nonce = randomUUID();
    const jobs = join(env.config.cache_root, "jobs");
    const stale = join(jobs, `account-${nonce}`);
    await mkdir(stale, { recursive: true, mode: 0o700 });
    await writeFile(join(stale, "foreign.txt"), "preserve", { mode: 0o600 });
    await writeFile(
      join(jobs, `.account-${nonce}.json`),
      JSON.stringify({
        version: 1,
        nonce,
        pid: 99_999_999,
        owner_uid: env.scope.firebase_uid,
        job_id: env.job.id,
      }),
      { mode: 0o600 },
    );
    await expect(
      cacheAccountResult(
        env.config,
        env.scope,
        env.job,
        env.grant,
        env.options,
      ),
    ).rejects.toMatchObject({ code: "CACHE_UNSAFE" });
    expect(env.fetcher).not.toHaveBeenCalled();
    expect(await readFile(join(stale, "foreign.txt"), "utf8")).toBe("preserve");
  });
});
