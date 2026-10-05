import { verifyPrivateAudio } from "./audio-integrity.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  isLocalAudioDeclaration,
  MVP_MAX_DURATION_SECONDS,
  type LocalAudioArtifact,
  type LocalAudioDeclaration,
} from "../shared/protocol.js";
import { desktopRecord } from "../shared/desktop-protocol.js";
import { DesktopApiError } from "./account-api.js";
import { privateDirectory } from "./app-setup.js";
import { withCacheMutation } from "./cache-mutator.js";
import { validateUploadGrant } from "./local-sync-client.js";
import {
  type CommunityContribution,
  YouTubeCommunityClient,
  YOUTUBE_COMMUNITY_PROFILE,
} from "./youtube-community-client.js";
import type { LocalLibraryOwner } from "./sync-outbox.js";

const MAX_BYTES = 512 * 1024 ** 2;
const MAX_RECORDS = 64;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface CommunityOutboxRecord {
  version: 1;
  contribution_id: string;
  request_id: string;
  video_id: string;
  expires_at: string;
  state: "pending" | "committed";
  original: LocalAudioArtifact;
  vocals: LocalAudioArtifact;
  cache_reused?: true;
  producer_request_id?: string;
  next_request_id?: string;
  /** False until the matching native playback has actually started. Legacy pairs are eligible. */
  publication_ready?: boolean;
  /** Immutable declarations are admitted independently of transferring their bytes. */
  publication_declared?: boolean;
}
export interface CommunityOwnerLink {
  version: 1;
  owner: LocalLibraryOwner;
  request_id: string;
  cache_key: string;
  video_id: string;
  duration_seconds: number;
  sha256: string;
  state: "pending" | "deferred" | "completed";
  expires_at: string;
}
async function privateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(),
      named = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > 16384 ||
      info.ino !== named.ino ||
      info.dev !== named.dev ||
      named.isSymbolicLink()
    )
      throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function writeRecord(
  root: string,
  record: CommunityOutboxRecord | CommunityOwnerLink,
): Promise<void> {
  const temporary = join(root, `.record-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(root, "record.json"));
  await syncDirectory(root);
}
async function checkedFile(item: LocalAudioArtifact): Promise<void> {
  const { path: _path, ...declaration } = item;
  if (!isLocalAudioDeclaration(declaration))
    throw new DesktopApiError("COMMUNITY_ARTIFACT_INVALID");
  if (!(await verifyPrivateAudio(item.path, item.bytes, item.sha256)))
    throw new DesktopApiError("COMMUNITY_ARTIFACT_INVALID");
}
function view(record: CommunityOutboxRecord): CommunityContribution {
  return {
    contribution_id: record.contribution_id,
    request_id: record.producer_request_id ?? record.request_id,
    video_id: record.video_id,
    profile_id: YOUTUBE_COMMUNITY_PROFILE,
    state: "awaiting_upload",
    producer: true,
    expires_at: record.expires_at,
    lease_expires_at: null,
    upload_grants: null,
  };
}

/** No credentials or signed URLs are persisted. Both bytes survive native scratch cleanup. */
export class YouTubeCommunityOutbox {
  private drainTask: Promise<void> | undefined;
  constructor(
    readonly root: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  /** Brief metadata contention must not turn background saving into a failed foreground start. */
  private async mutateMetadata<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const deadline = performance.now() + 2_000;
    while (true) {
      if (signal?.aborted) throw new DesktopApiError("CANCELLED");
      let entered = false;
      try {
        return await withCacheMutation(this.root, async () => {
          entered = true;
          if (signal?.aborted) throw new DesktopApiError("CANCELLED");
          return operation();
        });
      } catch (error) {
        // Never replay a mutation whose writes or observers may already have run.
        if (
          entered ||
          !(error instanceof Error) ||
          error.message !== "LOCAL_COMPANION_BUSY" ||
          performance.now() >= deadline
        )
          throw error;
      }
      try {
        await delay(
          Math.min(50, Math.max(1, deadline - performance.now())),
          undefined,
          {
            signal,
          },
        );
      } catch (error) {
        if (signal?.aborted) throw new DesktopApiError("CANCELLED");
        throw error;
      }
    }
  }
  private ownerRoot(owner: LocalLibraryOwner): string {
    if (
      !/^[A-Za-z0-9_.:@+-]{1,128}$/.test(owner.uid) ||
      !UUID.test(owner.session_generation)
    )
      throw new DesktopApiError("COMMUNITY_OWNER_INVALID");
    return join(
      this.root,
      "owner-links",
      createHash("sha256").update(owner.uid).digest("hex"),
    );
  }
  async ownerLinks(owner: LocalLibraryOwner): Promise<CommunityOwnerLink[]> {
    const root = this.ownerRoot(owner);
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, "owner-links"));
    await privateDirectory(root);
    const links: CommunityOwnerLink[] = [];
    for (const id of await readdir(root)) {
      if (!UUID.test(id)) continue;
      await privateDirectory(join(root, id));
      const raw = await privateJson(join(root, id, "record.json"));
      if (
        !desktopRecord(raw) ||
        Object.keys(raw).length !== 9 ||
        raw.version !== 1 ||
        raw.request_id !== id ||
        !desktopRecord(raw.owner) ||
        Object.keys(raw.owner).length !== 2 ||
        raw.owner.uid !== owner.uid ||
        !UUID.test(String(raw.owner.session_generation)) ||
        !/^[a-f0-9]{64}$/.test(String(raw.cache_key)) ||
        !/^[a-f0-9]{64}$/.test(String(raw.sha256)) ||
        !/^[A-Za-z0-9_-]{11}$/.test(String(raw.video_id)) ||
        typeof raw.duration_seconds !== "number" ||
        raw.duration_seconds <= 0 ||
        raw.duration_seconds > MVP_MAX_DURATION_SECONDS ||
        !Number.isFinite(raw.duration_seconds) ||
        !["pending", "deferred", "completed"].includes(String(raw.state)) ||
        typeof raw.expires_at !== "string" ||
        !Number.isFinite(Date.parse(raw.expires_at))
      )
        throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
      links.push(raw as unknown as CommunityOwnerLink);
      if (links.length > 128)
        throw new DesktopApiError("COMMUNITY_OUTBOX_FULL");
    }
    return links;
  }
  async linkOwner(
    owner: LocalLibraryOwner,
    input: Pick<
      CommunityOwnerLink,
      "cache_key" | "video_id" | "duration_seconds" | "sha256"
    >,
  ): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(input.cache_key) ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !/^[A-Za-z0-9_-]{11}$/.test(input.video_id) ||
      !Number.isFinite(input.duration_seconds) ||
      input.duration_seconds <= 0 ||
      input.duration_seconds > MVP_MAX_DURATION_SECONDS
    )
      throw new DesktopApiError("COMMUNITY_OWNER_INVALID");
    await this.mutateMetadata(async () => {
      const links = await this.ownerLinks(owner);
      for (const link of links)
        if (Date.parse(link.expires_at) <= Date.now())
          await rm(join(this.ownerRoot(owner), link.request_id), {
            recursive: true,
          });
      const existing = links.find(
        (link) =>
          link.cache_key === input.cache_key &&
          Date.parse(link.expires_at) > Date.now(),
      );
      if (existing) {
        if (
          existing.sha256 !== input.sha256 ||
          existing.video_id !== input.video_id
        )
          throw new DesktopApiError("COMMUNITY_OUTBOX_CONFLICT");
        return;
      }
      if (
        links.filter((link) => Date.parse(link.expires_at) > Date.now())
          .length >= 128
      )
        throw new DesktopApiError("COMMUNITY_OUTBOX_FULL");
      const request_id = randomUUID(),
        directory = join(this.ownerRoot(owner), request_id);
      await privateDirectory(directory);
      const record: CommunityOwnerLink = {
        version: 1,
        owner: { ...owner },
        request_id,
        ...input,
        state: "pending",
        expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      };
      await writeRecord(directory, record);
      await syncDirectory(this.ownerRoot(owner));
    });
  }
  async finishOwnerLink(
    owner: LocalLibraryOwner,
    link: CommunityOwnerLink,
    ready: boolean,
  ): Promise<void> {
    await this.mutateMetadata(async () => {
      const current = (await this.ownerLinks(owner)).find(
        (item) => item.request_id === link.request_id,
      );
      if (!current || current.sha256 !== link.sha256)
        throw new DesktopApiError("COMMUNITY_OUTBOX_CONFLICT");
      await writeRecord(join(this.ownerRoot(owner), link.request_id), {
        ...current,
        state: ready ? "completed" : "deferred",
      });
    });
  }
  async assertAdmission(): Promise<void> {
    await this.mutateMetadata(async () => {
      await this.prune();
      const records = await this.records();
      const pending = records.filter((record) => record.state === "pending");
      const bytes =
        pending.reduce(
          (sum, record) => sum + record.original.bytes + record.vocals.bytes,
          0,
        ) + (await this.stagingBytes());
      // The local original limit plus maximum 1,200-second MP3 output is reserved before acquisition.
      if (records.length >= MAX_RECORDS || bytes + 288 * 1024 ** 2 > MAX_BYTES)
        throw new DesktopApiError("COMMUNITY_OUTBOX_FULL");
    });
  }
  async records(): Promise<CommunityOutboxRecord[]> {
    await privateDirectory(this.root);
    const result: CommunityOutboxRecord[] = [];
    for (const name of await readdir(this.root)) {
      if (!UUID.test(name)) continue;
      const directory = join(this.root, name);
      await privateDirectory(directory);
      const raw = await privateJson(join(directory, "record.json"));
      if (
        !desktopRecord(raw) ||
        Object.keys(raw).some(
          (key) =>
            ![
              "version",
              "contribution_id",
              "request_id",
              "video_id",
              "expires_at",
              "state",
              "original",
              "vocals",
              "cache_reused",
              "producer_request_id",
              "next_request_id",
              "publication_ready",
              "publication_declared",
            ].includes(key),
        ) ||
        Object.keys(raw).length < 8 ||
        (raw.cache_reused !== undefined && raw.cache_reused !== true) ||
        (raw.publication_ready !== undefined &&
          typeof raw.publication_ready !== "boolean") ||
        (raw.publication_declared !== undefined &&
          typeof raw.publication_declared !== "boolean") ||
        (raw.producer_request_id !== undefined &&
          !UUID.test(String(raw.producer_request_id))) ||
        (raw.next_request_id !== undefined &&
          !UUID.test(String(raw.next_request_id))) ||
        raw.version !== 1 ||
        raw.request_id !== name ||
        !/^[a-f0-9]{24}$/.test(String(raw.contribution_id)) ||
        !/^[A-Za-z0-9_-]{11}$/.test(String(raw.video_id)) ||
        typeof raw.expires_at !== "string" ||
        !Number.isFinite(Date.parse(raw.expires_at)) ||
        !["pending", "committed"].includes(String(raw.state)) ||
        !desktopRecord(raw.original) ||
        !desktopRecord(raw.vocals)
      )
        throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
      for (const [kind, item] of [
        ["original", raw.original],
        ["vocals", raw.vocals],
      ] as const) {
        const { path, ...declaration } = item;
        if (
          !isLocalAudioDeclaration(declaration) ||
          path !== join(directory, `${kind}.${declaration.extension}`) ||
          (kind === "vocals" && declaration.extension !== "mp3")
        )
          throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
      }
      result.push(raw as unknown as CommunityOutboxRecord);
      if (result.length > MAX_RECORDS)
        throw new DesktopApiError("COMMUNITY_OUTBOX_FULL");
    }
    return result;
  }
  async stage(
    contribution: CommunityContribution,
    original: LocalAudioArtifact,
    vocals: LocalAudioArtifact,
    options: { defer_publication?: boolean } = {},
  ): Promise<void> {
    if (
      !contribution.producer ||
      !contribution.contribution_id ||
      !contribution.expires_at ||
      !UUID.test(contribution.request_id) ||
      contribution.state !== "preparing" ||
      !/^[A-Za-z0-9_-]{11}$/.test(contribution.video_id) ||
      Date.parse(contribution.expires_at) <= Date.now() ||
      original.bytes + vocals.bytes > MAX_BYTES ||
      vocals.extension !== "mp3" ||
      Math.abs(original.duration_seconds - vocals.duration_seconds) > 0.25
    )
      throw new DesktopApiError("COMMUNITY_ARTIFACT_INVALID");
    const contributionId = contribution.contribution_id,
      expiresAt = contribution.expires_at;
    await this.mutateMetadata(async () => {
      await this.prune();
      const records = await this.records();
      const existing = records.find(
        (record) => record.request_id === contribution.request_id,
      );
      if (existing) {
        if (
          existing.contribution_id !== contribution.contribution_id ||
          existing.original.sha256 !== original.sha256 ||
          existing.vocals.sha256 !== vocals.sha256
        )
          throw new DesktopApiError("COMMUNITY_OUTBOX_CONFLICT");
        return;
      }
      const bytes =
        records
          .filter((record) => record.state === "pending")
          .reduce(
            (sum, record) => sum + record.original.bytes + record.vocals.bytes,
            0,
          ) + (await this.stagingBytes());
      if (
        records.length >= MAX_RECORDS ||
        bytes + original.bytes + vocals.bytes > MAX_BYTES
      )
        throw new DesktopApiError("COMMUNITY_OUTBOX_FULL");
      await checkedFile(original);
      await checkedFile(vocals);
      const temporary = join(this.root, `.pair-${contribution.request_id}`);
      await privateDirectory(temporary);
      const destination = join(this.root, contribution.request_id);
      try {
        for (const [kind, item] of [
          ["original", original],
          ["vocals", vocals],
        ] as const) {
          const path = join(temporary, `${kind}.${item.extension}`);
          await copyFile(item.path, path, constants.COPYFILE_EXCL);
          await checkedFile({ ...item, path });
          const file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            await file.sync();
          } finally {
            await file.close();
          }
        }
        const record: CommunityOutboxRecord = {
          version: 1,
          contribution_id: contributionId,
          request_id: contribution.request_id,
          video_id: contribution.video_id,
          expires_at: expiresAt,
          state: "pending",
          publication_ready: options.defer_publication !== true,
          original: {
            ...original,
            path: join(destination, `original.${original.extension}`),
          },
          vocals: { ...vocals, path: join(destination, "vocals.mp3") },
        };
        await writeRecord(temporary, record);
        await rename(temporary, destination);
        await syncDirectory(this.root);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    });
  }
  private async prune(): Promise<void> {
    await this.recoverStaging();
    for (const record of await this.records()) {
      if (Date.parse(record.expires_at) <= Date.now())
        await rm(join(this.root, record.request_id), { recursive: true });
    }
  }
  private async recoverStaging(): Promise<void> {
    const names = (await readdir(this.root)).filter((name) =>
      /^\.pair-[a-f0-9-]{36}$/.test(name),
    );
    if (names.length > MAX_RECORDS)
      throw new DesktopApiError("COMMUNITY_OUTBOX_FULL");
    for (const name of names) {
      const id = name.slice(6);
      if (!UUID.test(id)) throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
      const temporary = join(this.root, name),
        destination = join(this.root, id);
      await privateDirectory(temporary);
      if ((await lstat(temporary)).mtimeMs + 24 * 60 * 60_000 <= Date.now()) {
        await rm(temporary, { recursive: true });
        continue;
      }
      let raw: unknown;
      try {
        raw = await privateJson(join(temporary, "record.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        !desktopRecord(raw) ||
        raw.version !== 1 ||
        raw.request_id !== id ||
        raw.state !== "pending" ||
        !/^[a-f0-9]{24}$/.test(String(raw.contribution_id)) ||
        !/^[A-Za-z0-9_-]{11}$/.test(String(raw.video_id)) ||
        typeof raw.expires_at !== "string" ||
        !Number.isFinite(Date.parse(raw.expires_at)) ||
        !desktopRecord(raw.original) ||
        !desktopRecord(raw.vocals)
      )
        throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
      for (const [kind, item] of [
        ["original", raw.original],
        ["vocals", raw.vocals],
      ] as const) {
        const { path, ...declaration } = item;
        if (
          !isLocalAudioDeclaration(declaration) ||
          path !== join(destination, `${kind}.${declaration.extension}`) ||
          (kind === "vocals" && declaration.extension !== "mp3")
        )
          throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
        await checkedFile({
          ...declaration,
          path: join(temporary, `${kind}.${declaration.extension}`),
        });
      }
      const existing = await lstat(destination).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (!existing) {
        await rename(temporary, destination);
        await syncDirectory(this.root);
      } else {
        await privateDirectory(destination);
        const previous = await privateJson(join(destination, "record.json"));
        if (
          !desktopRecord(previous) ||
          previous.request_id !== id ||
          previous.contribution_id !== raw.contribution_id ||
          !desktopRecord(previous.original) ||
          !desktopRecord(previous.vocals) ||
          previous.original.sha256 !== raw.original.sha256 ||
          previous.vocals.sha256 !== raw.vocals.sha256
        )
          throw new DesktopApiError("COMMUNITY_OUTBOX_CONFLICT");
        await rm(temporary, { recursive: true });
      }
    }
  }
  private async stagingBytes(): Promise<number> {
    let bytes = 0;
    for (const name of await readdir(this.root)) {
      if (!/^\.pair-[a-f0-9-]{36}$/.test(name)) continue;
      const path = join(this.root, name);
      await privateDirectory(path);
      for (const file of await readdir(path)) {
        const info = await lstat(join(path, file));
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077
        )
          throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
        bytes += info.size;
        if (bytes > MAX_BYTES)
          throw new DesktopApiError("COMMUNITY_OUTBOX_FULL");
      }
    }
    return bytes;
  }
  /** Retry playback from durable validated vocals without acquiring or uploading again. */
  async restorePending(
    videoId: string,
    durationSeconds: number,
    workRoot: string,
    signal: AbortSignal,
  ): Promise<
    | {
        vocals: LocalAudioArtifact;
        original: LocalAudioDeclaration;
        publication_ready: boolean;
      }
    | undefined
  > {
    if (
      !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > MVP_MAX_DURATION_SECONDS
    )
      throw new DesktopApiError("COMMUNITY_ARTIFACT_INVALID");
    return this.mutateMetadata(async () => {
      if (signal.aborted) throw new DesktopApiError("CANCELLED");
      const record = (await this.records()).find(
        (entry) =>
          entry.video_id === videoId &&
          entry.state === "pending" &&
          Date.parse(entry.expires_at) > Date.now() &&
          Math.abs(entry.original.duration_seconds - durationSeconds) <= 2,
      );
      if (!record) return undefined;
      // Staged audio has already passed local timeline/model validation. Read and
      // copy under the metadata lock so receipt cleanup cannot remove its files.
      await checkedFile(record.vocals);
      await privateDirectory(workRoot);
      const path = join(workRoot, "pending-vocals.mp3");
      const vocals = { ...record.vocals, path };
      await copyFile(record.vocals.path, path, constants.COPYFILE_EXCL);
      try {
        await checkedFile(vocals);
        if (signal.aborted) throw new DesktopApiError("CANCELLED");
        const { path: _original, ...original } = record.original;
        return {
          vocals,
          original,
          publication_ready: record.publication_ready !== false,
        };
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
    }, signal);
  }
  /** Playback acknowledgement releases only the exact validated vocal identity. */
  async release(videoId: string, vocalsSha256: string): Promise<boolean> {
    if (
      !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
      !/^[a-f0-9]{64}$/.test(vocalsSha256)
    )
      throw new DesktopApiError("COMMUNITY_ARTIFACT_INVALID");
    return this.mutateMetadata(async () => {
      let found = false;
      for (const record of await this.records()) {
        if (
          record.video_id !== videoId ||
          record.vocals.sha256 !== vocalsSha256 ||
          record.state !== "pending" ||
          Date.parse(record.expires_at) <= Date.now()
        )
          continue;
        found = true;
        if (record.publication_ready === false)
          await writeRecord(join(this.root, record.request_id), {
            ...record,
            publication_ready: true,
          });
      }
      return found;
    });
  }
  async publicationState(
    videoId: string,
    vocalsSha256: string,
  ): Promise<"pending" | "saved" | undefined> {
    const records = (await this.records()).filter(
      (record) =>
        record.video_id === videoId &&
        record.vocals.sha256 === vocalsSha256 &&
        Date.parse(record.expires_at) > Date.now(),
    );
    if (records.some((record) => record.state === "pending")) return "pending";
    return records.some((record) => record.state === "committed")
      ? "saved"
      : undefined;
  }
  /** Freeze metadata to release acquisition admission; this never transfers media bytes. */
  private async declare(
    client: YouTubeCommunityClient,
    record: CommunityOutboxRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const { path: _original, ...original } = record.original;
    const { path: _vocals, ...vocals } = record.vocals;
    try {
      const next = await client.uploadGrants(
        view(record),
        original,
        vocals,
        signal,
      );
      if (next.producer && next.state === "preparing")
        throw new DesktopApiError("COMMUNITY_LEASE_INVALID");
    } catch (error) {
      // A rotated guest cannot own the old reservation. A definite missing or
      // expired contribution cannot hold its new acquisition allowance. Keep
      // the exact pair held; publication rebinds it only after matching playback.
      if (
        !(error instanceof DesktopApiError) ||
        !(
          (error.status === 404 &&
            error.code === "YOUTUBE_CONTRIBUTION_NOT_FOUND") ||
          (error.status === 410 &&
            error.code === "YOUTUBE_CONTRIBUTION_EXPIRED")
        )
      )
        throw error;
    }
    await this.mutateMetadata(async () => {
      const current = (await this.records()).find(
        (entry) => entry.request_id === record.request_id,
      );
      if (current?.state === "pending")
        await writeRecord(join(this.root, current.request_id), {
          ...current,
          publication_declared: true,
        });
    }, signal);
  }
  /** Metadata-only handoff before reserving another acquisition; no PUT or completion. */
  async declarePending(
    client: YouTubeCommunityClient,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const record of await this.records()) {
      if (signal?.aborted) throw new DesktopApiError("CANCELLED");
      if (
        record.state === "pending" &&
        !record.publication_declared &&
        Date.parse(record.expires_at) > Date.now()
      )
        await this.declare(client, record, signal);
    }
  }
  async drain(
    client: YouTubeCommunityClient,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.drainTask) return this.drainTask;
    // Network publication has its own cross-process lease; it never holds the
    // cache/outbox metadata lock while uploading or waiting for the backend.
    this.drainTask = withCacheMutation(join(this.root, ".publisher"), () =>
      this.drainOnce(client, signal),
    ).finally(() => {
      this.drainTask = undefined;
    });
    await this.drainTask;
  }
  private async drainOnce(
    client: YouTubeCommunityClient,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.mutateMetadata(() => this.prune(), signal);
    // Release prepared acquisition allowances before spending time on any PUT.
    for (const record of await this.records()) {
      if (signal?.aborted) return;
      if (
        record.state === "pending" &&
        record.publication_ready === false &&
        !record.publication_declared
      )
        await this.declare(client, record, signal).catch(() => {});
    }
    for (const record of await this.records()) {
      if (signal?.aborted) return;
      if (record.state === "committed") {
        // A crash after the durable receipt may leave copies; cleanup is safe to replay.
        await rm(record.original.path, { force: true });
        await rm(record.vocals.path, { force: true });
        continue;
      }
      if (record.publication_ready === false) continue;
      try {
        await this.publish(client, record, signal);
      } catch {
        /* Bytes remain durable for the next explicit recovery/startup. */
      }
    }
  }
  private async publish(
    client: YouTubeCommunityClient,
    record: CommunityOutboxRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    await checkedFile(record.original);
    await checkedFile(record.vocals);
    const { path: _originalPath, ...original } = record.original;
    const { path: _vocalsPath, ...vocals } = record.vocals;
    let next: CommunityContribution;
    try {
      if (record.next_request_id)
        ({ record, next } = await this.rebind(client, record, signal));
      else
        next = await client.uploadGrants(
          view(record),
          original,
          vocals,
          signal,
        );
    } catch (error) {
      if (
        !(error instanceof DesktopApiError) ||
        !(
          (error.status === 404 &&
            error.code === "YOUTUBE_CONTRIBUTION_NOT_FOUND") ||
          (error.status === 410 &&
            error.code === "YOUTUBE_CONTRIBUTION_EXPIRED")
        )
      )
        throw error;
      ({ record, next } = await this.rebind(client, record, signal));
    }
    if (next.state === "preparing" && record.producer_request_id)
      next = await client.uploadGrants(view(record), original, vocals, signal);
    for (
      let attempts = 0;
      next.state === "waiting" && !next.producer && attempts < 5;
      attempts++
    ) {
      const outcome = await client.wait(
        record.video_id,
        signal ?? AbortSignal.timeout(20 * 60_000),
      );
      if (outcome === "ready") {
        const ready = await client.lookup(
          record.video_id,
          record.original.duration_seconds,
          signal,
        );
        if (!ready) throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
        record = { ...record, cache_reused: true };
        next = { ...next, state: "ready" };
        break;
      }
      // A released producer lets the same owned immutable command reclaim its preparation lease.
      next = await client.uploadGrants(view(record), original, vocals, signal);
    }
    if (next.state === "waiting")
      throw new DesktopApiError("COMMUNITY_PRODUCER_UNAVAILABLE");
    if (next.state === "ready" && !next.producer && !record.cache_reused) {
      if (
        !(await client.lookup(
          record.video_id,
          record.original.duration_seconds,
          signal,
        ))
      )
        throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
      record = { ...record, cache_reused: true };
    }
    if (next.state !== "ready") {
      if (!next.upload_grants)
        throw new DesktopApiError("COMMUNITY_UPLOAD_UNAVAILABLE");
      // 412 means immutable bytes already exist; completion independently verifies exact R2 metadata/hash.
      let uploadError: unknown;
      for (const [kind, item] of [
        ["original", record.original],
        ["vocals", record.vocals],
      ] as const) {
        try {
          await this.upload(
            validateUploadGrant(next.upload_grants[kind], item),
            item,
            signal,
          );
        } catch (error) {
          uploadError = error;
        }
      }
      try {
        next = await client.complete(next, signal);
      } catch (error) {
        throw uploadError ?? error;
      }
    }
    if (next.state !== "ready")
      throw new DesktopApiError("COMMUNITY_NOT_COMMITTED");
    await this.mutateMetadata(async () => {
      const directory = join(this.root, record.request_id);
      // Durable receipt precedes any deletion of the retained original.
      await writeRecord(directory, { ...record, state: "committed" });
      await rm(record.original.path, { force: true });
      await rm(record.vocals.path, { force: true });
      await syncDirectory(directory);
      const linksRoot = join(this.root, "owner-links");
      await privateDirectory(linksRoot);
      for (const namespace of (await readdir(linksRoot)).slice(0, 256)) {
        if (!/^[a-f0-9]{64}$/.test(namespace)) continue;
        await privateDirectory(join(linksRoot, namespace));
        for (const id of (await readdir(join(linksRoot, namespace))).slice(
          0,
          128,
        )) {
          if (!UUID.test(id)) continue;
          const path = join(linksRoot, namespace, id);
          await privateDirectory(path);
          const raw = await privateJson(join(path, "record.json"));
          if (
            !desktopRecord(raw) ||
            !desktopRecord(raw.owner) ||
            typeof raw.owner.uid !== "string" ||
            createHash("sha256").update(raw.owner.uid).digest("hex") !==
              namespace
          )
            throw new DesktopApiError("COMMUNITY_OUTBOX_UNSAFE");
          if (
            raw.state === "deferred" &&
            raw.video_id === record.video_id &&
            raw.sha256 === record.vocals.sha256 &&
            typeof raw.expires_at === "string" &&
            Date.parse(raw.expires_at) > Date.now()
          )
            await writeRecord(path, {
              ...raw,
              state: "pending",
            } as unknown as CommunityOwnerLink);
        }
      }
    }, signal);
  }
  /** Capability rotation journals only new public IDs, retaining the exact prepared pair. */
  private async rebind(
    client: YouTubeCommunityClient,
    record: CommunityOutboxRecord,
    signal?: AbortSignal,
  ): Promise<{ record: CommunityOutboxRecord; next: CommunityContribution }> {
    const recoverySignal = signal ?? AbortSignal.timeout(20 * 60_000);
    for (let attempts = 0; attempts < 5; attempts++) {
      record = await this.mutateMetadata(async () => {
        const current = (await this.records()).find(
          (item) => item.request_id === record.request_id,
        );
        if (
          !current ||
          current.original.sha256 !== record.original.sha256 ||
          current.vocals.sha256 !== record.vocals.sha256
        )
          throw new DesktopApiError("COMMUNITY_OUTBOX_CONFLICT");
        if (current.next_request_id) return current;
        const updated = { ...current, next_request_id: randomUUID() };
        await writeRecord(join(this.root, current.request_id), updated);
        return updated;
      }, recoverySignal);
      const reservation = await client.reserve(
        record.video_id,
        recoverySignal,
        record.next_request_id!,
      );
      if (reservation.state === "ready") return { record, next: reservation };
      if (
        reservation.producer &&
        reservation.state === "preparing" &&
        reservation.contribution_id
      ) {
        const contributionId = reservation.contribution_id;
        record = await this.mutateMetadata(async () => {
          const current = (await this.records()).find(
            (item) => item.request_id === record.request_id,
          );
          if (
            !current ||
            current.original.sha256 !== record.original.sha256 ||
            current.vocals.sha256 !== record.vocals.sha256
          )
            throw new DesktopApiError("COMMUNITY_OUTBOX_CONFLICT");
          if (current.next_request_id !== reservation.request_id) {
            if (
              current.contribution_id === contributionId &&
              current.producer_request_id === reservation.request_id
            )
              return current;
            throw new DesktopApiError("COMMUNITY_OUTBOX_CONFLICT");
          }
          const updated = {
            ...current,
            contribution_id: contributionId,
            producer_request_id: reservation.request_id,
          };
          delete updated.next_request_id;
          await writeRecord(join(this.root, current.request_id), updated);
          return updated;
        }, recoverySignal);
        return { record, next: reservation };
      }
      const outcome = await client.wait(record.video_id, recoverySignal);
      if (outcome === "ready")
        return {
          record,
          next: { ...reservation, state: "ready", producer: false },
        };
      record = await this.mutateMetadata(async () => {
        const current = (await this.records()).find(
          (item) => item.request_id === record.request_id,
        );
        if (!current || current.next_request_id !== reservation.request_id)
          throw new DesktopApiError("COMMUNITY_OUTBOX_CONFLICT");
        const updated = { ...current };
        delete updated.next_request_id;
        await writeRecord(join(this.root, current.request_id), updated);
        return updated;
      }, recoverySignal);
    }
    throw new DesktopApiError("COMMUNITY_PRODUCER_UNAVAILABLE");
  }
  private async upload(
    grant: ReturnType<typeof validateUploadGrant>,
    item: LocalAudioArtifact,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = await open(
      item.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stream = file.createReadStream({ autoClose: false });
      try {
        const options: RequestInit & { duplex: "half" } = {
          method: "PUT",
          headers: { ...grant.headers, "Content-Length": String(item.bytes) },
          body: stream as unknown as BodyInit,
          duplex: "half",
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000),
        };
        const reply = await this.fetcher(grant.url, options);
        await reply.body?.cancel();
        if (!reply.ok && reply.status !== 412)
          throw new DesktopApiError("COMMUNITY_UPLOAD_REJECTED", reply.status);
      } finally {
        stream.destroy();
      }
    } finally {
      await file.close();
    }
  }
}
