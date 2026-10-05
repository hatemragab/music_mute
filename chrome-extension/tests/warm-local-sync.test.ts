import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localCacheKey } from "../src/companion/jobs.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";
import { LocalSyncCaptureQueue } from "../src/companion/local-sync-capture.js";
import { LocalSyncOutbox } from "../src/companion/sync-outbox.js";
import { prepareOneWarmCapture } from "../src/companion/warm-local-sync.js";
import type { LocalConfig } from "../src/companion/config.js";
import type { PreparedAudio } from "../src/shared/protocol.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-warm-save-"));
  roots.push(root);
  const config: LocalConfig = {
    root,
    cache_root: join(root, "cache"),
    logs_root: join(root, "logs"),
    models_root: join(root, "models"),
    python_path: "/usr/bin/false",
    node_path: process.execPath,
    ffmpeg_path: "/usr/bin/false",
    ffprobe_path: "/usr/bin/false",
    yt_dlp_path: "/usr/bin/false",
    js_runtime_path: process.execPath,
    engine_root: root,
    runner_path: join(root, "must-not-run.py"),
  };
  const owner = { uid: "account-a", session_generation: randomUUID() };
  const video_id = "abcdefghijk";
  const cache_key = localCacheKey({
    video_id,
    provider: "LOCAL_MACOS",
    duration_seconds: 5,
  });
  const cache = join(config.cache_root, "vocals", cache_key);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await writeFile(join(cache, "vocals.mp3"), "fixture vocal", { mode: 0o600 });
  const audio: PreparedAudio = {
    output_path: join(cache, "vocals.mp3"),
    source_duration_seconds: 5,
    duration_seconds: 5,
    bytes: 13,
    sha256: sha("fixture vocal"),
    model_id: MODEL_SHA256,
    trim_enabled: false,
    timings_ms: {},
    original_declaration: {
      extension: "m4a",
      content_type: "audio/mp4",
      duration_seconds: 5,
      bytes: 4,
      sha256: sha("same"),
    },
    source: {
      kind: "youtube",
      video_id,
      format_id: "140",
      audio_track_id: null,
      audio_is_default: null,
      language: null,
    },
  };
  await writeFile(join(cache, "result.json"), JSON.stringify(audio), {
    mode: 0o600,
  });
  const queue = new LocalSyncCaptureQueue(
    join(root, "sync-captures"),
    config.cache_root,
  );
  const outbox = new LocalSyncOutbox(
    join(root, "sync-outbox"),
    config.cache_root,
  );
  const ticket = await queue.stage({
    owner,
    request_id: randomUUID(),
    cache_key,
    video_id,
  });
  const acquire = vi.fn().mockImplementation(async (_request, work: string) => {
    await writeFile(join(work, "source.m4a"), "same", { mode: 0o600 });
    return {
      original: {
        ...audio.original_declaration!,
        path: join(work, "source.m4a"),
      },
      source: audio.source!,
      timings_ms: {},
    };
  });
  const dependencies = {
    verifyCurrent: vi.fn().mockResolvedValue(undefined),
    hooks: {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onDiagnostic: vi.fn(),
    },
    acquire,
  };
  return {
    root,
    config,
    owner,
    cache,
    audio,
    queue,
    outbox,
    ticket,
    acquire,
    dependencies,
  };
}

