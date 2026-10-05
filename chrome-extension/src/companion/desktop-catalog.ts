import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { privateDirectory } from "./app-setup.js";
import { withCacheMutation } from "./cache-mutator.js";
import type { LocalLibraryOwner } from "./sync-outbox.js";
import { isVideoId, sanitizeSourceTitle } from "../shared/protocol.js";

const HASH = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ENTRIES = 4096;
const MAX_MANIFEST_BYTES = 4 * 1024 ** 2;
const MAX_PAGE_BYTES = 48 * 1024;

export interface DesktopCatalogEntry {
  cache_key: string;
  operation_id: string;
  source_title?: string;
  video_id?: string;
  source_kind: "file" | "url";
  vocal_path: string;
  duration_seconds: number;
  source_duration_seconds?: number;
  trim_enabled?: boolean;
  bytes: number;
  sha256: string;
  job_id?: string;
}
export interface DesktopCatalogItem extends DesktopCatalogEntry {
  created_at: number;
  updated_at: number;
}
export interface DesktopCatalogPage {
  entries: DesktopCatalogItem[];
  total: number;
  next_cursor?: string;
}
type StoredEntry = Omit<DesktopCatalogItem, "vocal_path">;
interface Manifest {
  version: 1;
  owner_uid: string | null;
  revision: string;
  entries: StoredEntry[];
}
interface CachedAudio {
  source_title?: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validUid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/\p{Cc}/u.test(value)
  );
}
function captureOwner(owner?: LocalLibraryOwner): string | null {
  if (!owner) return null;
  if (
    !validUid(owner.uid) ||
    typeof owner.session_generation !== "string" ||
    !UUID.test(owner.session_generation)
  )
    throw new Error("CATALOG_ACCOUNT_INVALID");
  return owner.uid;
}
function validEntry(value: unknown): value is StoredEntry {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "cache_key",
          "operation_id",
          "source_title",
          "video_id",
          "source_kind",
          "duration_seconds",
          "source_duration_seconds",
          "trim_enabled",
          "bytes",
          "sha256",
          "job_id",
          "created_at",
          "updated_at",
        ].includes(key),
    )
  )
    return false;
  return (
    typeof value.cache_key === "string" &&
    HASH.test(value.cache_key) &&
    typeof value.operation_id === "string" &&
    IDENTIFIER.test(value.operation_id) &&
    (value.source_title === undefined ||
      (typeof value.source_title === "string" &&
        value.source_title.length <= 300 &&
        !/\p{Cc}/u.test(value.source_title))) &&
    (value.video_id === undefined || isVideoId(value.video_id)) &&
    (value.source_kind === "file" || value.source_kind === "url") &&
    (value.source_kind !== "file" || value.video_id === undefined) &&
    typeof value.duration_seconds === "number" &&
    Number.isFinite(value.duration_seconds) &&
    value.duration_seconds > 0 &&
    value.duration_seconds <= 1800.25 &&
    (value.duration_seconds <= 1800 ||
      value.source_duration_seconds !== undefined) &&
    (value.trim_enabled === undefined ||
      typeof value.trim_enabled === "boolean") &&
    (value.source_duration_seconds === undefined ||
      (typeof value.source_duration_seconds === "number" &&
        Number.isFinite(value.source_duration_seconds) &&
        value.source_duration_seconds > 0 &&
        value.source_duration_seconds <= 1800)) &&
    (value.trim_enabled !== true
      ? value.source_duration_seconds === undefined ||
        Math.abs(
          Number(value.source_duration_seconds) - value.duration_seconds,
        ) <= 0.25
      : value.source_duration_seconds !== undefined &&
        value.duration_seconds <=
          Number(value.source_duration_seconds) + 0.25) &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    value.bytes <= 60 * 1024 ** 2 &&
    typeof value.sha256 === "string" &&
    HASH.test(value.sha256) &&
    (value.job_id === undefined ||
      (typeof value.job_id === "string" && IDENTIFIER.test(value.job_id))) &&
    typeof value.created_at === "number" &&
    Number.isSafeInteger(value.created_at) &&
    value.created_at >= 0 &&
    typeof value.updated_at === "number" &&
    Number.isSafeInteger(value.updated_at) &&
    value.updated_at >= value.created_at
  );
}
async function privateFile(path: string, maximum: number): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error("CATALOG_UNSAFE");
    throw error;
  }
  try {
    const info = await handle.stat();
    const named = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > maximum ||
      named.isSymbolicLink() ||
      named.ino !== info.ino ||
      named.dev !== info.dev
    )
      throw new Error("CATALOG_UNSAFE");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Durable account-owned offline metadata. It never downloads, mutates or evicts audio. */
