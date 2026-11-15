import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type {
  ConsumerProcessIdentity,
  ConsumerShareReceipt,
  ConsumerShareCleanupFile,
  ConsumerMutexLease,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import type { LibraryExportDestination } from "../library/export.js";
import {
  privateFingerprint,
  verifyPrivateFile,
  type PrivateFileFingerprint,
} from "../prepare/private-files.js";
import {
  SHARE_TREE,
  SHARE_FILE,
  SHARE_MAX_BYTES,
  storageBirth,
  type StorageWrite,
  type StorageWriteLease,
  type StorageBirth,
} from "./write-journal.js";

type Destination = NonNullable<
  Awaited<ReturnType<LibraryExportDestination["choose"]>>
>;
export interface ShareStorageAdmission {
  beginWrite(
    relative: string,
    kind: "tree",
    bytes: number,
  ): Promise<StorageWriteLease>;
  protectTree(
    relative: string,
    purpose: "share",
    planned?: boolean,
  ): Promise<{ release(): Promise<void> }>;
  resumeShareWrite(
    requestId: string,
  ): Promise<{ row: StorageWrite; lease: StorageWriteLease }>;
  shareWrites(): Promise<StorageWrite[]>;
}
export interface ShareWorkspace {
  directory: string;
  relativePath: string;
  nativePending(): boolean;
  createFile(extension: string): Promise<Destination>;
  seal(): Promise<{ relativePath: string; sha256: string; bytes: number }>;
  handoff(helper: ConsumerProcessIdentity): Promise<void>;
  settle(receipt: ConsumerShareReceipt): Promise<void>;
  discardBeforeHandoff(): Promise<void>;
  retain(): Promise<void>;
}
/** Persistent copy reservation and positive native consumption proof precede removal. */
export class WindowsShareWorkspaceFactory {
  constructor(
    private readonly options: {
      host: HostContext;
      storage: ShareStorageAdmission;
    },
  ) {}
  async pending(): Promise<string[]> {
    return (await this.options.storage.shareWrites()).map(
      (row) => row.relativePath.split("\\")[2]!,
    );
  }
  async create(
    requestId: string,
    copyBytes: number,
    signal: AbortSignal,
  ): Promise<ShareWorkspace> {
    const relative = `share\\requests\\${requestId}`;
    if (
      !SHARE_TREE.test(relative) ||
      !Number.isSafeInteger(copyBytes) ||
      copyBytes < 1 ||
      copyBytes > SHARE_MAX_BYTES
    )
      throw new Error("STORAGE_WRITE_INVALID");
    if (!this.options.host.native.inspectShare)
      throw new Error("SHARE_UNAVAILABLE");
    signal.throwIfAborted();
    await this.options.host.directory("share\\requests");
    const lease = await this.options.storage.beginWrite(
      relative,
      "tree",
      copyBytes,
    );
    let birth: StorageBirth | undefined;
    try {
      if (
        !lease.sealShare ||
        !lease.handoffShare ||
        !lease.confirmShareQuiesced
      )
        throw new Error("STORAGE_NOT_READY");
      const directory = await this.options.host.directory(relative);
      birth = storageBirth(await lstat(directory, { bigint: true }));
      await lease.captureCreated(birth);
      const pin = await this.options.storage.protectTree(relative, "share");
      return this.workspace({
        relative,
        copyBytes,
        lease,
        birth,
        pin,
        signal,
        nativePending: false,
      });
    } catch (error) {
      // Unknown creation binding stays journal-protected; never remove by name alone.
      await lease.settle().catch(() => {});
      throw error;
    }
  }
  async restore(
    requestId: string,
    signal: AbortSignal,
  ): Promise<ShareWorkspace> {
    signal.throwIfAborted();
    if (!this.options.host.native.inspectShare)
      throw new Error("SHARE_UNAVAILABLE");
    const { row, lease } =
      await this.options.storage.resumeShareWrite(requestId);
    if (!row.share || !row.birth || !row.copyBytes)
      throw new Error("STORAGE_RECOVERY_PENDING");
    await this.exactDirectory(row.relativePath, row.birth);
    const pin = await this.options.storage.protectTree(
      row.relativePath,
      "share",
    );
    return this.workspace({
      relative: row.relativePath,
      copyBytes: row.copyBytes,
      lease,
      birth: row.birth,
      pin,
      signal,
      nativePending: row.share.nativePending,
      ...(row.share.file
        ? {
            sealed: {
              relativePath: row.share.file.relativePath,
              sha256: row.share.file.sha256,
              bytes: row.share.file.fingerprint.bytes,
            },
            sealedFingerprint: row.share.file.fingerprint,
            ...(row.share.file.bornAt
              ? { sealedBirth: row.share.file.bornAt }
              : {}),
          }
        : {}),
    });
  }
  private async exactDirectory(
    relative: string,
    birth: StorageBirth,
  ): Promise<void> {
    await this.options.host.native.validatePath(
      "personal",
      relative,
      "directory",
    );
    const actual = await lstat(
      win32.join(this.options.host.personalRoot, relative),
      { bigint: true },
    );
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      JSON.stringify(storageBirth(actual)) !== JSON.stringify(birth)
    )
      throw new Error("STORAGE_WRITE_CHANGED");
  }
  private workspace(state: {
    relative: string;
    copyBytes: number;
    lease: StorageWriteLease;
    birth: StorageBirth;
    pin: { release(): Promise<void> };
    signal: AbortSignal;
    nativePending: boolean;
    sealed?: { relativePath: string; sha256: string; bytes: number };
    sealedFingerprint?: PrivateFileFingerprint;
    sealedBirth?: string;
  }): ShareWorkspace {
    const { host } = this.options,
      directory = win32.join(host.personalRoot, state.relative);
    if (
      !state.lease.sealShare ||
      !state.lease.handoffShare ||
      !state.lease.confirmShareQuiesced
    )
      throw new Error("STORAGE_NOT_READY");
    let file: FileHandle | undefined,
      fileBirth: StorageBirth | undefined,
      fileRelative: string | undefined,
      closed = false,
      removed = false,
      confirmed = false,
      settled = false,
      unpinned = false;
    let cleanupFile: ConsumerShareCleanupFile | null | undefined;
    let cacheLease: ConsumerMutexLease | undefined;
    const releaseCache = async () => {
      if (!cacheLease) return;
      await host.native.releaseMutex(cacheLease);
      cacheLease = undefined;
    };
    const withCache = async <T>(work: () => Promise<T>): Promise<T> => {
      await releaseCache();
      const lease = await host.native.acquireMutex("cache");
      if (!lease) throw new Error("STORAGE_BUSY");
      cacheLease = lease;
      try {
        return await work();
      } finally {
        await releaseCache();
      }
    };
    let closing: Promise<void> | undefined;
    const remove = async () => {
      if (removed) return;
      if (cleanupFile === undefined) {
        await this.exactDirectory(state.relative, state.birth);
        const names = await readdir(directory);
        if (
          names.length > 1 ||
          names.some(
            (name) =>
              !SHARE_FILE.test(`${state.relative}\\${name}`) ||
              (fileRelative && `${state.relative}\\${name}` !== fileRelative) ||
              (state.sealed &&
                `${state.relative}\\${name}` !== state.sealed.relativePath),
          )
        )
          throw new Error("STORAGE_WRITE_CHANGED");
        if (!names.length) cleanupFile = null;
        if (names.length) {
          const relative = `${state.relative}\\${names[0]}`;
          await host.native.validatePath("personal", relative, "file");
          const stat = await lstat(win32.join(host.personalRoot, relative), {
            bigint: true,
          });
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1n ||
            (fileBirth &&
              JSON.stringify(storageBirth(stat)) !== JSON.stringify(fileBirth))
          )
            throw new Error("STORAGE_WRITE_CHANGED");
          if (
            state.sealed &&
            (
              await verifyPrivateFile(
                host,
                relative,
                state.copyBytes,
                new AbortController().signal,
              )
            ).sha256 !== state.sealed.sha256
          )
            throw new Error("STORAGE_WRITE_CHANGED");
          if (
            state.sealedFingerprint &&
            JSON.stringify(await privateFingerprint(host, relative)) !==
              JSON.stringify(state.sealedFingerprint)
          )
            throw new Error("STORAGE_WRITE_CHANGED");
          const capturedBirth = state.sealedBirth ?? fileBirth?.bornAt;
          if (!capturedBirth || capturedBirth !== String(stat.birthtimeNs))
            throw new Error("STORAGE_RECOVERY_PENDING");
          const proof = await verifyPrivateFile(
            host,
            relative,
            Number(stat.size),
            new AbortController().signal,
          );
          cleanupFile = {
            relativePath: relative,
            identity: { ...proof.fingerprint, bornAt: capturedBirth },
            sha256: proof.sha256,
          };
        }
      }
      const native = host.native,
        discard = native.discardShareWorkspace;
      if (cleanupFile === undefined)
        throw new Error("STORAGE_RECOVERY_PENDING");
      const expectedFile = cleanupFile;
      if (!discard) throw new Error("STORAGE_RECOVERY_PENDING");
      await withCache(async () => {
        if (
          (await discard.call(
            native,
            state.relative.split("\\")[2]!,
            state.birth,
            expectedFile,
          )) !== "completed"
        )
          throw new Error("STORAGE_RECOVERY_PENDING");
        removed = true;
      });
    };
    const finish = async () => {
      await releaseCache();
      await file?.close();
      file = undefined;
      await remove();
      if (!settled) {
        await state.lease.settle();
        settled = true;
      }
      if (!unpinned) {
        await state.pin.release();
        unpinned = true;
      }
      const cleanup = host.native.recoverPersonalCleanups;
      if (!cleanup) throw new Error("STORAGE_RECOVERY_PENDING");
      await withCache(async () => {
        await cleanup.call(host.native);
      });
      closed = true;
    };
    const retry = (run: () => Promise<void>): Promise<void> =>
      (closing ??= (async () => {
        if (closed) return;
        await run();
      })().finally(() => {
        if (!closed) closing = undefined;
      }));
    const seal = async () => {
      if (closed || state.nativePending)
        throw new Error("STORAGE_RECOVERY_PENDING");
      if (state.sealed) return { ...state.sealed };
      if (!file || !fileRelative || !fileBirth)
        throw new Error("STORAGE_WRITE_CHANGED");
      const stat = await file.stat({ bigint: true });
      if (
        stat.size !== BigInt(state.copyBytes) ||
        stat.nlink !== 1n ||
        JSON.stringify(storageBirth(stat)) !== JSON.stringify(fileBirth)
      )
        throw new Error("STORAGE_WRITE_CHANGED");
      await file.sync();
      await file.close();
      file = undefined;
      const proof = await verifyPrivateFile(
        host,
        fileRelative,
        state.copyBytes,
        state.signal,
      );
      await state.lease.sealShare!(fileRelative, proof.sha256, state.copyBytes);
      state.sealed = {
        relativePath: fileRelative,
        sha256: proof.sha256,
        bytes: state.copyBytes,
      };
      state.sealedFingerprint = proof.fingerprint;
      state.sealedBirth = fileBirth.bornAt;
      return { ...state.sealed };
    };
    return {
      directory,
      relativePath: state.relative,
      nativePending: () => state.nativePending,
      createFile: async (extension) => {
        const relative = `${state.relative}\\media.${extension}`;
        if (
          closed ||
          state.nativePending ||
          state.sealed ||
          fileRelative ||
          !SHARE_FILE.test(relative)
        )
          throw new Error("STORAGE_WRITE_INVALID");
        state.signal.throwIfAborted();
        await this.exactDirectory(state.relative, state.birth);
        await host.native.validatePath("personal", relative, "absent");
        file = await open(win32.join(host.personalRoot, relative), "wx", 0o600);
        fileRelative = relative;
        fileBirth = storageBirth(await file.stat({ bigint: true }));
        return {
          file,
          commit: async () => {
            await seal();
          },
          discard: () =>
            retry(async () => {
              if (state.nativePending)
                throw new Error("STORAGE_RECOVERY_PENDING");
              await finish();
            }),
        };
      },
      seal,
      handoff: async (helper) => {
        if (closed || state.nativePending)
          throw new Error("STORAGE_RECOVERY_PENDING");
        await seal();
        // Conservative before await: a lost durable acknowledgement cannot become Node-only cleanup.
        state.nativePending = true;
        await state.lease.handoffShare!(helper);
      },
      settle: (receipt) =>
        retry(async () => {
          if (!state.nativePending) throw new Error("STORAGE_RECOVERY_PENDING");
          const inspector = host.native.inspectShare;
          if (!inspector) throw new Error("STORAGE_RECOVERY_PENDING");
          if (!confirmed) {
            await state.lease.confirmShareQuiesced!(receipt, (request) =>
              inspector.call(host.native, request),
            );
            confirmed = true;
          }
          // Legacy handed-off rows may lack a Node birth. The actual native
          // terminal receipt is their immutable created-file authority.
          if (!state.sealedBirth)
            state.sealedBirth = String(
              (BigInt(receipt.fileIdentity.creationTime) -
                116444736000000000n) *
                100n,
            );
          await finish();
        }),
      discardBeforeHandoff: () =>
        retry(async () => {
          if (state.nativePending) throw new Error("STORAGE_RECOVERY_PENDING");
          await finish();
        }),
      retain: async () => {
        await file?.close();
        file = undefined;
      },
    };
  }
}
