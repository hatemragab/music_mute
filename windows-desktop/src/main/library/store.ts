import { createHash, randomUUID } from "node:crypto";
import { lstat, rename } from "node:fs/promises";
import { win32 } from "node:path";
import {
  PERSONAL_UUID,
  type PersonalJobView,
  type PersonalArtifact,
} from "../../shared/personal-contracts.js";
import { publicThumbnailUrl } from "../../../../chrome-extension/src/shared/thumbnail-url.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import { acquireLibraryCacheLease } from "./cache-lease.js";
import type { HostContext } from "../host-context.js";
import {
  parsePersonalTimeline,
  type PersonalTimeline,
} from "../personal/timeline.js";
import { newPrivateFile, readPrivateBytes } from "../prepare/private-files.js";
import {
  EMPTY_LIBRARY_PREFERENCES,
  localTrackId,
  personalLibraryEntry,
  type LocalLibraryEntry,
  type LibraryPreferences,
  type AccountLibraryLink,
  type AccountLibraryJob,
  accountLibraryJob,
} from "./model.js";
export interface LibraryPartition {
  version: 1;
  ownerUid: string | null;
  revision: string;
  entries: LocalLibraryEntry[];
  links: AccountLibraryLink[];
  preferences: LibraryPreferences;
  jobs: AccountLibraryJob[];
}
export interface LibraryDiskPort {
  read(ownerUid: string | null): Promise<LibraryPartition>;
  write(partition: LibraryPartition): Promise<void>;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
}
export const libraryNamespace = (uid: string | null) =>
  uid === null ? "guest" : createHash("sha256").update(uid).digest("hex");
export function emptyPartition(uid: string | null): LibraryPartition {
  return {
    version: 1,
    ownerUid: uid,
    revision: randomUUID(),
    entries: [],
    links: [],
    preferences: EMPTY_LIBRARY_PREFERENCES(),
    jobs: [],
  };
}
const HASH = /^[a-f0-9]{64}$/u,
  TRACK = /^[A-Za-z0-9:_-]{1,160}$/u,
  JOB = /^[a-f0-9]{24}$/u;
