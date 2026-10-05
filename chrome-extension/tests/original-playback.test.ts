import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FULL_TIMELINE_PROFILE_ID,
  FULL_TIMELINE_RECIPE_DIGEST,
} from "../src/companion/cloud-provider.js";
import { DesktopApiError } from "../src/companion/account-api.js";
import type { LocalConfig } from "../src/companion/config.js";
import { prepareOriginalPlayback } from "../src/companion/original-playback.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(options: { grantFailures?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-original-"));
  roots.push(root);
  const cache = join(root, "cache");
  await mkdir(cache, { mode: 0o700 });
  const source = Buffer.from("synthetic webm input");
  const id = "0123456789abcdef01234567";
  const config: LocalConfig = {
    root,
    cache_root: cache,
    logs_root: join(root, "logs"),
    models_root: join(root, "models"),
    python_path: "/fixture/python",
    node_path: "/fixture/node",
    ffmpeg_path: "/fixture/ffmpeg",
    ffprobe_path: "/fixture/ffprobe",
    yt_dlp_path: "/fixture/yt-dlp",
    js_runtime_path: "/fixture/deno",
    engine_root: join(root, "engine"),
    runner_path: join(root, "runner.py"),
  };
  const job = {
    id,
    request_id: randomUUID(),
    status: "ready",
    processing_origin: "local_device",
    source_url: "https://www.youtube.com/watch?v=abcdefghijk",
    source_kind: "url",
    source_title: "Fixture video",
    display_name: null,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    local_profile_id: FULL_TIMELINE_PROFILE_ID,
    trim_enabled: false,
    input: {
      extension: "webm",
      content_type: "audio/webm",
      bytes: source.length,
      duration_seconds: 135.5,
      sha256: createHash("sha256").update(source).digest("base64"),
    },
    output: {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: 20,
      duration_seconds: 135.5,
      sha256: Buffer.alloc(32, 4).toString("base64"),
    },
    can_download_input: true,
    can_download_output: true,
    error: null,
  };
  const grantBodies: unknown[] = [];
  let grantAttempt = 0;
  const api = {
    request: vi.fn(
      async (_scope, path: string, method: string, body?: unknown) => {
        if (method === "GET" && path === `/jobs/${id}`) return job;
        if (method === "POST" && path === `/jobs/${id}/download-grants`) {
          grantBodies.push(body);
          const failure = options.grantFailures?.[grantAttempt++];
          if (failure) throw new DesktopApiError(failure);
          return {
            url: "https://fixture.r2.cloudflarestorage.com/original",
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          };
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      },
    ),
  };
  const fetcher = vi.fn(
    async () =>
      new Response(source, {
        status: 200,
        headers: {
          "content-type": "audio/webm",
          "content-length": String(source.length),
          "content-encoding": "identity",
        },
      }),
  );
  const transcode = vi.fn(async (input: string, output: string) => {
    expect(await readFile(input)).toEqual(source);
    await writeFile(output, Buffer.from("synthetic compatible m4a"), {
      mode: 0o600,
    });
  });
  const probe = vi.fn(async () => 135.5);
  return {
    config,
    source,
    id,
    job,
    api,
    grantBodies,
    fetcher,
    transcode,
    probe,
  };
}

const accountScope = () => ({
  firebase_uid: "owner-a",
  session_generation: randomUUID(),
});

function playbackDependencies(env: Awaited<ReturnType<typeof fixture>>) {
  return {
    fetcher: env.fetcher as unknown as typeof fetch,
    transcode: env.transcode,
    probe: env.probe,
  };
}

async function persistedGrant(config: LocalConfig, owner = "owner-a") {
  const accountRoot = join(
    config.cache_root,
    "original-playback",
    createHash("sha256").update(owner).digest("hex"),
  );
  const names = (await readdir(accountRoot)).filter((name) =>
    name.endsWith(".grant.json"),
  );
  expect(names).toHaveLength(1);
  const path = join(accountRoot, names[0]!);
  return {
    path,
    names,
    record: JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>,
    mode: (await stat(path)).mode & 0o777,
  };
}

