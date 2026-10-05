import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rm,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { basename, extname, join, dirname } from "node:path";
import { assertCacheDirectory, cacheFileBytes } from "./cache-budget.js";
import type { LocalConfig } from "./config.js";
import {
  LocalMacProvider,
  LocalProcessingError,
  runBounded,
} from "./local-provider.js";
import {
  MVP_MAX_DURATION_SECONDS,
  type PipelineHooks,
  type PreparedAudio,
  type ProcessingProvider,
  type StartPayload,
} from "../shared/protocol.js";

const TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
};
const VIDEO = new Set(["mp4", "mkv", "mov", "webm"]);
const MAX_BYTES = 256 * 1024 ** 2;
const INPUT_FORMATS = "mov,mp3,matroska,webm,ogg,aac,wav,flac";
const STAGING_MARKER = "desktop-file-staging.json";
const MAX_STAGE_BYTES = 2 * MAX_BYTES;
const MAX_STAGES = 64;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface StagingOwner {
  version: 1;
  pid: number;
  stage_id: string;
  selected_extension: string;
}
interface OwnedStage {
  root: string;
  owner: StagingOwner;
  bytes: number;
  marker_inode: number;
  marker_device: number;
  directory_inode: number;
  directory_device: number;
  recoverable: boolean;
}
function liveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readStageOwner(
  path: string,
): Promise<{ owner: StagingOwner; file: FileHandle }> {
  const file = await open(
    join(path, STAGING_MARKER),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new LocalProcessingError("FILE_STAGING_UNSAFE");
  });
  try {
    const before = await file.stat();
    const named = await lstat(join(path, STAGING_MARKER));
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.size > 4096 ||
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      named.isSymbolicLink()
    )
      throw new LocalProcessingError("FILE_STAGING_UNSAFE");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    const after = await file.stat();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new LocalProcessingError("FILE_STAGING_UNSAFE");
    const owner = value as StagingOwner;
    if (
      Object.keys(owner).some(
        (key) =>
          !["version", "pid", "stage_id", "selected_extension"].includes(key),
      ) ||
      owner.version !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      owner.pid > 2_147_483_647 ||
      typeof owner.stage_id !== "string" ||
      !UUID.test(owner.stage_id) ||
      basename(path) !== owner.stage_id ||
      typeof owner.selected_extension !== "string" ||
      (!TYPES[owner.selected_extension] &&
        !VIDEO.has(owner.selected_extension)) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new LocalProcessingError("FILE_STAGING_UNSAFE");
    return { owner, file };
  } catch (error) {
    await file.close();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new LocalProcessingError("FILE_STAGING_UNSAFE");
  }
}
async function ownedStages(cacheRoot: string): Promise<OwnedStage[]> {
  const jobs = join(cacheRoot, "jobs");
  if (
    !(await assertCacheDirectory(cacheRoot, cacheRoot)) ||
    !(await assertCacheDirectory(cacheRoot, jobs))
  )
    return [];
  const names = await readdir(jobs);
  if (names.length > 8192) throw new LocalProcessingError("FILE_STAGING_FULL");
  const entries: OwnedStage[] = [];
  for (const id of names) {
    if (!UUID.test(id)) continue;
    const root = join(jobs, id);
    // Unmarked work belongs to the pipeline, sync recovery, or another caller.
    const marker = await lstat(join(root, STAGING_MARKER)).catch(
      (error: unknown) => {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ENOTDIR"
        )
          return null;
        throw error;
      },
    );
    if (!marker) continue;
    await assertCacheDirectory(cacheRoot, root);
    if (entries.length >= MAX_STAGES)
      throw new LocalProcessingError("FILE_STAGING_FULL");
    const { owner, file } = await readStageOwner(root);
    let markerInfo;
    try {
      markerInfo = await file.stat();
    } finally {
      await file.close();
    }
    const directory = await lstat(root);
    const files = await readdir(root);
    const recovery = files.some(
      (name) =>
        name === "local-sync-recovery.json" ||
        (name.startsWith(".local-sync-") &&
          name.endsWith(".tmp") &&
          UUID.test(name.slice(12, -4))),
    );
    let bytes = 0;
    if (!recovery) {
      const allowed = new Set([
        STAGING_MARKER,
        `selected.${owner.selected_extension}`,
        `source.${owner.selected_extension}`,
        "source.m4a",
        "cloud.m4a",
      ]);
      if (files.some((name) => !allowed.has(name)))
        throw new LocalProcessingError("FILE_STAGING_UNSAFE");
      for (const name of files) {
        const size = await cacheFileBytes(cacheRoot, join(root, name));
        if (
          size === null ||
          size > (name === STAGING_MARKER ? 4096 : MAX_BYTES)
        )
          throw new LocalProcessingError("FILE_STAGING_UNSAFE");
        if (name !== STAGING_MARKER) bytes += size;
      }
      if (bytes > MAX_STAGE_BYTES)
        throw new LocalProcessingError("FILE_STAGING_FULL");
    }
    entries.push({
      root,
      owner,
      bytes,
      marker_inode: markerInfo.ino,
      marker_device: markerInfo.dev,
      directory_inode: directory.ino,
      directory_device: directory.dev,
      recoverable: !recovery,
    });
  }
  return entries;
}
/** Hold the shared cache mutation lease. Only dead, proven file-import staging is removed. */
export async function recoverDesktopFileStages(
  cacheRoot: string,
): Promise<{ removed: number; bytes: number }> {
  const entries = await ownedStages(cacheRoot);
  let removed = 0,
    bytes = 0;
  for (const entry of entries) {
    if (!entry.recoverable || liveProcess(entry.owner.pid)) continue;
    await assertCacheDirectory(cacheRoot, entry.root);
    const directory = await lstat(entry.root);
    const { owner, file } = await readStageOwner(entry.root);
    let marker;
    try {
      marker = await file.stat();
    } finally {
      await file.close();
    }
    if (
      directory.ino !== entry.directory_inode ||
      directory.dev !== entry.directory_device ||
      marker.ino !== entry.marker_inode ||
      marker.dev !== entry.marker_device ||
      owner.pid !== entry.owner.pid ||
      liveProcess(owner.pid)
    )
      throw new LocalProcessingError("FILE_STAGING_UNSAFE");
    await rm(entry.root, { recursive: true });
    await syncDirectory(dirname(entry.root));
    removed++;
    bytes += entry.bytes;
  }
  return { removed, bytes };
}
export interface DesktopFileSource {
  root: string;
  input_path: string;
  extension: string;
  content_type: string;
  duration_seconds: number;
  bytes: number;
  sha256: string;
}
function toolEnvironment(config: LocalConfig): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(config.ffmpeg_path)}:/usr/bin:/bin`,
    LANG: "C",
    LC_ALL: "C",
  };
}
async function copySelectedFile(
  source: string,
  destination: string,
  signal: AbortSignal,
) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat();
    const named = await lstat(source);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_BYTES ||
      named.isSymbolicLink() ||
      before.ino !== named.ino ||
      before.dev !== named.dev
    )
      throw new LocalProcessingError("FILE_INPUT_INVALID");
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    let copied = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      if (signal.aborted) throw new LocalProcessingError("CANCELLED");
      copied += chunk.length;
      if (copied > before.size)
        throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
      let written = 0;
      while (written < chunk.length) {
        const result = await output.write(
          chunk,
          written,
          chunk.length - written,
        );
        if (result.bytesWritten === 0)
          throw new LocalProcessingError("FILE_INPUT_INVALID");
        written += result.bytesWritten;
      }
    }
    const after = await input.stat();
    if (
      copied !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
    await output.sync();
  } finally {
    await output?.close();
    await input.close();
  }
}
export async function probeDesktopAudio(
  config: LocalConfig,
  path: string,
  signal: AbortSignal,
) {
  const result = await runBounded(
    config.ffprobe_path,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      INPUT_FORMATS,
      "-show_entries",
      "format=duration:stream=codec_type",
      "-of",
      "json",
      path,
    ],
    {
      signal,
      timeout_ms: 30_000,
      max_output_bytes: 64 * 1024,
      env: toolEnvironment(config),
    },
  );
  let value;
  try {
    value = JSON.parse(result.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string }[];
    };
  } catch {
    throw new LocalProcessingError("FILE_INPUT_INVALID");
  }
  const duration = Number(value.format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Array.isArray(value.streams) ||
    !value.streams.some((stream) => stream.codec_type === "audio") ||
    value.streams.length > 32
  )
    throw new LocalProcessingError("FILE_INPUT_INVALID");
  return {
    duration_seconds: duration,
    video: value.streams.some((stream) => stream.codec_type === "video"),
  };
}

/** Hold the shared mutation lease while copying and validating a selected file. */
export async function prepareDesktopFile(
  config: LocalConfig,
  sourcePath: string,
  signal: AbortSignal,
  maximumDuration = MVP_MAX_DURATION_SECONDS,
): Promise<DesktopFileSource> {
  const extension = extname(sourcePath).slice(1).toLowerCase();
  if (!TYPES[extension] && !VIDEO.has(extension))
    throw new LocalProcessingError("FILE_TYPE_UNSUPPORTED");
  const selected = await lstat(sourcePath);
  if (
    !selected.isFile() ||
    selected.isSymbolicLink() ||
    selected.uid !== process.getuid?.() ||
    selected.nlink !== 1 ||
    selected.size <= 0 ||
    selected.size > MAX_BYTES
  )
    throw new LocalProcessingError("FILE_INPUT_INVALID");
  const stages = await ownedStages(config.cache_root);
  const reserve = selected.size + (VIDEO.has(extension) ? MAX_BYTES : 0);
  if (
    stages.length >= MAX_STAGES ||
    stages.reduce((total, stage) => total + stage.bytes, 0) + reserve >
      MAX_STAGE_BYTES
  )
    throw new LocalProcessingError("FILE_STAGING_FULL");
  const root = join(config.cache_root, "jobs", randomUUID());
  await assertCacheDirectory(config.cache_root, root, true);
  const created = await lstat(root);
  let path = join(root, `selected.${extension}`);
  try {
    const marker = await open(
      join(root, STAGING_MARKER),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await marker.writeFile(
        JSON.stringify({
          version: 1,
          pid: process.pid,
          stage_id: basename(root),
          selected_extension: extension,
        } satisfies StagingOwner),
      );
      await marker.sync();
    } finally {
      await marker.close();
    }
    await syncDirectory(root);
    await syncDirectory(dirname(root));
    const disk = await statfs(root);
    if (Number(disk.bavail) * Number(disk.bsize) < 3 * 1024 ** 3)
      throw new LocalProcessingError("DISK_SPACE_LOW");
    await copySelectedFile(sourcePath, path, signal);
    const probe = await probeDesktopAudio(config, path, signal);
    if (probe.duration_seconds > maximumDuration)
      throw new LocalProcessingError("DURATION_LIMIT_EXCEEDED");
    if (probe.video || !TYPES[extension]) {
      const original = join(root, "source.m4a");
      await runBounded(
        config.ffmpeg_path,
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          INPUT_FORMATS,
          "-i",
          path,
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-c:a",
          "aac",
          "-b:a",
          "160k",
          "-ar",
          "44100",
          "-ac",
          "2",
          "-n",
          original,
        ],
        {
          signal,
          timeout_ms: 180_000,
          max_output_bytes: 64 * 1024,
          env: toolEnvironment(config),
        },
      );
      await rm(path);
      path = original;
    }
    const originalExtension = extname(path).slice(1);
    const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await input.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_BYTES)
        throw new LocalProcessingError("FILE_INPUT_INVALID");
      const hash = createHash("sha256");
      for await (const chunk of input.createReadStream({ autoClose: false }))
        hash.update(chunk);
      return {
        root,
        input_path: path,
        extension: originalExtension,
        content_type: TYPES[originalExtension]!,
        duration_seconds: probe.duration_seconds,
        bytes: info.size,
        sha256: hash.digest("hex"),
      };
    } finally {
      await input.close();
    }
  } catch (error) {
    await assertCacheDirectory(config.cache_root, root);
    const current = await lstat(root);
    if (created.ino !== current.ino || created.dev !== current.dev)
      throw new LocalProcessingError("FILE_STAGING_UNSAFE");
    await rm(root, { recursive: true, force: true });
    await syncDirectory(dirname(root));
    throw error;
  }
}
export class FileLocalProvider implements ProcessingProvider {
  readonly id = "LOCAL_MACOS" as const;
  constructor(
    private readonly config: LocalConfig,
    private readonly source: DesktopFileSource,
  ) {
    this.source = { ...source };
  }
  async prepare(
    _request: StartPayload,
    workRoot: string,
    hooks: PipelineHooks,
  ): Promise<PreparedAudio> {
    if (
      !TYPES[this.source.extension] ||
      this.source.content_type !== TYPES[this.source.extension] ||
      !/^[a-f0-9]{64}$/.test(this.source.sha256) ||
      !Number.isSafeInteger(this.source.bytes) ||
      this.source.bytes <= 0 ||
      this.source.bytes > MAX_BYTES
    )
      throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
    hooks.onProgress("preparing-file");
    const input = join(workRoot, `source.${this.source.extension}`);
    await copySelectedFile(this.source.input_path, input, hooks.signal);
    const copied = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await copied.stat();
      const digest = createHash("sha256");
      for await (const chunk of copied.createReadStream({ autoClose: false })) {
        if (hooks.signal.aborted) throw new LocalProcessingError("CANCELLED");
        digest.update(chunk);
      }
      const after = await copied.stat(),
        named = await lstat(input);
      if (
        before.size !== this.source.bytes ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== named.ino ||
        before.dev !== named.dev ||
        named.isSymbolicLink() ||
        digest.digest("hex") !== this.source.sha256
      )
        throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
    } finally {
      await copied.close();
    }
    return new LocalMacProvider(this.config).prepareOwnedAudio(
      input,
      this.source.duration_seconds,
      workRoot,
      hooks,
    );
  }
}