export class DesktopCatalog {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly cacheRoot: string,
  ) {
    if (
      !isAbsolute(root) ||
      !isAbsolute(cacheRoot) ||
      resolve(root) === resolve(cacheRoot)
    )
      throw new Error("CATALOG_UNSAFE");
  }
  private namespace(uid: string | null): string {
    return uid === null
      ? "guest"
      : createHash("sha256").update(uid).digest("hex");
  }
  private vocalPath(key: string): string {
    return join(this.cacheRoot, "vocals", key, "vocals.mp3");
  }
  private async directory(
    path: string,
    base: string,
    create = false,
  ): Promise<void> {
    if (create) await privateDirectory(path);
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error("CATALOG_UNSAFE");
    const difference = relative(await realpath(base), await realpath(path));
    if (difference.startsWith("..") || isAbsolute(difference))
      throw new Error("CATALOG_UNSAFE");
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const task = this.serial.then(() => withCacheMutation(this.root, action));
    this.serial = task.catch(() => {});
    return task;
  }
  private async read(uid: string | null): Promise<Manifest> {
    await this.directory(this.root, this.root);
    const account = join(this.root, this.namespace(uid));
    await this.directory(account, this.root, true);
    const path = join(account, "entries.json");
    try {
      const handle = await privateFile(path, MAX_MANIFEST_BYTES);
      let value: unknown;
      try {
        value = JSON.parse(await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
      if (
        !object(value) ||
        Object.keys(value).some(
          (key) =>
            !["version", "owner_uid", "revision", "entries"].includes(key),
        ) ||
        value.version !== 1 ||
        value.owner_uid !== uid ||
        typeof value.revision !== "string" ||
        !UUID.test(value.revision) ||
        !Array.isArray(value.entries) ||
        value.entries.length > MAX_ENTRIES ||
        !value.entries.every(validEntry) ||
        new Set(value.entries.map((entry) => entry.cache_key)).size !==
          value.entries.length
      )
        throw new Error("CATALOG_MANIFEST_INVALID");
      return value as unknown as Manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        version: 1,
        owner_uid: uid,
        revision: randomUUID(),
        entries: [],
      };
    }
  }
  private async write(manifest: Manifest): Promise<void> {
    const account = join(this.root, this.namespace(manifest.owner_uid));
    await this.directory(account, this.root);
    if (manifest.entries.length > MAX_ENTRIES) throw new Error("CATALOG_FULL");
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("CATALOG_FULL");
    const temporary = join(account, `.entries-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, join(account, "entries.json"));
      await syncDirectory(account);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async cached(
    entry: StoredEntry,
    uid: string | null,
  ): Promise<CachedAudio | null> {
    try {
      await this.directory(this.cacheRoot, this.cacheRoot);
      await this.directory(join(this.cacheRoot, "vocals"), this.cacheRoot);
      const root = join(this.cacheRoot, "vocals", entry.cache_key);
      await this.directory(root, this.cacheRoot);
      const metadata = await privateFile(join(root, "result.json"), 16 * 1024);
      let raw: unknown;
      try {
        raw = JSON.parse(await metadata.readFile("utf8"));
      } finally {
        await metadata.close();
      }
      if (
        !object(raw) ||
        raw.output_path !== this.vocalPath(entry.cache_key) ||
        raw.sha256 !== entry.sha256 ||
        raw.bytes !== entry.bytes ||
        raw.trim_enabled !== (entry.trim_enabled ?? false) ||
        typeof raw.model_id !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(raw.model_id) ||
        typeof raw.duration_seconds !== "number" ||
        !Number.isFinite(raw.duration_seconds) ||
        Math.abs(raw.duration_seconds - entry.duration_seconds) > 0.25 ||
        typeof raw.source_duration_seconds !== "number" ||
        !Number.isFinite(raw.source_duration_seconds) ||
        Math.abs(
          raw.source_duration_seconds -
            (entry.source_duration_seconds ?? entry.duration_seconds),
        ) > 0.25 ||
        (entry.trim_enabled === true
          ? raw.duration_seconds > raw.source_duration_seconds + 0.25
          : Math.abs(raw.source_duration_seconds - raw.duration_seconds) > 0.25)
      )
        return null;
      if (raw.owner_uid !== undefined && !validUid(raw.owner_uid))
        throw new Error("CATALOG_MANIFEST_INVALID");
      const youtube =
        object(raw.source) &&
        raw.source.kind === "youtube" &&
        isVideoId(raw.source.video_id)
          ? raw.source.video_id
          : undefined;
      if (
        youtube &&
        (entry.source_kind !== "url" || entry.video_id !== youtube)
      )
        return null;
      if (
        raw.owner_uid !== undefined &&
        raw.owner_uid !== uid &&
        (raw.account_job_id !== undefined ||
          !(
            entry.source_kind === "url" &&
            entry.video_id !== undefined &&
            youtube === entry.video_id
          ))
      )
        throw new Error("CATALOG_OWNER_MISMATCH");
      const handle = await privateFile(
        this.vocalPath(entry.cache_key),
        entry.bytes,
      );
      try {
        const before = await handle.stat();
        const digest = createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false }))
          digest.update(chunk);
        const after = await handle.stat();
        const valid =
          before.size === entry.bytes &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          digest.digest("hex") === entry.sha256;
        if (!valid) return null;
        const title = sanitizeSourceTitle(raw.source_title);
        return title ? { source_title: title } : {};
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      )
        return null;
      if ((error as NodeJS.ErrnoException).code === "ELOOP")
        throw new Error("CATALOG_UNSAFE");
      throw error;
    }
  }
  private async prune(manifest: Manifest): Promise<boolean> {
    const retained: StoredEntry[] = [];
    let changed = false;
    for (const entry of manifest.entries) {
      const cached = await this.cached(entry, manifest.owner_uid);
      if (!cached) {
        changed = true;
        continue;
      }
      if (!sanitizeSourceTitle(entry.source_title) && cached.source_title) {
        entry.source_title = cached.source_title;
        changed = true;
      }
      retained.push(entry);
    }
    if (!changed) return false;
    manifest.entries = retained;
    manifest.revision = randomUUID();
    return true;
  }
  async remember(
    owner: LocalLibraryOwner | undefined,
    input: DesktopCatalogEntry,
  ): Promise<DesktopCatalogItem> {
    const uid = captureOwner(owner);
    input = { ...input };
    const { vocal_path, ...declaration } = input;
    const timestamp = Date.now();
    const entry: StoredEntry = {
      ...declaration,
      created_at: timestamp,
      updated_at: timestamp,
    };
    if (!validEntry(entry) || vocal_path !== this.vocalPath(entry.cache_key))
      throw new Error("CATALOG_ENTRY_INVALID");
    return this.locked(async () => {
      const manifest = await this.read(uid);
      if (!(await this.cached(entry, uid)))
        throw new Error("CATALOG_AUDIO_INVALID");
      await this.prune(manifest);
      const existing = manifest.entries.find(
        (item) => item.cache_key === entry.cache_key,
      );
      if (existing) {
        if (
          existing.sha256 !== entry.sha256 ||
          existing.bytes !== entry.bytes ||
          existing.source_kind !== entry.source_kind ||
          existing.video_id !== entry.video_id
        )
          throw new Error("CATALOG_ENTRY_CONFLICT");
        entry.created_at = existing.created_at;
        entry.operation_id = existing.operation_id;
        entry.updated_at = Math.max(Date.now(), existing.updated_at);
        if (entry.job_id === undefined && existing.job_id !== undefined)
          entry.job_id = existing.job_id;
        if (
          entry.source_title === undefined &&
          existing.source_title !== undefined
        )
          entry.source_title = existing.source_title;
        manifest.entries = manifest.entries.filter(
          (item) => item.cache_key !== entry.cache_key,
        );
      }
      manifest.entries.unshift(entry);
      manifest.revision = randomUUID();
      await this.write(manifest);
      return { ...entry, vocal_path: this.vocalPath(entry.cache_key) };
    });
  }
  async attachJob(
    owner: LocalLibraryOwner,
    operationOrCacheKey: string,
    jobId: string,
    expectedSha256?: string,
  ): Promise<void> {
    const uid = captureOwner(owner);
    if (
      !IDENTIFIER.test(operationOrCacheKey) ||
      !IDENTIFIER.test(jobId) ||
      (expectedSha256 !== undefined && !HASH.test(expectedSha256))
    )
      throw new Error("CATALOG_ENTRY_INVALID");
    return this.locked(async () => {
      const manifest = await this.read(uid);
      const changed = await this.prune(manifest);
      const entry = manifest.entries.find(
        (item) =>
          item.operation_id === operationOrCacheKey ||
          item.cache_key === operationOrCacheKey,
      );
      if (!entry) {
        if (changed) await this.write(manifest);
        throw new Error("CATALOG_ENTRY_MISSING");
      }
      if (expectedSha256 !== undefined && expectedSha256 !== entry.sha256)
        throw new Error("CATALOG_ENTRY_CONFLICT");
      entry.job_id = jobId;
      entry.updated_at = Math.max(Date.now(), entry.updated_at);
      manifest.revision = randomUUID();
      await this.write(manifest);
    });
  }
  /** Roll back only this newly published owner audio identity; never delete unrelated catalog entries. */
  async discard(
    owner: LocalLibraryOwner,
    cacheKey: string,
    sha256: string,
  ): Promise<void> {
    const uid = captureOwner(owner);
    if (!HASH.test(cacheKey) || !HASH.test(sha256))
      throw new Error("CATALOG_ENTRY_INVALID");
    return this.locked(async () => {
      const manifest = await this.read(uid);
      const retained = manifest.entries.filter(
        (entry) => entry.cache_key !== cacheKey || entry.sha256 !== sha256,
      );
      if (retained.length !== manifest.entries.length) {
        manifest.entries = retained;
        manifest.revision = randomUUID();
        await this.write(manifest);
      }
    });
  }
  /** Optional owner display metadata; callers independently validate audio before playback. */
  async sourceTitle(
    owner: LocalLibraryOwner | undefined,
    cacheKey: string,
  ): Promise<string | undefined> {
    const uid = captureOwner(owner);
    if (!HASH.test(cacheKey)) throw new Error("CATALOG_ENTRY_INVALID");
    return this.locked(async () => {
      const manifest = await this.read(uid);
      return sanitizeSourceTitle(
        manifest.entries.find((entry) => entry.cache_key === cacheKey)
          ?.source_title,
      );
    });
  }
  async list(
    owner?: LocalLibraryOwner,
    cursor?: string,
    limit = 50,
  ): Promise<DesktopCatalogPage> {
    const uid = captureOwner(owner);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new Error("CATALOG_PAGE_INVALID");
    return this.locked(async () => {
      const manifest = await this.read(uid);
      if (await this.prune(manifest)) await this.write(manifest);
      let offset = 0;
      if (cursor !== undefined) {
        if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
          throw new Error("CATALOG_CURSOR_INVALID");
        let page: unknown;
        try {
          page = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        } catch {
          throw new Error("CATALOG_CURSOR_INVALID");
        }
        if (
          !object(page) ||
          Object.keys(page).some(
            (key) => !["revision", "namespace", "offset"].includes(key),
          ) ||
          page.namespace !== this.namespace(uid) ||
          typeof page.offset !== "number" ||
          !Number.isSafeInteger(page.offset) ||
          page.offset < 0 ||
          page.offset > manifest.entries.length
        )
          throw new Error("CATALOG_CURSOR_INVALID");
        if (page.revision !== manifest.revision)
          throw new Error("CATALOG_CURSOR_STALE");
        offset = page.offset;
      }
      const ordered = [...manifest.entries].sort(
        (a, b) =>
          b.updated_at - a.updated_at || a.cache_key.localeCompare(b.cache_key),
      );
      const page: DesktopCatalogPage = { entries: [], total: ordered.length };
      for (const entry of ordered.slice(offset, offset + limit)) {
        const candidate = {
          ...entry,
          vocal_path: this.vocalPath(entry.cache_key),
        };
        if (
          Buffer.byteLength(
            JSON.stringify({ ...page, entries: [...page.entries, candidate] }),
          ) >
          MAX_PAGE_BYTES - 1024
        )
          break;
        page.entries.push(candidate);
      }
      if (offset + page.entries.length < ordered.length)
        page.next_cursor = Buffer.from(
          JSON.stringify({
            revision: manifest.revision,
            namespace: this.namespace(uid),
            offset: offset + page.entries.length,
          }),
        ).toString("base64url");
      return page;
    });
  }
  /** Bounded owner metadata candidates. The caller must validate account recipe and audio under the cache lease. */
  async youtubeCandidates(
    owner: LocalLibraryOwner,
    videoId: string,
    limit = 32,
  ): Promise<DesktopCatalogItem[]> {
    const uid = captureOwner(owner);
    if (
      !isVideoId(videoId) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 32
    )
      throw new Error("CATALOG_PAGE_INVALID");
    return this.locked(async () => {
      const manifest = await this.read(uid);
      return manifest.entries
        .filter(
          (entry) =>
            entry.source_kind === "url" &&
            entry.video_id === videoId &&
            entry.job_id !== undefined,
        )
        .sort(
          (a, b) =>
            b.updated_at - a.updated_at ||
            a.cache_key.localeCompare(b.cache_key),
        )
        .slice(0, limit)
        .map((entry) => ({
          ...entry,
          vocal_path: this.vocalPath(entry.cache_key),
        }));
    });
  }
  /** Remove only owned interrupted metadata writes; the last published manifest remains authoritative. */
  async recover(owner?: LocalLibraryOwner): Promise<void> {
    const uid = captureOwner(owner);
    return this.locked(async () => {
      await this.read(uid);
      const account = join(this.root, this.namespace(uid));
      const names = await readdir(account);
      if (names.length > MAX_ENTRIES + 256) throw new Error("CATALOG_FULL");
      for (const name of names) {
        if (
          !name.startsWith(".entries-") ||
          !name.endsWith(".tmp") ||
          !UUID.test(name.slice(9, -4))
        )
          continue;
        const path = join(account, name);
        const handle = await privateFile(path, MAX_MANIFEST_BYTES);
        await handle.close();
        await unlink(path);
      }
      await syncDirectory(account);
    });
  }
}
