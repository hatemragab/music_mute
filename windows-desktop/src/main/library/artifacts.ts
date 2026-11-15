import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { win32 } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { PrivateWritable } from "../../../../worker/src/platform/windows/consumer-private-file.js";
import { acquireLibraryCacheLease } from "./cache-lease.js";
import type { HostContext } from "../host-context.js";
import {
  newPrivateFile,
  readPrivateBytes,
  hashPrivateFile,
  verifyPrivateFile,
} from "../prepare/private-files.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { PersonalArtifact } from "../../shared/personal-contracts.js";
import type {
  JobMetadata,
  DownloadGrant,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import { downloadCloudArtifact } from "../cloud/transfers.js";
import { libraryNamespace } from "./store.js";
import {
  storageBirth,
  type StorageWriteLease,
} from "../storage/write-journal.js";
import type { ConsumerCacheFileIdentity } from "../../../../worker/src/platform/windows/consumer-native.js";
import { retireStorageLibraryArtifact } from "../storage/native-cleanup.js";
interface CreatedLibraryFile {
  relativePath: string;
  identity?: ConsumerCacheFileIdentity;
  handle?: FileHandle | PrivateWritable;
  closed?: true;
  completed?: true;
  publicationPending?: { writeId: string; component: "media" | "metadata" };
}
interface LibraryWriteCleanup {
  files: CreatedLibraryFile[];
  write?: StorageWriteLease;
  protection?: { release(): Promise<void> };
  reservation?: { release(): Promise<void> };
}
function createdFileIdentity(stat: BigIntStats): ConsumerCacheFileIdentity {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.ino === 0n ||
    stat.size < 0n ||
    stat.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("LIBRARY_RESULT_CHANGED");
  return {
    ...storageBirth(stat),
    bytes: Number(stat.size),
    writtenAt: String(stat.mtimeNs),
    changedAt: String(stat.ctimeNs),
  };
}
export interface CachedAccountArtifact {
  version: 1;
  ownerUid: string;
  jobId: string;
  artifactId: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  durationSeconds: number;
  contentType: string;
  variant: "voice" | "original";
  createdAt: number;
}
export interface TrustedLibraryArtifact {
  relativePath: string;
  artifactId: string;
  bytes: number;
  sha256: string;
  mime: string;
  durationSeconds: number;
}
export interface LibraryCacheAdmissionHooks {
  beginWrite?(
    relative: string,
    kind: "file" | "tree",
  ): Promise<StorageWriteLease>;
  protectTree(
    relative: string,
    purpose: "download",
  ): Promise<{ release(): Promise<void> }>;
  reserveVoice(
    bytes: number,
    relative: string,
  ): Promise<{ release(): Promise<void> }>;
}
export class LibraryArtifactCache {
  private admission: LibraryCacheAdmissionHooks | undefined;
  /** Exact created generations and their admission leases survive uncertain deletion/ACK. */
  private readonly retainedCleanup = new Set<LibraryWriteCleanup>();
  private running = 0;
  private closing = false;
  cleanupActivity(): { active: number } {
    return {
      active: this.running + this.retainedCleanup.size + Number(this.closing),
    };
  }
  async close(): Promise<void> {
    if (this.running || this.closing) throw new Error("LIBRARY_BUSY");
    this.closing = true;
    try {
      for (const pending of this.retainedCleanup) {
        await this.cleanup(pending);
        this.retainedCleanup.delete(pending);
      }
    } finally {
      this.closing = false;
    }
  }
  setAdmissionHooks(hooks: LibraryCacheAdmissionHooks): void {
    this.admission = hooks;
  }
  constructor(
    private readonly host: HostContext,
    private readonly current: (scope: SessionAccountScope) => boolean,
    private readonly consumeResult?: (
      capability: string,
      scope: SessionAccountScope,
    ) => Promise<{ file: FileHandle; name: string; bytes: number }>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private assert(scope: SessionAccountScope, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.current(scope)) throw new Error("ACCOUNT_CHANGED");
  }
  private selected(job: JobMetadata, variant: "voice" | "original") {
    const selected = variant === "voice" ? job.output : job.input;
    if (
      !selected ||
      job.status !== "ready" ||
      !(variant === "voice" ? job.can_download_output : job.can_download_input)
    )
      throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    return selected;
  }
  private directory(
    scope: SessionAccountScope,
    job: JobMetadata,
    variant: "voice" | "original",
  ): string {
    const selected = this.selected(job, variant);
    if (!/^[a-f0-9]{24}$/.test(job.id))
      throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    return `library\\media\\${libraryNamespace(scope.firebaseUid)}\\${job.id}\\${variant}\\${Buffer.from(selected.sha256, "base64").toString("hex")}`;
  }
  async adopt(
    capability: string,
    job: JobMetadata,
    scope: SessionAccountScope,
    signal: AbortSignal,
  ): Promise<CachedAccountArtifact> {
    if (!this.consumeResult) throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    this.assert(scope, signal);
    const selected = await this.consumeResult(capability, scope);
    try {
      if (selected.bytes !== job.output?.bytes)
        throw new Error("LIBRARY_RESULT_INVALID");
      return await this.publish(job, scope, signal, "voice", async (target) => {
        const before = await selected.file.stat({ bigint: true }),
          buffer = Buffer.alloc(1024 ** 2);
        let offset = 0;
        while (offset < selected.bytes) {
          this.assert(scope, signal);
          const result = await selected.file.read(
            buffer,
            0,
            Math.min(buffer.length, selected.bytes - offset),
            offset,
          );
          if (!result.bytesRead) throw new Error("LIBRARY_RESULT_INVALID");
          offset += result.bytesRead;
          await target.writeFile(buffer.subarray(0, result.bytesRead));
        }
        const after = await selected.file.stat({ bigint: true });
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new Error("LIBRARY_RESULT_INVALID");
      });
    } finally {
      await selected.file.close();
    }
  }
  async download(
    job: JobMetadata,
    grant: DownloadGrant,
    scope: SessionAccountScope,
    signal: AbortSignal,
    variant: "voice" | "original" = "voice",
  ): Promise<CachedAccountArtifact> {
    return this.publish(job, scope, signal, variant, (file) =>
      downloadCloudArtifact(file, this.selected(job, variant), grant, {
        signal,
        assertCurrent: () => this.assert(scope, signal),
        fetch: this.fetcher,
      }),
    );
  }
  private async publish(
    job: JobMetadata,
    scope: SessionAccountScope,
    signal: AbortSignal,
    variant: "voice" | "original",
    transfer: (file: PrivateWritable) => Promise<void>,
  ): Promise<CachedAccountArtifact> {
    if (this.closing) throw new Error("LIBRARY_BUSY");
    this.running++;
    try {
      return await this.publishOwned(job, scope, signal, variant, transfer);
    } finally {
      this.running--;
    }
  }
  private async publishOwned(
    job: JobMetadata,
    scope: SessionAccountScope,
    signal: AbortSignal,
    variant: "voice" | "original",
    transfer: (file: PrivateWritable) => Promise<void>,
  ): Promise<CachedAccountArtifact> {
    this.assert(scope, signal);
    for (const pending of this.retainedCleanup) {
      await this.cleanup(pending);
      this.retainedCleanup.delete(pending);
      this.assert(scope, signal);
    }
    const selected = this.selected(job, variant);
    if (
      variant === "voice" &&
      job.trim_enabled &&
      selected.duration_seconds == null
    )
      throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    if (
      selected.bytes < 1 ||
      selected.bytes > (variant === "voice" ? 100000000 : 256 * 1024 ** 2) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(selected.sha256)
    )
      throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    const root = this.directory(scope, job, variant),
      relative = `${root}\\media.${selected.extension}`,
      temporary = `${relative}.${randomUUID()}.part`,
      metadata = `${root}\\media.json`,
      pending = `${metadata}.${randomUUID()}.tmp`;
    await this.host.directory(root);
    if (!this.admission?.beginWrite) throw new Error("STORAGE_NOT_READY");
    const cleanup: LibraryWriteCleanup = { files: [] };
    let result: CachedAccountArtifact | undefined, primary: unknown;
    try {
      cleanup.protection = await this.admission?.protectTree(root, "download");
      if (variant === "voice")
        cleanup.reservation = await this.admission?.reserveVoice(
          selected.bytes,
          root,
        );
      const write = await this.admission.beginWrite(temporary, "file");
      cleanup.write = write;
      if (typeof write.id !== "string") throw new Error("STORAGE_NOT_READY");
      const file = await newPrivateFile(this.host, temporary);
      const ownedFile: CreatedLibraryFile = {
        relativePath: temporary,
        handle: file,
      };
      cleanup.files.push(ownedFile);
      await this.finishCreated(file, ownedFile, async () => {
        const identity = await file.info();
        ownedFile.identity = identity;
        await write.captureCreated({
          device: identity.device,
          fileId: identity.fileId,
          bornAt: identity.bornAt,
        });
        await transfer(file);
        await file.sync();
      });
      this.assert(scope, signal);
      const digest = Buffer.from(selected.sha256, "base64").toString("hex");
      const proof = await verifyPrivateFile(
        this.host,
        temporary,
        selected.bytes,
        signal,
      );
      if (
        proof.sha256 !== digest ||
        !ownedFile.identity ||
        Object.entries(proof.fingerprint).some(
          ([key, value]) =>
            ownedFile.identity?.[key as keyof ConsumerCacheFileIdentity] !==
            value,
        )
      )
        throw new Error("LIBRARY_RESULT_INVALID");
      await write?.preparePublish(relative, metadata, pending, digest);
      const record: CachedAccountArtifact = {
        version: 1,
        ownerUid: scope.firebaseUid,
        jobId: job.id,
        artifactId: randomUUID(),
        relativePath: relative,
        bytes: selected.bytes,
        sha256: digest,
        durationSeconds:
          selected.duration_seconds ?? job.input.duration_seconds,
        contentType: selected.content_type,
        variant,
        createdAt: Date.now(),
      };
      const manifest = await newPrivateFile(this.host, pending);
      const ownedMetadata: CreatedLibraryFile = {
        relativePath: pending,
        handle: manifest,
      };
      cleanup.files.push(ownedMetadata);
      await this.finishCreated(manifest, ownedMetadata, async () => {
        const identity = await manifest.info();
        ownedMetadata.identity = identity;
        await write.captureCreated(
          {
            device: identity.device,
            fileId: identity.fileId,
            bornAt: identity.bornAt,
          },
          pending,
        );
        await manifest.writeFile(JSON.stringify(record));
        await manifest.sync();
      });
      const lease = await acquireLibraryCacheLease(this.host);
      let publicationFailure: unknown;
      try {
        this.assert(scope, signal);
        const existing = await this.lookup(job, scope, signal, variant);
        if (existing) {
          if (
            (await hashPrivateFile(
              this.host,
              existing.relativePath,
              existing.bytes,
              signal,
            )) !== existing.sha256
          )
            throw new Error("LIBRARY_RESULT_INVALID");
          result = existing;
        } else {
          // Content addresses are immutable. A pinned artifact is never replaced.
          await this.host.native.validatePath("personal", relative, "absent");
          await this.host.native.validatePath("personal", metadata, "absent");
          this.assert(scope, signal);
          await this.publishCreated(ownedFile, relative, write.id, "media");
          this.assert(scope, signal);
          await this.publishCreated(
            ownedMetadata,
            metadata,
            write.id,
            "metadata",
          );
          this.assert(scope, signal);
          result = record;
          // The complete immutable pair now belongs to the Library, not the aborted write.
          cleanup.files.length = 0;
        }
      } catch (error) {
        publicationFailure = error;
      }
      try {
        await this.host.native.releaseMutex(lease);
      } catch (error) {
        publicationFailure ??= error;
      }
      if (publicationFailure) throw publicationFailure;
    } catch (error) {
      primary = error;
    }
    try {
      await this.cleanup(cleanup);
    } catch (error) {
      this.retainedCleanup.add(cleanup);
      primary ??= error;
    }
    if (primary) throw primary;
    if (!result) throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    return result;
  }
  private async finishCreated(
    file: PrivateWritable,
    owned: CreatedLibraryFile,
    operation: () => Promise<void>,
  ): Promise<void> {
    let primary: unknown;
    try {
      await operation();
    } catch (error) {
      primary = error;
    }
    try {
      owned.identity = await file.info();
    } catch (error) {
      delete owned.identity;
      primary ??= error;
    }
    try {
      await file.close();
      owned.closed = true;
      delete owned.handle;
    } catch (error) {
      primary ??= error;
    }
    if (primary) throw primary;
  }
  private async publishCreated(
    owned: CreatedLibraryFile,
    relative: string,
    writeId: string,
    component: "media" | "metadata",
  ): Promise<void> {
    const identity = owned.identity;
    if (!identity) throw new Error("LIBRARY_RESULT_CHANGED");
    if (!this.host.native.publishLibraryArtifact)
      throw new Error("STORAGE_RECOVERY_PENDING");
    owned.publicationPending = { writeId, component };
    await this.host.native.publishLibraryArtifact(writeId, component);
    owned.relativePath = relative;
    await this.host.native.validatePath("personal", relative, "file");
    const file = await open(
      win32.join(this.host.personalRoot, relative),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    owned.handle = file;
    delete owned.closed;
    let primary: unknown;
    try {
      const actual = createdFileIdentity(await file.stat({ bigint: true }));
      if (
        ["device", "fileId", "bornAt"].some(
          (key) =>
            actual[key as keyof ConsumerCacheFileIdentity] !==
            identity[key as keyof ConsumerCacheFileIdentity],
        )
      )
        throw new Error("LIBRARY_RESULT_CHANGED");
      // A legitimate rename may update changedAt. Its post-rename tuple comes
      // only from an FD for the exact originally created generation.
      owned.identity = actual;
    } catch (error) {
      primary = error;
    }
    try {
      await file.close();
      owned.closed = true;
      delete owned.handle;
    } catch (error) {
      primary ??= error;
    }
    if (primary) throw primary;
    delete owned.publicationPending;
  }
  private async cleanup(owned: LibraryWriteCleanup): Promise<void> {
    if (owned.files.some((file) => !file.completed)) {
      const lease = await acquireLibraryCacheLease(this.host);
      let primary: unknown;
      try {
        for (const file of [...owned.files].reverse()) {
          if (file.completed) continue;
          if (file.publicationPending) {
            if (
              !this.host.native.inspectLibraryArtifactPublication ||
              !file.identity
            )
              throw new Error("STORAGE_RECOVERY_PENDING");
            const pending = file.publicationPending,
              inspected =
                await this.host.native.inspectLibraryArtifactPublication(
                  pending.writeId,
                  pending.component,
                );
            if (
              ["device", "fileId", "bornAt"].some(
                (key) =>
                  inspected.identity[key as keyof ConsumerCacheFileIdentity] !==
                  file.identity![key as keyof ConsumerCacheFileIdentity],
              )
            )
              throw new Error("LIBRARY_RESULT_CHANGED");
            file.relativePath = inspected.relativePath;
            file.identity = inspected.identity;
            delete file.publicationPending;
          }
          if (file.handle) {
            await file.handle.close();
            delete file.handle;
            file.closed = true;
          }
          if (!owned.write?.id || !file.identity || !file.closed)
            throw new Error("STORAGE_RECOVERY_PENDING");
          await retireStorageLibraryArtifact(
            this.host,
            owned.write.id,
            file.relativePath,
            file.identity,
          );
          file.completed = true;
        }
      } catch (error) {
        primary = error;
      }
      try {
        await this.host.native.releaseMutex(lease);
      } catch (error) {
        primary ??= error;
      }
      if (primary) throw primary;
    }
    await owned.write?.settle();
    delete owned.write;
    await owned.reservation?.release();
    delete owned.reservation;
    await owned.protection?.release();
    delete owned.protection;
  }
  async lookup(
    job: JobMetadata,
    scope: SessionAccountScope,
    signal: AbortSignal,
    variant: "voice" | "original" = "voice",
  ): Promise<CachedAccountArtifact | null> {
    this.assert(scope, signal);
    const selected = this.selected(job, variant);
    const root = this.directory(scope, job, variant),
      relative = `${root}\\media.json`;
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const row = JSON.parse(
      (await readPrivateBytes(this.host, relative, 4096)).toString("utf8"),
    ) as CachedAccountArtifact;
    if (
      Object.keys(row).sort().join() !==
        "artifactId,bytes,contentType,createdAt,durationSeconds,jobId,ownerUid,relativePath,sha256,variant,version" ||
      row.version !== 1 ||
      row.ownerUid !== scope.firebaseUid ||
      row.jobId !== job.id ||
      row.relativePath !== `${root}\\media.${selected.extension}` ||
      row.sha256 !== Buffer.from(selected.sha256, "base64").toString("hex") ||
      row.bytes !== selected.bytes ||
      row.variant !== variant ||
      row.contentType !== selected.content_type ||
      !Number.isFinite(row.durationSeconds) ||
      row.durationSeconds <= 0 ||
      row.durationSeconds > 7200 ||
      !/^[a-f0-9-]{36}$/.test(row.artifactId) ||
      !Number.isSafeInteger(row.createdAt) ||
      row.createdAt < 0
    )
      throw new Error("LIBRARY_CORRUPT");
    let stat;
    try {
      stat = await lstat(win32.join(this.host.personalRoot, row.relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    await this.host.native.validatePath("personal", row.relativePath, "file");
    if (!stat.isFile() || stat.size !== row.bytes || stat.nlink !== 1)
      throw new Error("LIBRARY_RESULT_INVALID");
    this.assert(scope, signal);
    return row;
  }
  async local(
    jobId: string,
    artifact: PersonalArtifact,
    variant: "voice" | "original",
  ): Promise<TrustedLibraryArtifact> {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error("LIBRARY_CORRUPT");
    const base = `personal\\results\\${jobId}`,
      pair = JSON.parse(
        (
          await readPrivateBytes(this.host, `${base}\\pair.json`, 16384)
        ).toString("utf8"),
      ) as Record<string, unknown>;
    const selected = (
      variant === "voice" ? pair.vocals : pair.original
    ) as PersonalArtifact & { filename: string };
    if (
      pair.version !== 1 ||
      pair.jobId !== jobId ||
      !selected ||
      selected.id !== artifact.id ||
      selected.bytes !== artifact.bytes ||
      selected.sha256 !== artifact.sha256 ||
      !/^(?:vocals\.mp3|original\.(?:mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac))$/.test(
        selected.filename,
      )
    )
      throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    const relativePath = `${base}\\${selected.filename}`;
    await lstat(win32.join(this.host.personalRoot, relativePath));
    await this.host.native.validatePath("personal", relativePath, "file");
    return {
      relativePath,
      artifactId: artifact.id,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      mime: artifact.contentType,
      durationSeconds: artifact.durationSeconds,
    };
  }
  async verify(
    artifact: TrustedLibraryArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      (await hashPrivateFile(
        this.host,
        artifact.relativePath,
        artifact.bytes,
        signal,
      )) !== artifact.sha256
    )
      throw new Error("LIBRARY_RESULT_INVALID");
  }
}