function artifact(
  value: unknown,
  kind: "original" | "vocals",
): PersonalArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LIBRARY_CORRUPT");
  const row = value as PersonalArtifact;
  if (
    Object.keys(row).sort().join() !==
      "bytes,contentType,durationSeconds,id,kind,name,sha256" ||
    !PERSONAL_UUID.test(row.id) ||
    row.kind !== kind ||
    typeof row.name !== "string" ||
    row.name.length > 255 ||
    /[\p{Cc}]/u.test(row.name) ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes < 1 ||
    row.bytes > (kind === "vocals" ? 30_000_000 : 256 * 1024 ** 2) ||
    !HASH.test(row.sha256) ||
    !Number.isFinite(row.durationSeconds) ||
    row.durationSeconds <= 0 ||
    row.durationSeconds > 1202 ||
    ![
      "audio/mpeg",
      "audio/mp4",
      "audio/webm",
      "audio/ogg",
      "audio/aac",
      "audio/wav",
      "audio/flac",
    ].includes(row.contentType)
  )
    throw new Error("LIBRARY_CORRUPT");
  return row;
}
export function parseLibraryPartition(
  value: unknown,
  uid: string | null,
): LibraryPartition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LIBRARY_CORRUPT");
  const row = value as LibraryPartition;
  if (
    Object.keys(row).sort().join() !==
      "entries,jobs,links,ownerUid,preferences,revision,version" ||
    row.version !== 1 ||
    row.ownerUid !== uid ||
    !PERSONAL_UUID.test(row.revision) ||
    !Array.isArray(row.entries) ||
    row.entries.length > 4096 ||
    !Array.isArray(row.links) ||
    row.links.length > 4096 ||
    !Array.isArray(row.jobs) ||
    row.jobs.length > 4096 ||
    (uid === null && row.jobs.length !== 0) ||
    row.jobs.some(
      (job) =>
        !job ||
        !/^[a-f0-9]{24}$/.test(job.metadata?.id) ||
        job.metadata.status !== "ready" ||
        !Number.isFinite(job.metadata.input?.duration_seconds) ||
        !job.metadata.output ||
        (job.updatedAt !== null &&
          (!Number.isSafeInteger(job.updatedAt) || job.updatedAt < 0)),
    ) ||
    !row.preferences ||
    Object.keys(row.preferences).sort().join() !== "counts,hidden,starred" ||
    !Array.isArray(row.preferences.starred) ||
    !Array.isArray(row.preferences.hidden) ||
    row.preferences.starred.length > 8192 ||
    row.preferences.hidden.length > 8192 ||
    [...row.preferences.starred, ...row.preferences.hidden].some(
      (value) => typeof value !== "string" || !TRACK.test(value),
    ) ||
    !row.preferences.counts ||
    typeof row.preferences.counts !== "object" ||
    Object.entries(row.preferences.counts).length > 8192 ||
    Object.entries(row.preferences.counts).some(
      ([id, count]) =>
        !TRACK.test(id) || !Number.isSafeInteger(count) || count < 0,
    )
  )
    throw new Error("LIBRARY_CORRUPT");
  for (const job of row.jobs) {
    if (
      Object.keys(job).some(
        (key) => !["metadata", "updatedAt", "comparisonRanges"].includes(key),
      )
    )
      throw new Error("LIBRARY_CORRUPT");
    const validated = accountLibraryJob({
      ...job.metadata,
      ...(job.updatedAt === null
        ? {}
        : { updated_at: new Date(job.updatedAt).toISOString() }),
      ...(job.comparisonRanges === undefined
        ? {}
        : { comparison_ranges: job.comparisonRanges }),
    });
    job.comparisonRanges = validated.comparisonRanges;
  }
  const seen = new Set<string>();
  for (const entry of row.entries) {
    if (
      !entry ||
      Object.keys(entry).sort().join() !==
        (entry.timeline === undefined
          ? "catalog,original,personalJobId,vocals"
          : "catalog,original,personalJobId,timeline,vocals") ||
      !PERSONAL_UUID.test(entry.personalJobId)
    )
      throw new Error("LIBRARY_CORRUPT");
    artifact(entry.original, "original");
    artifact(entry.vocals, "vocals");
    const timeline =
      entry.timeline === undefined
        ? undefined
        : parsePersonalTimeline(entry.timeline);
    if (
      timeline &&
      (Math.abs(
        entry.original.durationSeconds - timeline.sourceSamples / 44100,
      ) > 0.25 ||
        Math.abs(
          entry.vocals.durationSeconds - timeline.outputSamples / 44100,
        ) > 0.25)
    )
      throw new Error("LIBRARY_CORRUPT");
    const c = entry.catalog;
    if (
      !c ||
      Object.keys(c).some(
        (key) =>
          ![
            "cache_key",
            "operation_id",
            "source_kind",
            "source_title",
            "thumbnail_url",
            "video_id",
            "duration_seconds",
            "source_duration_seconds",
            "trim_enabled",
            "bytes",
            "sha256",
            "created_at",
            "updated_at",
          ].includes(key),
      ) ||
      !HASH.test(c.cache_key) ||
      c.operation_id !== entry.personalJobId ||
      !["file", "url"].includes(c.source_kind) ||
      c.trim_enabled !== (timeline?.trimEnabled ?? false) ||
      c.bytes !== entry.vocals.bytes ||
      c.sha256 !== entry.vocals.sha256 ||
      c.duration_seconds !== entry.vocals.durationSeconds ||
      c.source_duration_seconds !==
        (timeline
          ? timeline.sourceSamples / 44100
          : entry.original.durationSeconds) ||
      typeof c.source_title !== "string" ||
      c.source_title.length > 300 ||
      /[\p{Cc}]/u.test(c.source_title) ||
      !Number.isSafeInteger(c.created_at) ||
      !Number.isSafeInteger(c.updated_at) ||
      c.created_at < 0 ||
      c.updated_at < c.created_at ||
      (c.video_id !== undefined &&
        (c.source_kind !== "url" || !/^[A-Za-z0-9_-]{11}$/.test(c.video_id))) ||
      (c.thumbnail_url != null &&
        publicThumbnailUrl(c.thumbnail_url) === null) ||
      seen.has(c.cache_key)
    )
      throw new Error("LIBRARY_CORRUPT");
    seen.add(c.cache_key);
  }
  if (uid === null && row.links.length) throw new Error("LIBRARY_CORRUPT");
  const linked = new Set<string>();
  for (const link of row.links) {
    if (
      !link ||
      Object.keys(link).sort().join() !== "jobId,localId,outputSha256" ||
      !/^local:[a-f0-9]{64}$/.test(link.localId) ||
      !JOB.test(link.jobId) ||
      !HASH.test(link.outputSha256) ||
      linked.has(link.localId)
    )
      throw new Error("LIBRARY_CORRUPT");
    linked.add(link.localId);
  }
  return structuredClone(row);
}
/** Windows ACL/path validation replaces the POSIX checks of the shared catalog. */
export class WindowsLibraryDisk implements LibraryDiskPort {
  constructor(private readonly host: HostContext) {}
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await acquireLibraryCacheLease(this.host);
    try {
      return await operation();
    } finally {
      await this.host.native.releaseMutex(lease);
    }
  }
  async read(uid: string | null): Promise<LibraryPartition> {
    const relative = `library\\${libraryNamespace(uid)}\\catalog.json`;
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyPartition(uid);
      throw error;
    }
    return parseLibraryPartition(
      JSON.parse(
        (await readPrivateBytes(this.host, relative, 16 * 1024 ** 2)).toString(
          "utf8",
        ),
      ),
      uid,
    );
  }
  async write(partition: LibraryPartition): Promise<void> {
    parseLibraryPartition(partition, partition.ownerUid);
    const relative = `library\\${libraryNamespace(partition.ownerUid)}\\catalog.json`,
      temp = `${relative}.${randomUUID()}.tmp`,
      bytes = Buffer.from(JSON.stringify(partition));
    if (bytes.length > 16 * 1024 ** 2) throw new Error("LIBRARY_FULL");
    const file = await newPrivateFile(this.host, temp);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
      await this.host.native.validatePath("personal", relative, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.host.native.validatePath("personal", relative, "absent");
    }
    await rename(
      win32.join(this.host.personalRoot, temp),
      win32.join(this.host.personalRoot, relative),
    );
    await this.host.native.validatePath("personal", relative, "file");
  }
}
export class LibraryStore {
  constructor(
    readonly disk: LibraryDiskPort,
    private readonly current: (scope: SessionAccountScope | null) => boolean,
    private readonly now: () => number = Date.now,
  ) {}
  private assert(scope: SessionAccountScope | null): void {
    if (!this.current(scope)) throw new Error("ACCOUNT_CHANGED");
  }
  async rememberPersonal(
    view: PersonalJobView,
    scope: SessionAccountScope | null,
    timeline?: PersonalTimeline,
  ): Promise<string> {
    if (scope !== null) this.assert(scope);
    const entry = personalLibraryEntry(view, this.now(), timeline);
    return this.disk.mutate(async () => {
      if (scope !== null) this.assert(scope);
      const guest = await this.disk.read(null),
        existing = guest.entries.find((row) => row.personalJobId === view.id);
      if (existing) {
        if (existing.vocals.sha256 !== entry.vocals.sha256)
          throw new Error("LIBRARY_RESULT_INVALID");
        return localTrackId(existing);
      }
      if (guest.entries.length >= 4096) throw new Error("LIBRARY_FULL");
      const previous = structuredClone(guest);
      guest.entries.push(entry);
      guest.revision = randomUUID();
      if (scope !== null) this.assert(scope);
      await this.disk.write(guest);
      if (scope !== null && !this.current(scope)) {
        await this.disk.write(previous);
        throw new Error("ACCOUNT_CHANGED");
      }
      return localTrackId(entry);
    });
  }
  async snapshot(
    scope: SessionAccountScope | null,
  ): Promise<{ guest: LibraryPartition; account: LibraryPartition }> {
    this.assert(scope);
    const guest = await this.disk.read(null),
      account = scope
        ? await this.disk.read(scope.firebaseUid)
        : emptyPartition(null);
    this.assert(scope);
    return { guest, account };
  }
  async preferences(
    scope: SessionAccountScope | null,
    change: (preferences: LibraryPreferences) => void,
  ): Promise<void> {
    this.assert(scope);
    await this.disk.mutate(async () => {
      this.assert(scope);
      const partition = await this.disk.read(scope?.firebaseUid ?? null);
      change(partition.preferences);
      partition.revision = randomUUID();
      this.assert(scope);
      await this.disk.write(partition);
      this.assert(scope);
    });
  }
  async saveAccountJobs(
    scope: SessionAccountScope,
    jobs: AccountLibraryJob[],
  ): Promise<void> {
    this.assert(scope);
    await this.disk.mutate(async () => {
      const partition = await this.disk.read(scope.firebaseUid);
      partition.jobs = structuredClone(jobs);
      partition.revision = randomUUID();
      this.assert(scope);
      await this.disk.write(partition);
      this.assert(scope);
    });
  }
  async linkPersonal(
    localId: string,
    scope: SessionAccountScope,
    jobId: string,
    outputSha256: string,
  ): Promise<void> {
    this.assert(scope);
    if (!JOB.test(jobId)) throw new Error("INVALID_REQUEST");
    await this.disk.mutate(async () => {
      const guest = await this.disk.read(null),
        entry = guest.entries.find((row) => localTrackId(row) === localId);
      if (!entry || entry.vocals.sha256 !== outputSha256)
        throw new Error("LIBRARY_RESULT_INVALID");
      const account = await this.disk.read(scope.firebaseUid);
      account.links = account.links.filter((link) => link.localId !== localId);
      account.links.push({ localId, jobId, outputSha256 });
      account.revision = randomUUID();
      this.assert(scope);
      await this.disk.write(account);
      this.assert(scope);
    });
  }
  async deleteLocal(
    localId: string,
    scope: SessionAccountScope | null,
  ): Promise<LocalLibraryEntry> {
    this.assert(scope);
    return this.disk.mutate(async () => {
      const guest = await this.disk.read(null),
        entry = guest.entries.find((row) => localTrackId(row) === localId);
      if (!entry) throw new Error("LIBRARY_NOT_FOUND");
      guest.entries = guest.entries.filter((row) => row !== entry);
      guest.revision = randomUUID();
      this.assert(scope);
      await this.disk.write(guest);
      this.assert(scope);
      return entry;
    });
  }
}
