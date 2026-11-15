import { randomUUID } from "node:crypto";
import { readdir, lstat } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import { PERSONAL_UUID } from "../../shared/personal-contracts.js";
import type { VerifiedPersonalPair } from "./pair.js";
import { parsePersonalPair } from "./pair.js";
import type { LibraryArtifactCache } from "../library/artifacts.js";
import type { LibraryPins } from "../library/pins.js";
import { validateUploadGrant } from "../../../../chrome-extension/src/companion/local-sync-client.js";
import type {
  CommunityContribution,
  YouTubeCommunityClient,
} from "../../../../chrome-extension/src/companion/youtube-community-client.js";
import { uploadCloudAudio } from "../cloud/transfers.js";
import type { PersonalArtifact } from "../../shared/personal-contracts.js";
import { DesktopApiError } from "../../../../chrome-extension/src/companion/account-api.js";
import {
  sameConsumerProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
export interface PublicationRecord {
  version: 1;
  requestId: string;
  producerRequestId: string;
  jobId: string;
  videoId: string;
  originalSha256: string;
  vocalsSha256: string;
  originalBytes: number;
  vocalsBytes: number;
  claim: { owner: ConsumerProcessIdentity; nonce: string } | null;
  state: "pending" | "committed" | "discarded";
  ready: boolean;
  declared: boolean;
  reservation: CommunityContribution | null;
  revision: number;
  attempts: number;
  nextAttemptAt: number | null;
  errorCode: string | null;
  createdAt: number;
}
export type PublicationStatus = Pick<
  PublicationRecord,
  | "jobId"
  | "state"
  | "ready"
  | "declared"
  | "errorCode"
  | "attempts"
  | "revision"
  | "nextAttemptAt"
>;
export interface PublicationActivity {
  pending: number;
  busy: boolean;
  idle: boolean;
}
export function parsePublicationRecord(value: unknown): PublicationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("COMMUNITY_OUTBOX_CORRUPT");
  const row = value as PublicationRecord;
  if (
    Object.keys(row).sort().join() !==
      "attempts,claim,createdAt,declared,errorCode,jobId,nextAttemptAt,originalBytes,originalSha256,producerRequestId,ready,requestId,reservation,revision,state,version,videoId,vocalsBytes,vocalsSha256" ||
    row.version !== 1 ||
    ![row.requestId, row.jobId, row.producerRequestId].every((v) =>
      PERSONAL_UUID.test(v),
    ) ||
    !Number.isSafeInteger(row.originalBytes) ||
    row.originalBytes < 1 ||
    row.originalBytes > 256 * 1024 ** 2 ||
    !Number.isSafeInteger(row.vocalsBytes) ||
    row.vocalsBytes < 1 ||
    row.vocalsBytes > 30_000_000 ||
    !/^[A-Za-z0-9_-]{11}$/.test(row.videoId) ||
    ![row.originalSha256, row.vocalsSha256].every((v) =>
      /^[a-f0-9]{64}$/.test(v),
    ) ||
    !["pending", "committed", "discarded"].includes(row.state) ||
    typeof row.ready !== "boolean" ||
    typeof row.declared !== "boolean" ||
    ![row.revision, row.attempts, row.createdAt].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    ) ||
    row.attempts > 100 ||
    !(
      row.nextAttemptAt === null ||
      (Number.isSafeInteger(row.nextAttemptAt) && row.nextAttemptAt >= 0)
    ) ||
    !(row.errorCode === null || /^[A-Z_]{3,64}$/.test(row.errorCode))
  )
    throw new Error("COMMUNITY_OUTBOX_CORRUPT");
  if (row.claim !== null) {
    if (
      !row.claim ||
      Object.keys(row.claim).sort().join() !== "nonce,owner" ||
      !PERSONAL_UUID.test(row.claim.nonce)
    )
      throw new Error("COMMUNITY_OUTBOX_CORRUPT");
    processIdentityFromWire(processIdentityToWire(row.claim.owner));
  }
  if (row.reservation !== null) {
    const r = row.reservation;
    // Transient storage/provider grants are never persisted in the publication journal.
    if (
      !r ||
      Object.keys(r).sort().join() !==
        "contribution_id,expires_at,lease_expires_at,producer,profile_id,request_id,state,upload_grants,video_id" ||
      r.request_id !== row.producerRequestId ||
      r.video_id !== row.videoId ||
      r.profile_id !== "kim-vocal-2-full-timeline-v1" ||
      typeof r.producer !== "boolean" ||
      ![
        "preparing",
        "waiting",
        "awaiting_upload",
        "validating",
        "ready",
        "expired",
        "rejected",
        "failed",
      ].includes(r.state) ||
      !(
        r.contribution_id === null || /^[a-f0-9]{24}$/.test(r.contribution_id)
      ) ||
      !(r.expires_at === null || Number.isFinite(Date.parse(r.expires_at))) ||
      !(
        r.lease_expires_at === null ||
        Number.isFinite(Date.parse(r.lease_expires_at))
      ) ||
      r.upload_grants !== null
    )
      throw new Error("COMMUNITY_OUTBOX_CORRUPT");
  }
  return structuredClone(row);
}
export interface PublicationStore {
  list(): Promise<PublicationRecord[]>;
  mutate<T>(
    operation: (records: PublicationRecord[]) => Promise<T>,
  ): Promise<T>;
  write(record: PublicationRecord): Promise<void>;
}
export class WindowsPublicationStore implements PublicationStore {
  constructor(private readonly host: HostContext) {}
  async list(): Promise<PublicationRecord[]> {
    const root = "community\\outbox";
    await this.host.directory(root);
    await this.host.native.validatePath("personal", root, "directory");
    const names = await readdir(win32.join(this.host.personalRoot, root));
    if (names.length > 64) throw new Error("COMMUNITY_OUTBOX_FULL");
    const result: PublicationRecord[] = [];
    for (const id of names) {
      if (!PERSONAL_UUID.test(id)) throw new Error("COMMUNITY_OUTBOX_CORRUPT");
      await this.host.native.validatePath(
        "personal",
        `${root}\\${id}`,
        "directory",
      );
      try {
        await lstat(
          win32.join(this.host.personalRoot, root, id, "record.json"),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      const record = parsePublicationRecord(
        JSON.parse(
          (
            await readPrivateBytes(
              this.host,
              `${root}\\${id}\\record.json`,
              4096,
            )
          ).toString("utf8"),
        ),
      );
      if (record.requestId !== id) throw new Error("COMMUNITY_OUTBOX_CORRUPT");
      result.push(record);
    }
    return result;
  }
  async mutate<T>(
    action: (records: PublicationRecord[]) => Promise<T>,
  ): Promise<T> {
    const lease = await this.host.native.acquireMutex("cache");
    if (!lease) throw new Error("LIBRARY_BUSY");
    try {
      return await action(await this.list());
    } finally {
      await this.host.native.releaseMutex(lease);
    }
  }
  async write(value: PublicationRecord): Promise<void> {
    const record = parsePublicationRecord(value);
    await writePrivateAtomic(
      this.host,
      `community\\outbox\\${record.requestId}\\record.json`,
      Buffer.from(JSON.stringify(record)),
    );
  }
}
export interface PublicationMediaPort {
  pair(jobId: string, signal: AbortSignal): Promise<VerifiedPersonalPair>;
  transfer(
    pair: VerifiedPersonalPair,
    grants: { original: unknown; vocals: unknown },
    signal: AbortSignal,
  ): Promise<void>;
  protect(
    pair: VerifiedPersonalPair,
    signal: AbortSignal,
  ): Promise<{ release(): Promise<void> }>;
}
export class WindowsPublicationMedia implements PublicationMediaPort {
  constructor(
    private readonly host: HostContext,
    private readonly cache: Pick<LibraryArtifactCache, "local" | "verify">,
    private readonly pins: Pick<LibraryPins, "pin">,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async pair(jobId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!PERSONAL_UUID.test(jobId)) throw new Error("COMMUNITY_SOURCE_INVALID");
    return parsePersonalPair(
      JSON.parse(
        (
          await readPrivateBytes(
            this.host,
            `personal\\results\\${jobId}\\pair.json`,
            32768,
          )
        ).toString("utf8"),
      ),
      this.host.report.installationId,
      jobId,
    );
  }
  async protect(pair: VerifiedPersonalPair, signal: AbortSignal) {
    const held: Awaited<ReturnType<LibraryPins["pin"]>>[] = [];
    try {
      for (const kind of ["original", "vocals"] as const) {
        const a = await this.cache.local(
            pair.entry.personalJobId,
            pair.entry[kind],
            kind === "vocals" ? "voice" : "original",
          ),
          pin = await this.pins.pin(a, "outbox");
        held.push(pin);
        if (
          pin.artifactId !== a.artifactId ||
          pin.relativePath !== a.relativePath ||
          pin.sha256 !== a.sha256
        )
          throw new Error("COMMUNITY_PIN_INVALID");
        await this.cache.verify(a, signal);
      }
      return {
        release: async () => {
          await Promise.allSettled(held.map((p) => p.release()));
        },
      };
    } catch (error) {
      await Promise.allSettled(held.map((p) => p.release()));
      throw error;
    }
  }
  async transfer(
    pair: VerifiedPersonalPair,
    grants: { original: unknown; vocals: unknown },
    signal: AbortSignal,
  ) {
    let failure: unknown;
    for (const kind of ["original", "vocals"] as const) {
      try {
        const item = pair.entry[kind],
          extension =
            kind === "original" ? pair.filenames.original.slice(9) : "mp3",
          relative = `personal\\results\\${pair.entry.personalJobId}\\${kind === "original" ? pair.filenames.original : "vocals.mp3"}`;
        const declaration = wire(item, extension),
          grant = validateUploadGrant(grants[kind], {
            path: win32.join(this.host.personalRoot, relative),
            extension: extension as "m4a",
            content_type: item.contentType,
            bytes: item.bytes,
            sha256: item.sha256,
            duration_seconds: item.durationSeconds,
          });
        const file = await this.host.native.openPrivateFile(
          relative,
          "read",
          item.bytes,
        );
        if (!file) throw new Error("COMMUNITY_SOURCE_INVALID");
        await uploadCloudAudio(
          { path: win32.join(this.host.personalRoot, relative), file },
          declaration,
          grant,
          {
            signal,
            assertCurrent: () => signal.throwIfAborted(),
            fetch: this.fetcher,
          },
        );
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
  }
}
function wire(item: PersonalArtifact, extension: string) {
  return {
    extension,
    content_type: item.contentType,
    bytes: item.bytes,
    sha256: Buffer.from(item.sha256, "hex").toString("base64"),
    duration_seconds: item.durationSeconds,
  };
}
function declarations(pair: VerifiedPersonalPair) {
  const { original, vocals } = pair.entry;
  return {
    original: {
      ...wire(original, pair.filenames.original.slice(9)),
      sha256: original.sha256,
    },
    vocals: { ...wire(vocals, "mp3"), sha256: vocals.sha256 },
  };
}
function checked(pair: VerifiedPersonalPair, record?: PublicationRecord): void {
  if (
    !pair.reuse ||
    pair.reuse.source.kind !== "youtube" ||
    pair.entry.catalog.trim_enabled ||
    pair.reuse.vocalsSha256 !== pair.entry.vocals.sha256 ||
    pair.reuse.originalSha256 !== pair.entry.original.sha256 ||
    (record &&
      (record.jobId !== pair.entry.personalJobId ||
        record.videoId !== pair.reuse.source.videoId ||
        record.vocalsSha256 !== pair.entry.vocals.sha256 ||
        record.originalSha256 !== pair.entry.original.sha256 ||
        record.originalBytes !== pair.entry.original.bytes ||
        record.vocalsBytes !== pair.entry.vocals.bytes))
  )
    throw new Error("COMMUNITY_SOURCE_INVALID");
}
/** Durable idempotent producer commands; playback release and metadata declaration are separate. */
export class WindowsCommunityPublisher {
  private readonly listeners = new Set<(jobId: string) => void>();
  private readonly activityListeners = new Set<
    (value: PublicationActivity) => void
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private active: Promise<void> | null = null;
  private abort = new AbortController();
  private readonly operations = new Map<string, AbortController>();
  private readonly deferredPlayback = new Map<string, string>();
  constructor(
    private readonly options: {
      store: PublicationStore;
      media: PublicationMediaPort;
      client: Pick<
        YouTubeCommunityClient,
        "reserve" | "uploadGrants" | "complete" | "lookup" | "wait"
      >;
      identity(): Promise<ConsumerProcessIdentity>;
      processIdentity(pid: number): Promise<ConsumerProcessIdentity | null>;
      now?: () => number;
      consumersAllowed?(): boolean;
    },
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private intakeAllowed(): boolean {
    return this.options.consumersAllowed?.() ?? true;
  }
  activity(): PublicationActivity {
    const pending = this.pending.size,
      busy = pending > 0 || this.active !== null || this.operations.size > 0;
    return { pending, busy, idle: !busy };
  }
  subscribeActivity(
    listener: (value: PublicationActivity) => void,
  ): () => void {
    this.activityListeners.add(listener);
    listener(this.activity());
    return () => {
      this.activityListeners.delete(listener);
    };
  }
  private activityChanged(): void {
    for (const listener of this.activityListeners) {
      try {
        listener(this.activity());
      } catch {}
    }
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("COMMUNITY_CLOSED"));
    const task = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.pending.delete(task);
        this.activityChanged();
      });
    this.pending.add(task);
    this.activityChanged();
    return task;
  }
  /** Own durable writes only. Other-process Ready/events may explicitly read snapshot. */
  subscribe(listener: (jobId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  snapshot(jobId: string): Promise<PublicationStatus | null> {
    return this.track(() => this.readSnapshot(jobId));
  }
  private async readSnapshot(jobId: string): Promise<PublicationStatus | null> {
    if (!PERSONAL_UUID.test(jobId)) throw new Error("COMMUNITY_SOURCE_INVALID");
    const raw = (await this.options.store.list()).find(
      (record) => record.jobId === jobId,
    );
    if (!raw) return null;
    const record = parsePublicationRecord(raw),
      { state, ready, declared, errorCode, attempts, revision, nextAttemptAt } =
        record;
    return {
      jobId,
      state,
      ready,
      declared,
      errorCode,
      attempts,
      revision,
      nextAttemptAt,
    };
  }
  private async write(record: PublicationRecord): Promise<void> {
    await this.options.store.write(record);
    for (const listener of this.listeners) {
      try {
        listener(record.jobId);
      } catch {}
    }
  }
  stage(
    jobId: string,
    deferUntilPlayback = false,
    reserved?: CommunityContribution,
  ): Promise<PublicationRecord> {
    if (!this.intakeAllowed())
      return Promise.reject(new Error("CONSUMERS_PAUSED"));
    return this.track(async () => {
      let record = await this.stageRecord(jobId, deferUntilPlayback, reserved);
      const played = this.deferredPlayback.get(jobId);
      if (played !== undefined && this.intakeAllowed()) {
        record = await this.releaseRecord(jobId, played);
        this.deferredPlayback.delete(jobId);
      }
      return record;
    });
  }
  private async stageRecord(
    jobId: string,
    deferUntilPlayback = false,
    reserved?: CommunityContribution,
  ): Promise<PublicationRecord> {
    const pair = await this.options.media.pair(jobId, this.abort.signal);
    checked(pair);
    const pin = await this.options.media.protect(pair, this.abort.signal);
    try {
      return await this.options.store.mutate(async (records) => {
        const found = records.find((r) => r.jobId === jobId);
        if (found) {
          checked(pair, found);
          return found;
        }
        if (
          records.length >= 64 ||
          records
            .filter((r) => r.state === "pending")
            .reduce((n, r) => n + r.originalBytes + r.vocalsBytes, 0) +
            pair.entry.original.bytes +
            pair.entry.vocals.bytes >
            512 * 1024 ** 2
        )
          throw new Error("COMMUNITY_OUTBOX_FULL");
        const requestId = reserved?.request_id ?? randomUUID();
        const record: PublicationRecord = {
          version: 1,
          requestId,
          producerRequestId: requestId,
          jobId,
          videoId:
            pair.reuse!.source.kind === "youtube"
              ? pair.reuse!.source.videoId
              : "",
          originalSha256: pair.entry.original.sha256,
          vocalsSha256: pair.entry.vocals.sha256,
          originalBytes: pair.entry.original.bytes,
          vocalsBytes: pair.entry.vocals.bytes,
          claim: null,
          state: "pending",
          ready: !deferUntilPlayback,
          declared: false,
          reservation: reserved ? { ...reserved, upload_grants: null } : null,
          revision: 0,
          attempts: 0,
          nextAttemptAt: null,
          errorCode: null,
          createdAt: this.now(),
        };
        parsePublicationRecord(record);
        await this.write(record);
        return record;
      });
    } finally {
      await pin.release();
    }
  }
  releasePlayback(jobId: string, sha256: string): Promise<void> {
    if (!PERSONAL_UUID.test(jobId) || !/^[a-f0-9]{64}$/u.test(sha256))
      return Promise.reject(new Error("COMMUNITY_SOURCE_INVALID"));
    if (!this.intakeAllowed()) {
      if (this.closing) return Promise.reject(new Error("COMMUNITY_CLOSED"));
      const previous = this.deferredPlayback.get(jobId);
      if (previous && previous !== sha256)
        return Promise.reject(new Error("COMMUNITY_SOURCE_INVALID"));
      if (!previous && this.deferredPlayback.size >= 64)
        return Promise.reject(new Error("COMMUNITY_OUTBOX_FULL"));
      this.deferredPlayback.set(jobId, sha256);
      return Promise.resolve();
    }
    return this.track(async () => {
      await this.releaseRecord(jobId, sha256);
      this.deferredPlayback.delete(jobId);
    });
  }
  private async releaseRecord(
    jobId: string,
    sha256: string,
  ): Promise<PublicationRecord> {
    return this.options.store.mutate(async (records) => {
      const record = records.find((r) => r.jobId === jobId);
      if (!record || record.vocalsSha256 !== sha256)
        throw new Error("COMMUNITY_SOURCE_INVALID");
      if (!record.ready) {
        const released = {
          ...record,
          ready: true,
          revision: record.revision + 1,
        };
        await this.write(released);
        return released;
      }
      return record;
    });
  }
  discard(requestId: string): Promise<void> {
    return this.track(() => this.discardRecord(requestId));
  }
  private async discardRecord(requestId: string): Promise<void> {
    await this.options.store.mutate(async (records) => {
      const r = records.find((r) => r.requestId === requestId);
      if (!r) throw new Error("COMMUNITY_OUTBOX_CORRUPT");
      await this.write({
        ...r,
        state: "discarded",
        revision: r.revision + 1,
      });
    });
    this.operations.get(requestId)?.abort();
  }
  retry(requestId: string): Promise<void> {
    if (!this.intakeAllowed())
      return Promise.reject(new Error("CONSUMERS_PAUSED"));
    return this.track(() => this.retryRecord(requestId));
  }
  private async retryRecord(requestId: string): Promise<void> {
    await this.options.store.mutate(async (records) => {
      const record = records.find((r) => r.requestId === requestId);
      if (!record || record.state !== "pending")
        throw new Error("COMMUNITY_OUTBOX_CONFLICT");
      await this.write({
        ...record,
        attempts: 0,
        nextAttemptAt: null,
        errorCode: null,
        revision: record.revision + 1,
      });
    });
    await this.drain();
  }
  view() {
    return this.track(() => this.readView());
  }
  private async readView() {
    return (await this.options.store.list()).map(
      ({
        requestId,
        jobId,
        state,
        ready,
        declared,
        errorCode,
        nextAttemptAt,
      }) => ({
        requestId,
        jobId,
        state,
        ready,
        declared,
        errorCode,
        nextAttemptAt,
      }),
    );
  }
  retainedDirectories(): Promise<Set<string>> {
    return this.track(() => this.readRetainedDirectories());
  }
  private async readRetainedDirectories(): Promise<Set<string>> {
    return new Set(
      (await this.options.store.list())
        .filter((r) => r.state === "pending")
        .map((r) => `personal\\results\\${r.jobId}`),
    );
  }
  private async update(
    record: PublicationRecord,
    patch: Partial<PublicationRecord>,
  ): Promise<PublicationRecord> {
    return this.options.store.mutate(async (records) => {
      const current = records.find((r) => r.requestId === record.requestId);
      if (
        !current ||
        (record.claim
          ? current.claim?.nonce !== record.claim.nonce
          : current.revision !== record.revision) ||
        current.state !== "pending"
      )
        throw new Error("COMMUNITY_OUTBOX_CONFLICT");
      const next = { ...current, ...patch, revision: current.revision + 1 };
      await this.write(next);
      return next;
    });
  }
  private async claim(
    record: PublicationRecord,
  ): Promise<PublicationRecord | null> {
    const owner = await this.options.identity();
    return this.options.store.mutate(async (records) => {
      const current = records.find((r) => r.requestId === record.requestId);
      if (!current || current.state !== "pending") return null;
      if (current.claim) {
        const live = await this.options.processIdentity(
          current.claim.owner.pid,
        );
        if (live && sameConsumerProcess(live, current.claim.owner)) return null;
      }
      const next = {
        ...current,
        claim: { owner, nonce: randomUUID() },
        revision: current.revision + 1,
      };
      await this.write(next);
      return next;
    });
  }
  private async releaseClaim(record: PublicationRecord): Promise<void> {
    if (!record.claim) return;
    await this.options.store.mutate(async (records) => {
      const current = records.find((r) => r.requestId === record.requestId);
      if (current && current.claim?.nonce === record.claim?.nonce)
        await this.write({
          ...current,
          claim: null,
          revision: current.revision + 1,
        });
    });
  }
  drain(): Promise<void> {
    if (this.active) return this.active;
    if (!this.intakeAllowed()) return Promise.resolve();
    this.active = this.track(() => this.run()).finally(() => {
      this.active = null;
      this.activityChanged();
    });
    return this.active;
  }
  resume(): Promise<void> {
    if (!this.intakeAllowed()) return Promise.resolve();
    return this.track(async () => {
      for (const [job, sha] of this.deferredPlayback) {
        if (!this.intakeAllowed()) return;
        // Completion may not have staged this pair yet; stage applies its later release.
        if (
          !(await this.options.store.list()).some(
            (record) => record.jobId === job,
          )
        )
          continue;
        await this.releaseRecord(job, sha);
        this.deferredPlayback.delete(job);
      }
      await this.drain();
    });
  }
  private async run(): Promise<void> {
    for (let record of await this.options.store.list()) {
      if (!this.intakeAllowed()) return;
      if (
        record.state !== "pending" ||
        (record.nextAttemptAt !== null && record.nextAttemptAt > this.now()) ||
        record.attempts >= 8
      )
        continue;
      const claimed = await this.claim(record);
      if (!claimed) continue;
      record = claimed;
      const operation = new AbortController();
      this.operations.set(record.requestId, operation);
      const signal = AbortSignal.any([
        this.abort.signal,
        operation.signal,
        AbortSignal.timeout(20 * 60000),
      ]);
      let pin: Awaited<ReturnType<PublicationMediaPort["protect"]>> | undefined;
      try {
        const pair = await this.options.media.pair(record.jobId, signal);
        checked(pair, record);
        pin = await this.options.media.protect(pair, signal);
        const declaration = declarations(pair);
        if (!record.reservation) {
          const reservation = await this.options.client.reserve(
            record.videoId,
            signal,
            record.producerRequestId,
          );
          signal.throwIfAborted();
          record = await this.update(record, {
            reservation: { ...reservation, upload_grants: null },
          });
        }
        let next = record.reservation!;
        if (next.state !== "ready") {
          if (!next.producer) {
            const result = await this.options.client.wait(
              record.videoId,
              signal,
            );
            if (result !== "ready")
              throw new Error("COMMUNITY_PRODUCER_UNAVAILABLE");
            next = { ...next, state: "ready" };
          } else {
            next = await this.options.client.uploadGrants(
              next,
              declaration.original,
              declaration.vocals,
              signal,
            );
            record = await this.update(record, {
              reservation: { ...next, upload_grants: null },
              declared: true,
            });
          }
        }
        if (next.state === "ready") {
          // A different producer may have committed different bytes; reuse is allowed, ownership stays transparent.
          if (
            !(await this.options.client.lookup(
              record.videoId,
              pair.entry.original.durationSeconds,
              signal,
            ))
          )
            throw new Error("COMMUNITY_REPLY_INVALID");
          record = await this.update(record, {
            state: "committed",
            nextAttemptAt: null,
            errorCode: null,
          });
          continue;
        }
        if (!record.ready) continue;
        if (!next.producer || !next.upload_grants)
          throw new Error("COMMUNITY_UPLOAD_UNAVAILABLE");
        let transferError: unknown;
        try {
          await this.options.media.transfer(pair, next.upload_grants, signal);
        } catch (error) {
          transferError = error;
        }
        // Completion HEAD can confirm an ambiguous immutable PUT without repeating inference/reservation.
        try {
          next = await this.options.client.complete(next, signal);
        } catch (error) {
          throw transferError ?? error;
        }
        if (next.state !== "ready") throw new Error("COMMUNITY_NOT_COMMITTED");
        await this.update(record, {
          state: "committed",
          reservation: { ...next, upload_grants: null },
          nextAttemptAt: null,
          errorCode: null,
        });
      } catch (error) {
        if (!signal.aborted) {
          const code =
            error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message)
              ? error.message
              : "COMMUNITY_PUBLISH_FAILED";
          await this.update(record, {
            attempts: record.attempts + 1,
            errorCode: code,
            nextAttemptAt:
              this.now() +
              Math.min(300000, 1000 * 2 ** Math.min(record.attempts, 8)),
            ...(error instanceof DesktopApiError &&
            [
              "YOUTUBE_CONTRIBUTION_NOT_FOUND",
              "YOUTUBE_CONTRIBUTION_EXPIRED",
            ].includes(error.code)
              ? {
                  producerRequestId: randomUUID(),
                  reservation: null,
                  declared: false,
                }
              : {}),
          }).catch(() => {});
        }
      } finally {
        await pin?.release();
        this.operations.delete(record.requestId);
        await this.releaseClaim(record);
      }
    }
  }
  dispose(): Promise<void> {
    if (!this.closing)
      this.closing = Promise.resolve().then(async () => {
        this.abort.abort();
        await Promise.allSettled(this.pending);
        await this.active?.catch(() => {});
        this.listeners.clear();
        this.activityListeners.clear();
        this.deferredPlayback.clear();
      });
    return this.closing;
  }
}
