import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareDesktopFile,
  recoverDesktopFileStages,
  FileLocalProvider,
} from "../src/companion/file-provider.js";
import type { LocalConfig } from "../src/companion/config.js";
import { preserveLocalPairRecovery } from "../src/companion/sync-outbox.js";
const roots: string[] = [];
async function explicitExternalRuntimeTools(): Promise<string | undefined> {
  const setting = process.env.MUSICMUTE_LOCAL_RUNTIME;
  if (setting === undefined) return undefined;
  if (!isAbsolute(setting))
    throw new Error("MUSICMUTE_LOCAL_RUNTIME_MUST_BE_ABSOLUTE");
  const resolved = await realpath(setting);
  const information = await lstat(setting);
  if (
    resolved !== setting ||
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    information.uid !== process.getuid?.() ||
    information.mode & 0o022
  )
    throw new Error("MUSICMUTE_LOCAL_RUNTIME_UNSAFE");
  const tools = join(resolved, "runtime/bin");
  await Promise.all([
    access(join(tools, "ffmpeg")),
    access(join(tools, "ffprobe")),
  ]);
  return tools;
}
const tools = await explicitExternalRuntimeTools();
const available = tools !== undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function wav(duration = 1) {
  const samples = Math.floor(16000 * duration),
    data = Buffer.alloc(samples * 2),
    header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-file-"));
  roots.push(root);
  const config: LocalConfig = {
    root,
    cache_root: join(root, "cache"),
    logs_root: join(root, "logs"),
    models_root: join(root, "models"),
    python_path: "/usr/bin/true",
    node_path: process.execPath,
    ffmpeg_path: tools ? join(tools, "ffmpeg") : "/usr/bin/false",
    ffprobe_path: tools ? join(tools, "ffprobe") : "/usr/bin/false",
    yt_dlp_path: "/usr/bin/true",
    js_runtime_path: process.execPath,
    engine_root: root,
    runner_path: "/usr/bin/true",
  };
  const input = join(root, "selected.wav");
  await writeFile(input, wav());
  return { root, config, input };
}
async function staged(
  config: LocalConfig,
  options: {
    pid?: number;
    files?: Record<string, string>;
    foreign?: boolean;
  } = {},
) {
  const id = randomUUID(),
    root = join(config.cache_root, "jobs", id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!options.foreign)
    await writeFile(
      join(root, "desktop-file-staging.json"),
      JSON.stringify({
        version: 1,
        pid: options.pid ?? 2_147_483_647,
        stage_id: id,
        selected_extension: "wav",
      }),
      { mode: 0o600 },
    );
  for (const [name, bytes] of Object.entries(
    options.files ?? { "selected.wav": "private staged audio" },
  ))
    await writeFile(join(root, name), bytes, { mode: 0o600 });
  return root;
}
describe("owned selected-file staging recovery", () => {
  it("cleans a dead canonical pre-ticket rename while preserving live work and a complete sync recovery ticket", async () => {
    const e = await fixture(),
      dead = await staged(e.config, { files: { "source.wav": "owned copy" } }),
      live = await staged(e.config, {
        pid: process.pid,
        files: { "source.wav": "live copy" },
      }),
      recovery = await staged(e.config, {
        files: { "source.wav": "recoverable original" },
      }),
      cacheKey = createHash("sha256").update("fixture cache").digest("hex"),
      vocal = join(e.config.cache_root, "vocals", cacheKey, "vocals.mp3");
    await mkdir(join(e.config.cache_root, "vocals", cacheKey), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(vocal, "fixture vocal", { mode: 0o600 });
    await preserveLocalPairRecovery(e.config.cache_root, {
      owner: { uid: "file-owner", session_generation: randomUUID() },
      request_id: basename(recovery),
      cache_key: cacheKey,
      original: {
        path: join(recovery, "source.wav"),
        extension: "wav",
        content_type: "audio/wav",
        bytes: Buffer.byteLength("recoverable original"),
        sha256: createHash("sha256")
          .update("recoverable original")
          .digest("hex"),
        duration_seconds: 1,
      },
      vocals: {
        path: vocal,
        extension: "mp3",
        content_type: "audio/mpeg",
        bytes: 13,
        sha256: createHash("sha256").update("fixture vocal").digest("hex"),
        duration_seconds: 1,
      },
    });
    const original = await readFile(e.input),
      ticket = await readFile(join(recovery, "local-sync-recovery.json"));
    expect(await recoverDesktopFileStages(e.config.cache_root)).toEqual({
      removed: 1,
      bytes: Buffer.byteLength("owned copy"),
    });
    await expect(lstat(dead)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(live, "source.wav"), "utf8")).toBe("live copy");
    expect(await readFile(join(recovery, "source.wav"), "utf8")).toBe(
      "recoverable original",
    );
    expect(await readFile(join(recovery, "local-sync-recovery.json"))).toEqual(
      ticket,
    );
    expect(await readFile(e.input)).toEqual(original);
  });

  it("refuses a canonical source extension not declared by its strict private staging marker", async () => {
    const e = await fixture(),
      root = await staged(e.config, {
        files: { "source.mp3": "foreign file" },
      });
    await expect(
      recoverDesktopFileStages(e.config.cache_root),
    ).rejects.toMatchObject({ code: "FILE_STAGING_UNSAFE" });
    expect(await readFile(join(root, "source.mp3"), "utf8")).toBe(
      "foreign file",
    );
    expect(await readFile(e.input)).toEqual(wav());
  });

  it("refuses a changed private source before inference instead of caching it under an earlier digest", async () => {
    const e = await fixture(),
      root = await staged(e.config, { pid: process.pid }),
      path = join(root, "selected.wav"),
      bytes = wav();
    await writeFile(path, bytes, { mode: 0o600 });
    const source = {
      root,
      input_path: path,
      extension: "wav",
      content_type: "audio/wav",
      duration_seconds: 1,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const provider = new FileLocalProvider(e.config, source);
    const changed = Buffer.from(bytes);
    changed[100] = 1;
    source.sha256 = createHash("sha256").update(changed).digest("hex");
    await writeFile(path, changed, { mode: 0o600 });
    const work = join(e.config.cache_root, "jobs", randomUUID());
    await mkdir(work, { mode: 0o700 });
    await expect(
      provider.prepare(
        {
          video_id: "abcdefghijk",
          duration_seconds: 1,
          provider: "LOCAL_MACOS",
        },
        work,
        {
          signal: new AbortController().signal,
          onProgress: vi.fn(),
          onDiagnostic: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
    expect(await readFile(e.input)).toEqual(bytes);
  });
  it("removes only dead owned staging including a cloud normalization crash without touching the selected source", async () => {
    const e = await fixture(),
      original = await readFile(e.input);
    const path = await staged(e.config, {
      files: { "selected.wav": "copy", "cloud.m4a": "normalized" },
    });
    expect(await recoverDesktopFileStages(e.config.cache_root)).toEqual({
      removed: 1,
      bytes: 14,
    });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(e.input)).toEqual(original);
    expect(await recoverDesktopFileStages(e.config.cache_root)).toEqual({
      removed: 0,
      bytes: 0,
    });
  });
  it("preserves live owners regardless of age, unmarked foreign work and synchronization recovery tickets", async () => {
    const e = await fixture();
    const live = await staged(e.config, { pid: process.pid });
    await utimes(live, 1, 1);
    const foreign = await staged(e.config, {
      foreign: true,
      files: { "keep.txt": "user data" },
    });
    const recovery = await staged(e.config, {
      files: {
        "source.wav": "sync original",
        "local-sync-recovery.json": "{}",
      },
    });
    const partial = await staged(e.config, {
      files: {
        "source.wav": "sync original",
        [`.local-sync-${randomUUID()}.tmp`]: "{}",
      },
    });
    expect(await recoverDesktopFileStages(e.config.cache_root)).toEqual({
      removed: 0,
      bytes: 0,
    });
    expect(await readFile(join(live, "selected.wav"), "utf8")).toBe(
      "private staged audio",
    );
    expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe("user data");
    expect(await readFile(join(recovery, "source.wav"), "utf8")).toBe(
      "sync original",
    );
    expect(await readFile(join(partial, "source.wav"), "utf8")).toBe(
      "sync original",
    );
  });
  it("refuses foreign files inside a marked workspace and preserves them", async () => {
    const e = await fixture(),
      path = await staged(e.config, {
        files: { "selected.wav": "copy", "unknown.txt": "preserve" },
      });
    await expect(
      recoverDesktopFileStages(e.config.cache_root),
    ).rejects.toMatchObject({ code: "FILE_STAGING_UNSAFE" });
    expect(await readFile(join(path, "unknown.txt"), "utf8")).toBe("preserve");
    expect(await readFile(e.input)).toEqual(wav());
  });
  it("rejects path-bearing and symlink ownership markers without following or deleting user data", async () => {
    const e = await fixture(),
      path = await staged(e.config);
    const marker = join(path, "desktop-file-staging.json");
    const value = JSON.parse(await readFile(marker, "utf8"));
    await writeFile(
      marker,
      JSON.stringify({ ...value, source_path: e.input }),
      { mode: 0o600 },
    );
    await expect(
      recoverDesktopFileStages(e.config.cache_root),
    ).rejects.toMatchObject({ code: "FILE_STAGING_UNSAFE" });
    await rm(marker);
    await symlink(e.input, marker);
    await expect(
      recoverDesktopFileStages(e.config.cache_root),
    ).rejects.toMatchObject({ code: "FILE_STAGING_UNSAFE" });
    expect((await lstat(marker)).isSymbolicLink()).toBe(true);
    expect(await readFile(e.input)).toEqual(wav());
    expect(await readFile(join(path, "selected.wav"), "utf8")).toBe(
      "private staged audio",
    );
  });
  it("bounds live temporary copies independently of offline vocals without creating another workspace", async () => {
    const e = await fixture();
    for (let index = 0; index < 2; index++) {
      const path = await staged(e.config, { pid: process.pid });
      await truncate(join(path, "selected.wav"), 256 * 1024 ** 2);
    }
    const before = await readdir(join(e.config.cache_root, "jobs"));
    await expect(
      prepareDesktopFile(e.config, e.input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "FILE_STAGING_FULL" });
    expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual(before);
    expect(await readFile(e.input)).toEqual(wav());
  });
  it("cleans an unsuccessful staging copy/probe while preserving the user-selected file", async () => {
    const e = await fixture();
    await expect(
      prepareDesktopFile(
        { ...e.config, ffprobe_path: "/usr/bin/false" },
        e.input,
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
    expect(await readFile(e.input)).toEqual(wav());
  });
});
describe.skipIf(!available)(
  "native selected audio boundary with actual FFprobe from an explicit external runtime",
  () => {
    it("keeps the user's selected original intact and produces a private exact local copy", async () => {
      const e = await fixture(),
        original = await readFile(e.input),
        source = await prepareDesktopFile(
          e.config,
          e.input,
          new AbortController().signal,
        );
      expect(source).toMatchObject({
        extension: "wav",
        duration_seconds: 1,
        bytes: original.length,
        sha256: createHash("sha256").update(original).digest("hex"),
      });
      expect(await readFile(source.input_path)).toEqual(original);
      expect(await readFile(e.input)).toEqual(original);
      expect((await lstat(source.input_path)).mode & 0o077).toBe(0);
      const marker = JSON.parse(
        await readFile(join(source.root, "desktop-file-staging.json"), "utf8"),
      );
      expect(marker).toEqual({
        version: 1,
        pid: process.pid,
        stage_id: source.root.split("/").at(-1),
        selected_extension: "wav",
      });
      expect(JSON.stringify(marker)).not.toContain(e.input);
      expect(
        (await lstat(join(source.root, "desktop-file-staging.json"))).mode &
          0o077,
      ).toBe(0);
    });
    it("refuses symlink-selected files without following or deleting them", async () => {
      const e = await fixture(),
        link = join(e.root, "link.wav");
      await symlink(e.input, link);
      await expect(
        prepareDesktopFile(e.config, link, new AbortController().signal),
      ).rejects.toBeDefined();
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      await expect(lstat(e.config.cache_root)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    it("rejects playlist demuxers hidden behind allowed audio extensions", async () => {
      const e = await fixture(),
        playlist = join(e.root, "playlist.mp3");
      await writeFile(playlist, `ffconcat version 1.0\nfile '${e.input}'\n`);
      await expect(
        prepareDesktopFile(e.config, playlist, new AbortController().signal),
      ).rejects.toBeDefined();
      expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
      expect(await readFile(e.input)).toEqual(wav());
    });
    it("cleans cancelled owned scratch while preserving the selected file", async () => {
      const e = await fixture(),
        controller = new AbortController();
      controller.abort();
      await expect(
        prepareDesktopFile(e.config, e.input, controller.signal),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      expect(await readdir(join(e.config.cache_root, "jobs"))).toEqual([]);
      expect(await readFile(e.input)).toEqual(wav());
    });
  },
);
