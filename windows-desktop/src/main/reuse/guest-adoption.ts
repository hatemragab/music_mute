import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  rename,
  unlink,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import type { LibraryStore } from "../library/store.js";
import type { PersonalArtifact } from "../../shared/personal-contracts.js";
import type { ReuseReceipt } from "../../shared/reuse-contracts.js";
import {
  newPrivateFile,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import { parseReuseReceipt, parseCompletionReceipt } from "./receipts.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { ConsumerOwnedProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import { parsePersonalPair, type VerifiedPersonalPair } from "./pair.js";
import {
  storageBirth,
  type StorageWriteLease,
} from "../storage/write-journal.js";
export interface ReuseAdmissionPort {
  reserveScratch?(
    bytes: number,
    relative: string,
  ): Promise<
    import("../storage/scratch-reservations.js").ScratchReservationLease
  >;
  trackWorkspace?(
    relative: string,
    owner: ConsumerOwnedProcess,
    purpose: "processing" | "download",
  ): Promise<{ release(): Promise<void>; retireForRelaunch(): Promise<void> }>;
  beginWrite?(
    relative: string,
    kind: "file" | "tree",
  ): Promise<StorageWriteLease>;
  protectTree(
    relative: string,
    purpose: "download" | "processing",
  ): Promise<{ release(): Promise<void> }>;
  reserveVoice(
    bytes: number,
    relative: string,
  ): Promise<{ release(): Promise<void> }>;
}
export interface ReuseCopyArtifact {
  file: FileHandle;
  declaration: PersonalArtifact;
  extension: string;
}
export async function copyReuseArtifact(
  host: HostContext,
  item: ReuseCopyArtifact,
  relative: string,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<void> {
  const before = await item.file.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size !== BigInt(item.declaration.bytes)
  )
    throw new Error("REUSE_ARTIFACT_INVALID");
  const output = await newPrivateFile(host, relative),
    hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 ** 2);
  let offset = 0;
  try {
    while (offset < item.declaration.bytes) {
      signal.throwIfAborted();
      assertCurrent();
      const read = await item.file.read(
        buffer,
        0,
        Math.min(buffer.length, item.declaration.bytes - offset),
        offset,
      );
      if (!read.bytesRead) throw new Error("REUSE_ARTIFACT_INVALID");
      offset += read.bytesRead;
      const bytes = buffer.subarray(0, read.bytesRead);
      hash.update(bytes);
      await output.writeFile(bytes);
    }
    await output.sync();
  } finally {
    await output.close();
  }
  const after = await item.file.stat({ bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.size !== after.size ||
    hash.digest("hex") !== item.declaration.sha256
  )
    throw new Error("REUSE_ARTIFACT_INVALID");
  await host.native.validatePath("personal", relative, "file");
}
/** Read-only descriptors are copied into one fresh immutable personal pair; no second catalog. */
export class WindowsGuestAdoption {
  constructor(
    private readonly options: {
      host: HostContext;
      store: Pick<LibraryStore, "rememberPersonal">;
      admission: ReuseAdmissionPort;
      validate(
        original: ReuseCopyArtifact,
        vocals: ReuseCopyArtifact,
        signal: AbortSignal,
        assertCurrent: () => void,
      ): Promise<void>;
    },
  ) {}
  async adopt(
    receipt: ReuseReceipt,
    original: ReuseCopyArtifact,
    vocals: ReuseCopyArtifact,
    signal: AbortSignal,
    assertCurrent: () => void,
    completion?: {
      jobId: string;
      ownerId: string;
      requestId: string;
      capturedAccountScope: SessionAccountScope | null;
    },
  ): Promise<VerifiedPersonalPair> {
    const proof = parseReuseReceipt(receipt, {
      originalSha256: original.declaration.sha256,
      vocalsSha256: vocals.declaration.sha256,
    });
    if (
      !/^(?:m4a|mp3|webm|ogg|opus|wav|flac|aac)$/.test(original.extension) ||
      vocals.extension !== "mp3" ||
      vocals.declaration.contentType !== "audio/mpeg" ||
      Math.abs(
        original.declaration.durationSeconds -
          vocals.declaration.durationSeconds,
      ) > 0.25
    )
      throw new Error("REUSE_ARTIFACT_INVALID");
    const host = this.options.host,
      jobId = completion?.jobId ?? randomUUID(),
      root = `personal\\results\\${jobId}`,
      staging = `${root}.pending`;
    const completionReceipt = completion
      ? parseCompletionReceipt(
          {
            version: 1,
            installationId: host.report.installationId,
            ...completion,
            originalSha256: proof.originalSha256,
            vocalsSha256: proof.vocalsSha256,
            completedAt: Date.now(),
          },
          {
            installationId: host.report.installationId,
            jobId,
            originalSha256: proof.originalSha256,
            vocalsSha256: proof.vocalsSha256,
          },
        )
      : undefined;
    const protections: Awaited<
      ReturnType<ReuseAdmissionPort["protectTree"]>
    >[] = [];
    let reservation:
        Awaited<ReturnType<ReuseAdmissionPort["reserveVoice"]>> | undefined,
      published = false;
    let write: StorageWriteLease | undefined;
    const check = () => {
      signal.throwIfAborted();
      assertCurrent();
    };
    try {
      check();
      reservation = await this.options.admission.reserveVoice(
        vocals.declaration.bytes,
        staging,
      );
      await host.directory("personal\\results");
      if (!this.options.admission.beginWrite)
        throw new Error("STORAGE_NOT_READY");
      write = await this.options.admission.beginWrite?.(staging, "tree");
      protections.push(
        await this.options.admission.protectTree(
          "personal\\results",
          "download",
        ),
      );
      await this.options.validate(original, vocals, signal, check);
      check();
      await host.directory(staging);
      await write.captureCreated(
        storageBirth(
          await lstat(win32.join(host.personalRoot, staging), { bigint: true }),
        ),
      );
      const copy = async (item: ReuseCopyArtifact, name: string) => {
        await copyReuseArtifact(
          host,
          item,
          `${staging}\\${name}`,
          signal,
          check,
        );
      };
      await copy(original, `original.${original.extension}`);
      await copy(vocals, "vocals.mp3");
      const raw = {
        version: 1,
        jobId,
        original: {
          ...original.declaration,
          id: randomUUID(),
          kind: "original",
          filename: `original.${original.extension}`,
        },
        vocals: {
          ...vocals.declaration,
          id: randomUUID(),
          kind: "vocals",
          filename: "vocals.mp3",
        },
        reuseReceipt: proof,
        ...(completionReceipt ? { completionReceipt } : {}),
      };
      const pair = parsePersonalPair(raw, host.report.installationId, jobId);
      await writePrivateAtomic(
        host,
        `${staging}\\pair.json`,
        Buffer.from(JSON.stringify(raw)),
      );
      check();
      const lease = await host.native.acquireMutex("cache");
      if (!lease) throw new Error("LIBRARY_BUSY");
      try {
        check();
        await host.native.validatePath("personal", staging, "directory");
        await host.native.validatePath("personal", root, "absent");
        await rename(
          win32.join(host.personalRoot, staging),
          win32.join(host.personalRoot, root),
        );
        published = true;
      } finally {
        await host.native.releaseMutex(lease);
      }
      check();
      await this.options.store.rememberPersonal(pair.view, null);
      return pair;
    } finally {
      // Exact producer-owned partials only; a published pair remains recoverable if catalog acknowledgement was lost.
      if (!published) {
        for (const name of [
          `original.${original.extension}`,
          "vocals.mp3",
          "pair.json",
        ]) {
          try {
            await host.native.validatePath(
              "personal",
              `${staging}\\${name}`,
              "file",
            );
            await unlink(win32.join(host.personalRoot, staging, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              /* Refuse unsafe cleanup. */
            }
          }
        }
        try {
          await host.native.validatePath("personal", staging, "directory");
          await rmdir(win32.join(host.personalRoot, staging));
        } catch {}
      }
      await write?.settle();
      await reservation?.release();
      await Promise.allSettled(protections.map((pin) => pin.release()));
    }
  }
}