describe("account original playback cache", () => {
  it("downloads and prepares WebM once, then returns isolated compatible playback leases", async () => {
    const env = await fixture();
    const scope = {
      firebase_uid: "owner-a",
      session_generation: randomUUID(),
    };
    const dependencies = playbackDependencies(env);
    const first = await prepareOriginalPlayback(
      env.config,
      env.api,
      scope,
      env.id,
      new AbortController().signal,
      dependencies,
    );
    const second = await prepareOriginalPlayback(
      env.config,
      env.api,
      scope,
      env.id,
      new AbortController().signal,
      dependencies,
    );
    expect(first).toMatchObject({ duration_seconds: 135.5, cache_hit: false });
    expect(second).toMatchObject({ duration_seconds: 135.5, cache_hit: true });
    expect(second.original_path).not.toBe(first.original_path);
    expect(await readFile(first.original_path, "utf8")).toBe(
      "synthetic compatible m4a",
    );
    expect(env.api.request).toHaveBeenCalledTimes(3);
    expect(env.fetcher).toHaveBeenCalledOnce();
    expect(env.transcode).toHaveBeenCalledOnce();
    expect(env.probe).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched download before transcoding or publication", async () => {
    const env = await fixture();
    env.fetcher.mockResolvedValueOnce(
      new Response(Buffer.from("wrong bytes, same length"), {
        status: 200,
        headers: { "content-type": "audio/webm" },
      }),
    );
    await expect(
      prepareOriginalPlayback(
        env.config,
        env.api,
        { firebase_uid: "owner-a", session_generation: randomUUID() },
        env.id,
        new AbortController().signal,
        {
          fetcher: env.fetcher as unknown as typeof fetch,
          transcode: env.transcode,
          probe: env.probe,
        },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_DOWNLOAD_INVALID" });
    expect(env.transcode).not.toHaveBeenCalled();
  });

  it("keeps prepared originals isolated by account owner", async () => {
    const env = await fixture();
    const dependencies = playbackDependencies(env);
    for (const owner of ["owner-a", "owner-b"])
      await prepareOriginalPlayback(
        env.config,
        env.api,
        { firebase_uid: owner, session_generation: randomUUID() },
        env.id,
        new AbortController().signal,
        dependencies,
      );
    expect(env.fetcher).toHaveBeenCalledTimes(2);
    expect(env.transcode).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an uncertain grant response", "API_UNAVAILABLE"],
    ["a failed media transfer", "ACCOUNT_DOWNLOAD_UNAVAILABLE"],
  ])(
    "reuses a private persisted request ID after %s",
    async (failure, code) => {
      const env = await fixture({
        grantFailures: failure === "an uncertain grant response" ? [code] : [],
      });
      if (failure === "a failed media transfer")
        env.fetcher.mockRejectedValueOnce(
          new Error("synthetic network failure"),
        );
      const scope = accountScope();
      await expect(
        prepareOriginalPlayback(
          env.config,
          env.api,
          scope,
          env.id,
          new AbortController().signal,
          playbackDependencies(env),
        ),
      ).rejects.toMatchObject({ code });

      const pending = await persistedGrant(env.config);
      expect(pending.mode).toBe(0o600);
      expect(Object.keys(pending.record).sort()).toEqual([
        "expires_at",
        "input_sha256",
        "job_id",
        "request_id",
        "version",
      ]);
      expect(JSON.stringify(pending.record)).not.toContain(
        "cloudflarestorage.com",
      );

      await prepareOriginalPlayback(
        env.config,
        env.api,
        scope,
        env.id,
        new AbortController().signal,
        playbackDependencies(env),
      );
      const requestIds = env.grantBodies.map(
        (body) => (body as { request_id: string }).request_id,
      );
      expect(requestIds).toHaveLength(2);
      expect(requestIds[1]).toBe(requestIds[0]);
      expect(
        (await readdir(join(pending.path, ".."))).filter((name) =>
          name.endsWith(".grant.json"),
        ),
      ).toEqual([]);
    },
  );

  it("rotates the request ID after the backend confirms the prior reservation expired", async () => {
    const env = await fixture({
      grantFailures: ["DOWNLOAD_RESERVATION_EXPIRED"],
    });
    await prepareOriginalPlayback(
      env.config,
      env.api,
      accountScope(),
      env.id,
      new AbortController().signal,
      playbackDependencies(env),
    );
    const requestIds = env.grantBodies.map(
      (body) => (body as { request_id: string }).request_id,
    );
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });

  it("uses fail-fast decoding before FFmpeg reads the original", async () => {
    const env = await fixture();
    const argumentsPath = join(env.config.root, "ffmpeg-arguments.txt");
    const ffmpeg = join(env.config.root, "synthetic-ffmpeg");
    await writeFile(
      ffmpeg,
      [
        "#!/bin/sh",
        "set -eu",
        "umask 077",
        `printf '%s\\n' "$@" > '${argumentsPath}'`,
        'for argument in "$@"; do last="$argument"; done',
        `printf '%s' 'synthetic compatible m4a' > "$last"`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(ffmpeg, 0o700);
    env.config.ffmpeg_path = ffmpeg;

    await prepareOriginalPlayback(
      env.config,
      env.api,
      accountScope(),
      env.id,
      new AbortController().signal,
      {
        fetcher: env.fetcher as unknown as typeof fetch,
        probe: env.probe,
      },
    );
    const args = (await readFile(argumentsPath, "utf8")).trim().split("\n");
    expect(args.slice(0, 6)).toEqual([
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
    ]);
    expect(args.indexOf("-xerror")).toBeLessThan(args.indexOf("-i"));
  });

  it("prunes stale playback leases before enforcing the live lease limit", async () => {
    const env = await fixture();
    const leases = join(env.config.cache_root, "original-playback", "leases");
    await mkdir(leases, { recursive: true, mode: 0o700 });
    const stale = new Date(Date.now() - 3 * 60 * 60_000);
    await Promise.all(
      Array.from({ length: 129 }, async () => {
        const path = join(leases, `${randomUUID()}.m4a`);
        await writeFile(path, "stale", { mode: 0o600 });
        await utimes(path, stale, stale);
      }),
    );

    const result = await prepareOriginalPlayback(
      env.config,
      env.api,
      accountScope(),
      env.id,
      new AbortController().signal,
      playbackDependencies(env),
    );
    expect(await readdir(leases)).toEqual([
      result.original_path.split("/").at(-1),
    ]);
  });

  it("refuses to create a 129th live playback lease", async () => {
    const env = await fixture();
    const dependencies = playbackDependencies(env);
    await prepareOriginalPlayback(
      env.config,
      env.api,
      accountScope(),
      env.id,
      new AbortController().signal,
      dependencies,
    );
    const leases = join(env.config.cache_root, "original-playback", "leases");
    for (let count = (await readdir(leases)).length; count < 128; count++)
      await writeFile(join(leases, `${randomUUID()}.m4a`), "live", {
        mode: 0o600,
      });

    await expect(
      prepareOriginalPlayback(
        env.config,
        env.api,
        accountScope(),
        env.id,
        new AbortController().signal,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "ORIGINAL_CACHE_FULL" });
    expect(await readdir(leases)).toHaveLength(128);
  });
});
