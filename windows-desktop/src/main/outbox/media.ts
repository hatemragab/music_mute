import { randomUUID } from "node:crypto";
import { lstat, open, rename, statfs, unlink } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import type { LocalLibraryEntry } from "../library/model.js";
import type {
  LibraryArtifactCache,
  TrustedLibraryArtifact,
} from "../library/artifacts.js";
import type { LibraryPins } from "../library/pins.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import {
  hashPrivateFile,
  newPrivateFile,
  readPrivateBytes,
} from "../prepare/private-files.js";
import { parsePersonalPair } from "../reuse/pair.js";
import type { StorageWriteLease } from "../storage/write-journal.js";
import type { StoragePartialWriteAdmission } from "../storage/partial-write-policy.js";
import { uploadCloudAudio, type CloudUploadGrant } from "../cloud/transfers.js";
import {
  artifactDeclaration,
  outboxRelativePath,
  stageOutbox,
  type OutboxArtifact,
  type OutboxRecord,
} from "./model.js";
export interface OutboxMediaContext {
  signal: AbortSignal;
  assertCurrent(): void;
}
export interface OutboxMediaPort {
  describe(
    entry: LocalLibraryEntry,
    scope: AccountSessionScope,
    installationId: string,
    requestId: string,
    kind: OutboxRecord["kind"],
    now: number,
    context: OutboxMediaContext,
  ): Promise<OutboxRecord>;
  retain(record: OutboxRecord, context: OutboxMediaContext): Promise<void>;
  verify(record: OutboxRecord, context: OutboxMediaContext): Promise<void>;
  upload(
    record: OutboxRecord,
    artifact: OutboxArtifact,
    grant: CloudUploadGrant,
    context: OutboxMediaContext,
  ): Promise<void>;
  release(record: OutboxRecord): Promise<void>;
}
export class WindowsOutboxMedia implements OutboxMediaPort {
  constructor(
    private readonly host: HostContext,
    private readonly cache: Pick<LibraryArtifactCache, "local" | "verify">,
    private readonly pins: Pick<LibraryPins, "pin">,
    private readonly fetcher: typeof fetch = fetch,
    private readonly admission?: StoragePartialWriteAdmission,
  ) {}
  private current(context: OutboxMediaContext): void {
    context.signal.throwIfAborted();
    context.assertCurrent();
  }
  private trusted(a: OutboxArtifact): TrustedLibraryArtifact {
    return {
      relativePath: a.sourceRelativePath,
      artifactId: a.artifactId,
      bytes: a.bytes,
      sha256: a.sha256,
      mime: a.contentType,
      durationSeconds: a.durationSeconds,
    };
  }
  async describe(
    entry: LocalLibraryEntry,
    scope: AccountSessionScope,
    installationId: string,
    requestId: string,
    kind: OutboxRecord["kind"],
    now: number,
    context: OutboxMediaContext,
  ): Promise<OutboxRecord> {
    this.current(context);
    const value: unknown = JSON.parse(
      (
        await readPrivateBytes(
          this.host,
          `personal\\results\\${entry.personalJobId}\\pair.json`,
          32768,
        )
      ).toString("utf8"),
    );
    const pair = parsePersonalPair(value, installationId, entry.personalJobId);
    if (
      installationId !== this.host.report.installationId ||
      !pair.reuse ||
      pair.entry.original.id !== entry.original.id ||
      pair.entry.vocals.id !== entry.vocals.id ||
      pair.entry.original.sha256 !== entry.original.sha256 ||
      pair.entry.vocals.sha256 !== entry.vocals.sha256 ||
      pair.entry.catalog.trim_enabled ||
      (entry.catalog.video_id ?? null) !==
        (pair.reuse.source.kind === "file" ? null : pair.reuse.source.videoId)
    )
      throw new Error("OUTBOX_PROFILE_UNSUPPORTED");
    const record = stageOutbox(
      entry,
      scope,
      installationId,
      requestId,
      kind,
      now,
    );
    for (const role of ["original", "vocals"] as const) {
      const item = record[role];
      if (!item) continue;
      const resolved = await this.cache.local(
        entry.personalJobId,
        entry[role],
        role === "vocals" ? "voice" : "original",
      );
      await this.cache.verify(resolved, context.signal);
      this.current(context);
      item.extension = win32.extname(resolved.relativePath).slice(1);
      item.sourceRelativePath = resolved.relativePath;
      item.relativePath =
        item.relativePath.slice(0, item.relativePath.lastIndexOf(".")) +
        `.${item.extension}`;
    }
    return record;
  }
  async retain(
    record: OutboxRecord,
    context: OutboxMediaContext,
  ): Promise<void> {
    this.current(context);
    if (!this.admission) throw new Error("STORAGE_NOT_READY");
    const free = await statfs(this.host.personalRoot, { bigint: true });
    if (free.bavail * free.bsize < 3n * 1024n ** 3n)
      throw new Error("OUTBOX_DISK_LIMIT");
    for (const artifact of [record.original, record.vocals]) {
      if (!artifact) continue;
      this.current(context);
      outboxRelativePath(artifact.relativePath);
      await this.admission.recoverPartialWrites(
        artifact.relativePath,
        context.signal,
      );
      try {
        await lstat(win32.join(this.host.personalRoot, artifact.relativePath));
        if (
          (await hashPrivateFile(
            this.host,
            artifact.relativePath,
            artifact.bytes,
            context.signal,
          )) === artifact.sha256
        )
          continue;
        throw new Error("OUTBOX_ARTIFACT_INVALID");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const source = this.trusted(artifact),
        pin = await this.pins.pin(source, "outbox");
      if (
        pin.artifactId !== source.artifactId ||
        pin.relativePath !== source.relativePath ||
        pin.sha256 !== source.sha256
      ) {
        await pin.release();
        throw new Error("OUTBOX_PIN_INVALID");
      }
      const temporary = `${artifact.relativePath}.${randomUUID()}.part`;
      let write: StorageWriteLease | undefined;
      try {
        await this.cache.verify(source, context.signal);
        this.current(context);
        await this.host.native.validatePath(
          "personal",
          source.relativePath,
          "file",
        );
        const input = await open(
          win32.join(this.host.personalRoot, source.relativePath),
          "r",
        );
        try {
          write = await this.admission.beginPartialWrite(
            temporary,
            artifact.bytes,
          );
        } catch (error) {
          await input.close();
          throw error;
        }
        const target = await newPrivateFile(this.host, temporary).catch(
          async (error) => {
            await input.close();
            throw error;
          },
        );
        try {
          const { device, fileId, bornAt } = await target.info();
          await write.captureCreated({ device, fileId, bornAt });
          const before = await input.stat({ bigint: true });
          if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.size !== BigInt(artifact.bytes)
          )
            throw new Error("OUTBOX_ARTIFACT_INVALID");
          const buffer = Buffer.alloc(1024 ** 2);
          let offset = 0;
          while (offset < artifact.bytes) {
            this.current(context);
            const read = await input.read(
              buffer,
              0,
              Math.min(buffer.length, artifact.bytes - offset),
              offset,
            );
            if (!read.bytesRead) throw new Error("OUTBOX_ARTIFACT_INVALID");
            offset += read.bytesRead;
            await target.writeFile(buffer.subarray(0, read.bytesRead));
          }
          const after = await input.stat({ bigint: true });
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs
          )
            throw new Error("OUTBOX_ARTIFACT_INVALID");
          await target.sync();
        } finally {
          await input.close();
          await target.close();
        }
        if (
          (await hashPrivateFile(
            this.host,
            temporary,
            artifact.bytes,
            context.signal,
          )) !== artifact.sha256
        )
          throw new Error("OUTBOX_ARTIFACT_INVALID");
        this.current(context);
        await this.host.native.validatePath(
          "personal",
          artifact.relativePath,
          "absent",
        );
        await rename(
          win32.join(this.host.personalRoot, temporary),
          win32.join(this.host.personalRoot, artifact.relativePath),
        );
      } finally {
        try {
          if (write) {
            await write.settle();
            await this.admission.recoverPartialWrites(
              artifact.relativePath,
              new AbortController().signal,
            );
          }
        } finally {
          await pin.release();
        }
      }
    }
  }
  async verify(
    record: OutboxRecord,
    context: OutboxMediaContext,
  ): Promise<void> {
    for (const item of [record.original, record.vocals]) {
      if (!item) continue;
      this.current(context);
      outboxRelativePath(item.relativePath);
      if (
        (await hashPrivateFile(
          this.host,
          item.relativePath,
          item.bytes,
          context.signal,
        )) !== item.sha256
      )
        throw new Error("OUTBOX_ARTIFACT_INVALID");
    }
    this.current(context);
  }
  async upload(
    record: OutboxRecord,
    artifact: OutboxArtifact,
    grant: CloudUploadGrant,
    context: OutboxMediaContext,
  ): Promise<void> {
    if (
      artifact.relativePath !== record.original?.relativePath &&
      artifact.relativePath !== record.vocals.relativePath
    )
      throw new Error("OUTBOX_ARTIFACT_INVALID");
    this.current(context);
    const declaration = artifactDeclaration(artifact),
      path = win32.join(this.host.personalRoot, artifact.relativePath);
    const file = await this.host.native.openPrivateFile(
      artifact.relativePath,
      "read",
      artifact.bytes,
    );
    if (!file) throw new Error("OUTBOX_ARTIFACT_INVALID");
    await uploadCloudAudio({ path, file }, declaration, grant, {
      signal: context.signal,
      assertCurrent: context.assertCurrent,
      fetch: this.fetcher,
    });
  }
  private async remove(relative: string): Promise<void> {
    outboxRelativePath(relative);
    try {
      const stat = await lstat(win32.join(this.host.personalRoot, relative));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("OUTBOX_ARTIFACT_INVALID");
      await this.host.native.validatePath("personal", relative, "file");
      await unlink(win32.join(this.host.personalRoot, relative));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  async release(record: OutboxRecord): Promise<void> {
    if (!this.admission) throw new Error("STORAGE_NOT_READY");
    for (const item of [record.original, record.vocals])
      if (item) {
        await this.admission.recoverPartialWrites(
          item.relativePath,
          new AbortController().signal,
        );
        await this.remove(item.relativePath);
      }
  }
}