describe("background saving of a reused public YouTube voice", () => {
  it("recovers only matching original bytes and stages a pair without running inference", async () => {
    const e = await fixture();
    expect(
      await prepareOneWarmCapture(
        e.config,
        e.owner,
        e.queue,
        e.outbox,
        e.dependencies,
      ),
    ).toEqual([]);
    expect(e.acquire).toHaveBeenCalledOnce();
    const [pair] = await e.outbox.list(e.owner);
    expect(pair).toMatchObject({
      request_id: e.ticket.request_id,
      cache_key: e.ticket.cache_key,
      state: "pending",
    });
    expect(await readFile(pair!.original.path, "utf8")).toBe("same");
    expect(await e.queue.pinnedCacheKeys()).toEqual(new Set());
    expect(await e.outbox.pinnedCacheKeys()).toEqual(
      new Set([e.ticket.cache_key]),
    );
    expect(
      await readdir(join(e.config.cache_root, "capture-attempts")),
    ).toEqual([]);
    expect((await e.queue.list(e.owner))[0]!.state).toBe("completed");
  });
  it("keeps legacy vocals playable and refuses to invent their original identity", async () => {
    const e = await fixture();
    delete e.audio.original_declaration;
    await writeFile(join(e.cache, "result.json"), JSON.stringify(e.audio), {
      mode: 0o600,
    });
    expect(
      await prepareOneWarmCapture(
        e.config,
        e.owner,
        e.queue,
        e.outbox,
        e.dependencies,
      ),
    ).toMatchObject([
      {
        state: "rejected",
        error_code: "CAPTURE_SOURCE_UNAVAILABLE",
        cache_key: e.ticket.cache_key,
      },
    ]);
    expect(e.acquire).not.toHaveBeenCalled();
    expect(await readFile(e.audio.output_path, "utf8")).toBe("fixture vocal");
    expect(await e.outbox.list(e.owner)).toEqual([]);
  });
  it("rejects changed source bytes while leaving retained vocals available", async () => {
    const e = await fixture();
    e.acquire.mockImplementation(async (_request, work: string) => {
      await writeFile(join(work, "source.m4a"), "diff", { mode: 0o600 });
      return {
        original: {
          ...e.audio.original_declaration!,
          sha256: sha("diff"),
          path: join(work, "source.m4a"),
        },
        source: e.audio.source!,
        timings_ms: {},
      };
    });
    expect(
      await prepareOneWarmCapture(
        e.config,
        e.owner,
        e.queue,
        e.outbox,
        e.dependencies,
      ),
    ).toMatchObject([
      { state: "rejected", error_code: "CAPTURE_SOURCE_CHANGED" },
    ]);
    expect(await e.outbox.list(e.owner)).toEqual([]);
    expect(await readFile(e.audio.output_path, "utf8")).toBe("fixture vocal");
    expect(await e.queue.pinnedCacheKeys()).toEqual(new Set());
  });
  it("fences account changes after acquisition and permits a same-owner restart", async () => {
    const e = await fixture();
    e.dependencies.verifyCurrent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ACCOUNT_CHANGED"));
    expect(
      await prepareOneWarmCapture(
        e.config,
        e.owner,
        e.queue,
        e.outbox,
        e.dependencies,
      ),
    ).toMatchObject([{ state: "deferred", error_code: "ACCOUNT_CHANGED" }]);
    expect(await e.outbox.list(e.owner)).toEqual([]);
    expect(
      await e.queue.list({
        uid: "account-b",
        session_generation: randomUUID(),
      }),
    ).toEqual([]);
    const restored = { ...e.owner, session_generation: randomUUID() };
    await prepareOneWarmCapture(
      e.config,
      restored,
      e.queue,
      e.outbox,
      e.dependencies,
    );
    expect((await e.outbox.list(restored))[0]!.owner.uid).toBe(e.owner.uid);
  });
  it("reconciles an already published pair without downloading its original twice", async () => {
    const e = await fixture();
    const original = join(e.config.cache_root, "existing.m4a");
    await writeFile(original, "same", { mode: 0o600 });
    await e.outbox.stage({
      owner: e.owner,
      request_id: e.ticket.request_id,
      cache_key: e.ticket.cache_key,
      original: { ...e.audio.original_declaration!, path: original },
      vocals: {
        path: e.audio.output_path,
        extension: "mp3",
        content_type: "audio/mpeg",
        duration_seconds: 5,
        bytes: 13,
        sha256: e.audio.sha256,
      },
      source: e.audio.source!,
    });
    await prepareOneWarmCapture(
      e.config,
      e.owner,
      e.queue,
      e.outbox,
      e.dependencies,
    );
    expect(e.acquire).not.toHaveBeenCalled();
    expect((await e.queue.list(e.owner))[0]!.state).toBe("completed");
    expect((await e.outbox.list(e.owner)).length).toBe(1);
  });
});
