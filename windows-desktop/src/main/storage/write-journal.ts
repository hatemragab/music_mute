import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { win32 } from "node:path";
import {
  sameConsumerProcess,
  shareReceiptAllowsCleanup,
  type ConsumerProcessIdentity,
  type ConsumerShareReceipt,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  assertConsumerRelativePath,
  assertConsumerNonce,
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { HostContext } from "../host-context.js";
import { chromeDiagnosticPartialProtected } from "../diagnostics/report-registry.js";
import { discardStoragePartial } from "./native-cleanup.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  privateFingerprint,
  readPrivateBytes,
  verifyPrivateFile,
  writePrivateAtomic,
  type PrivateFileFingerprint,
} from "../prepare/private-files.js";
import {
  partialWriteTarget,
  assertPartialCanonical,
  THUMBNAIL_PARTIAL_LIMIT,
  OUTBOX_PARTIAL_ROLE_MAX_BYTES,
  DIAGNOSTIC_PARTIAL_LIMIT,
} from "./partial-write-policy.js";
const FILE = "storage\\writes.json",
  HASH = /^[a-f0-9]{64}$/u,
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MEDIA_ROOT =
  "library\\\\media\\\\[a-f0-9]{64}\\\\[a-f0-9]{24}\\\\(?:voice|original)\\\\[a-f0-9]{64}";
const TEMP_FILE = new RegExp(
  `^${MEDIA_ROOT}\\\\(?:media\\.(?:mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac)\\.[a-f0-9-]{36}\\.part|media\\.json\\.[a-f0-9-]{36}\\.tmp)$`,
  "u",
);
const FINAL_FILE = new RegExp(
  `^${MEDIA_ROOT}\\\\media\\.(?:mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac)$`,
  "u",
);
export interface StoragePublication {
  relativePath: string;
  metadataPath: string;
  temporaryMetadata: string;
  sha256: string;
  fingerprint: PrivateFileFingerprint;
  temporaryMetadataBirth?: StorageBirth;
}
export interface StorageWrite {
  id: string;
  relativePath: string;
  kind: "file" | "tree";
  owner: ConsumerProcessIdentity;
  settled: boolean;
  createdAt: number;
  publication?: StoragePublication;
  birth?: StorageBirth;
  copyBytes?: number;
  share?: {
    nativePending: boolean;
    quiesced?: true;
    file?: {
      relativePath: string;
      sha256: string;
      fingerprint: PrivateFileFingerprint;
      /** Exact created leaf birth; older handed-off rows use native receipt birth. */
      bornAt?: string;
    };
    helper?: ConsumerProcessIdentity;
    receipt?: {
      nonce: string;
      fileIdentity: ConsumerShareReceipt["fileIdentity"];
    };
  };
  input?: {
    bytes: number;
    expiresAt: number;
    birth?: { directory: StorageBirth; file: StorageBirth; name: string };
  };
}
export interface StorageBirth {
  device: string;
  fileId: string;
  bornAt: string;
}
export function storageBirth(
  stat: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): StorageBirth {
  return {
    device: String(stat.dev),
    fileId: String(stat.ino),
    bornAt: String(stat.birthtimeNs),
  };
}
function assertBirth(value: StorageBirth): void {
  if (
    !value ||
    Object.keys(value).sort().join() !== "bornAt,device,fileId" ||
    [value.device, value.fileId, value.bornAt].some(
      (value) => typeof value !== "string" || !/^\d{1,30}$/u.test(value),
    ) ||
    value.fileId === "0"
  )
    throw new Error("STORAGE_WRITE_INVALID");
}
export const PERSONAL_STAGING_MAX_ENTRIES = 64;
export const PERSONAL_STAGING_MAX_BYTES = 512 * 1024 ** 2;
export const SHARE_STAGING_MAX_ENTRIES = 16;
export const SHARE_STAGING_MAX_BYTES = 512 * 1024 ** 2;
export const SHARE_MAX_BYTES = 256 * 1024 ** 2;
export const SHARE_TREE =
  /^share\\requests\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const SHARE_FILE =
  /^share\\requests\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\media\.(mp3|m4a|webm|ogg|aac|wav|flac)$/u;
export interface StorageWriteLease {
  /** Actual private journal row; older injected ports may omit it and fail closed where required. */
  readonly id?: string;
  captureCreated(birth: StorageBirth, relativePath?: string): Promise<void>;
  settle(): Promise<void>;
  handoff(): Promise<void>;
  preparePublish(
    relative: string,
    metadata: string,
    temporaryMetadata: string,
    sha256: string,
  ): Promise<void>;
  sealShare?(relative: string, sha256: string, bytes: number): Promise<void>;
  handoffShare?(helper: ConsumerProcessIdentity): Promise<void>;
  confirmShareQuiesced?(
    receipt: ConsumerShareReceipt,
    inspect: (requestId: string) => Promise<ConsumerShareReceipt | null>,
  ): Promise<void>;
}
export interface StorageWriteTarget {
  relativePath: string;
  kind: "file" | "tree";
  eligible: boolean;
}
export function assertStorageWriteTarget(
  relative: string,
  kind: "file" | "tree",
): void {
  assertConsumerRelativePath(relative);
  if (
    !(kind === "tree"
      ? SHARE_TREE.test(relative) ||
        /^(?:personal\\results\\[a-f0-9-]{36}\.pending|personal\\inputs\\[a-f0-9-]{36}|(?:prepare|cloud)\\work\\[a-f0-9-]{36})$/u.test(
          relative,
        )
      : TEMP_FILE.test(relative) || !!partialWriteTarget(relative))
  )
    throw new Error("STORAGE_WRITE_INVALID");
}
function publication(value: StoragePublication, relative: string): void {
  if (
    !value ||
    Object.keys(value).sort().join() !==
      [
        "fingerprint",
        "metadataPath",
        "relativePath",
        "sha256",
        "temporaryMetadata",
        ...(value.temporaryMetadataBirth ? ["temporaryMetadataBirth"] : []),
      ]
        .sort()
        .join() ||
    !FINAL_FILE.test(value.relativePath) ||
    !relative.startsWith(`${value.relativePath}.`) ||
    value.metadataPath !== `${win32.dirname(value.relativePath)}\\media.json` ||
    !TEMP_FILE.test(value.temporaryMetadata) ||
    !value.temporaryMetadata.startsWith(`${value.metadataPath}.`) ||
    !HASH.test(value.sha256)
  )
    throw new Error("STORAGE_WRITE_INVALID");
  if (value.temporaryMetadataBirth) assertBirth(value.temporaryMetadataBirth);
  const f = value.fingerprint;
  if (
    !f ||
    Object.keys(f).sort().join() !==
      "bytes,changedAt,device,fileId,writtenAt" ||
    !Number.isSafeInteger(f.bytes) ||
    f.bytes < 1 ||
    f.bytes > 256 * 1024 ** 2 ||
    [f.device, f.fileId, f.writtenAt, f.changedAt].some(
      (v) => typeof v !== "string" || !/^\d{1,30}$/u.test(v),
    ) ||
    f.fileId === "0"
  )
    throw new Error("STORAGE_WRITE_INVALID");
}
/** Node-only copying/publication. Decoder scratch always requires the separate native Job certificate. Caller owns cache mutex. */
export class WindowsStorageWriteJournal {
  constructor(
    private readonly host: HostContext,
    private readonly processIdentity: (
      pid: number,
    ) => Promise<ConsumerProcessIdentity | null>,
  ) {}
  private async exists(relative: string): Promise<boolean> {
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async readOwned(): Promise<StorageWrite[]> {
    if (!(await this.exists(FILE))) return [];
    const value = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readPrivateBytes(this.host, FILE, 256 * 1024),
      ),
      256 * 1024,
      16384,
    ) as { version: number; writes: StorageWrite[] };
    if (
      !value ||
      Object.keys(value).sort().join() !== "version,writes" ||
      value.version !== 1 ||
      !Array.isArray(value.writes) ||
      value.writes.length > 256
    )
      throw new Error("STORAGE_WRITE_INVALID");
    const ids = new Set<string>(),
      paths = new Set<string>();
    for (const row of value.writes) {
      if (
        !row ||
        Object.keys(row).sort().join() !==
          [
            "createdAt",
            "id",
            "kind",
            "owner",
            "relativePath",
            "settled",
            ...(row.publication ? ["publication"] : []),
            ...(row.birth ? ["birth"] : []),
            ...(row.input ? ["input"] : []),
            ...(row.copyBytes !== undefined ? ["copyBytes"] : []),
            ...(row.share ? ["share"] : []),
          ]
            .sort()
            .join() ||
        !UUID.test(row.id) ||
        ids.has(row.id) ||
        paths.has(row.relativePath) ||
        !["file", "tree"].includes(row.kind) ||
        typeof row.settled !== "boolean" ||
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0
      )
        throw new Error("STORAGE_WRITE_INVALID");
      assertStorageWriteTarget(row.relativePath, row.kind);
      row.owner = processIdentityFromWire(processIdentityToWire(row.owner));
      if (row.owner.sid !== this.host.identity.sid)
        throw new Error("STORAGE_WRITE_INVALID");
      if (row.birth) assertBirth(row.birth);
      if (row.share && !SHARE_TREE.test(row.relativePath))
        throw new Error("STORAGE_WRITE_INVALID");
      const partial = partialWriteTarget(row.relativePath);
      if (partial) {
        if (
          row.kind !== "file" ||
          row.publication ||
          row.input ||
          !Number.isSafeInteger(row.copyBytes) ||
          row.copyBytes! < 1 ||
          row.copyBytes! > partial.maxBytes
        )
          throw new Error("STORAGE_WRITE_INVALID");
      } else if (SHARE_TREE.test(row.relativePath)) {
        this.assertShare(row);
      } else if (row.copyBytes !== undefined || row.share)
        throw new Error("STORAGE_WRITE_INVALID");
      if (row.publication) {
        if (row.kind !== "file") throw new Error("STORAGE_WRITE_INVALID");
        publication(row.publication, row.relativePath);
      }
      if (row.input) {
        if (
          row.kind !== "tree" ||
          row.publication ||
          !/^personal\\inputs\\[a-f0-9-]{36}$/u.test(row.relativePath) ||
          Object.keys(row.input).sort().join() !==
            (row.input.birth ? "birth,bytes,expiresAt" : "bytes,expiresAt") ||
          !Number.isSafeInteger(row.input.bytes) ||
          row.input.bytes < 1 ||
          row.input.bytes > 256 * 1024 ** 2 ||
          !Number.isSafeInteger(row.input.expiresAt) ||
          row.input.expiresAt < row.createdAt ||
          row.input.expiresAt > row.createdAt + 15 * 60000
        )
          throw new Error("STORAGE_WRITE_INVALID");
        if (row.input.birth) {
          const birth = row.input.birth;
          if (
            Object.keys(birth).sort().join() !== "directory,file,name" ||
            !/^source\.(mp3|m4a|mp4|mkv|mov|webm|opus|ogg|aac|wav|flac)$/u.test(
              birth.name,
            )
          )
            throw new Error("STORAGE_WRITE_INVALID");
          for (const identity of [birth.directory, birth.file])
            assertBirth(identity);
        }
      } else if (row.relativePath.startsWith("personal\\inputs\\"))
        throw new Error("STORAGE_WRITE_INVALID");
      ids.add(row.id);
      paths.add(row.relativePath);
    }
    const inputs = value.writes.filter((row) => row.input);
    if (
      inputs.length > PERSONAL_STAGING_MAX_ENTRIES ||
      inputs.reduce((sum, row) => sum + row.input!.bytes, 0) >
        PERSONAL_STAGING_MAX_BYTES
    )
      throw new Error("STORAGE_WRITE_INVALID");
    this.assertPartialBudgets(value.writes);
    return value.writes;
  }
  private assertPartialBudgets(writes: StorageWrite[]): void {
    const slots = new Set<string>();
    let thumbnails = 0,
      diagnostics = 0,
      originalBytes = 0,
      vocalsBytes = 0;
    const shares = writes.filter((row) => row.share);
    if (
      shares.length > SHARE_STAGING_MAX_ENTRIES ||
      shares.reduce((sum, row) => sum + row.copyBytes!, 0) >
        SHARE_STAGING_MAX_BYTES
    )
      throw new Error("STORAGE_WRITE_LIMIT");
    for (const row of writes) {
      const target = partialWriteTarget(row.relativePath);
      if (!target) continue;
      if (slots.has(target.canonical)) throw new Error("STORAGE_WRITE_LIMIT");
      slots.add(target.canonical);
      if (target.kind === "thumbnail") thumbnails++;
      else if (target.kind === "diagnostic-report") diagnostics++;
      else if (target.kind === "outbox-original")
        originalBytes += row.copyBytes!;
      else vocalsBytes += row.copyBytes!;
    }
    if (
      thumbnails > THUMBNAIL_PARTIAL_LIMIT ||
      diagnostics > DIAGNOSTIC_PARTIAL_LIMIT ||
      originalBytes > OUTBOX_PARTIAL_ROLE_MAX_BYTES ||
      vocalsBytes > OUTBOX_PARTIAL_ROLE_MAX_BYTES
    )
      throw new Error("STORAGE_WRITE_LIMIT");
  }
  private assertShare(row: StorageWrite): void {
    const share = row.share;
    if (
      !share ||
      row.kind !== "tree" ||
      row.publication ||
      row.input ||
      !Number.isSafeInteger(row.copyBytes) ||
      row.copyBytes! < 1 ||
      row.copyBytes! > SHARE_MAX_BYTES ||
      Object.keys(share).sort().join() !==
        [
          "nativePending",
          ...(share.quiesced !== undefined ? ["quiesced"] : []),
          ...(share.file ? ["file"] : []),
          ...(share.helper ? ["helper"] : []),
          ...(share.receipt ? ["receipt"] : []),
        ]
          .sort()
          .join() ||
      typeof share.nativePending !== "boolean" ||
      (share.quiesced !== undefined && share.quiesced !== true)
    )
      throw new Error("STORAGE_WRITE_INVALID");
    if (share.file) {
      const file = share.file,
        f = file.fingerprint;
      if (
        Object.keys(file).sort().join() !==
          [
            "fingerprint",
            "relativePath",
            "sha256",
            ...(file.bornAt !== undefined ? ["bornAt"] : []),
          ]
            .sort()
            .join() ||
        (file.bornAt !== undefined &&
          (typeof file.bornAt !== "string" ||
            !/^\d{1,30}$/u.test(file.bornAt))) ||
        !SHARE_FILE.test(file.relativePath) ||
        !file.relativePath.startsWith(`${row.relativePath}\\`) ||
        !HASH.test(file.sha256) ||
        !f ||
        Object.keys(f).sort().join() !==
          "bytes,changedAt,device,fileId,writtenAt" ||
        f.bytes !== row.copyBytes ||
        [f.device, f.fileId, f.writtenAt, f.changedAt].some(
          (v) => typeof v !== "string" || !/^\d{1,30}$/u.test(v),
        ) ||
        f.fileId === "0"
      )
        throw new Error("STORAGE_WRITE_INVALID");
    }
    if (share.nativePending) {
      if (!share.file || !share.helper)
        throw new Error("STORAGE_WRITE_INVALID");
      share.helper = processIdentityFromWire(
        processIdentityToWire(share.helper),
      );
      if (
        share.helper.sid !== row.owner.sid ||
        share.helper.sessionId !== row.owner.sessionId
      )
        throw new Error("STORAGE_WRITE_INVALID");
    } else if (share.helper || share.quiesced || share.receipt)
      throw new Error("STORAGE_WRITE_INVALID");
    if (share.receipt) {
      const binding = share.receipt,
        file = binding.fileIdentity;
      assertConsumerNonce(binding.nonce);
      if (
        Object.keys(binding).sort().join() !== "fileIdentity,nonce" ||
        !file ||
        Object.keys(file).sort().join() !==
          "creationTime,fileIndex,volumeSerial" ||
        !Number.isInteger(file.volumeSerial) ||
        file.volumeSerial < 0 ||
        file.volumeSerial > 0xffffffff ||
        [file.fileIndex, file.creationTime].some(
          (v) =>
            typeof v !== "string" ||
            !/^[1-9][0-9]{0,19}$/u.test(v) ||
            BigInt(v) > 0xffffffffffffffffn,
        )
      )
        throw new Error("STORAGE_WRITE_INVALID");
    }
    if (share.quiesced && !share.receipt)
      throw new Error("STORAGE_WRITE_INVALID");
  }
  async sealShareOwned(
    expected: StorageWrite,
    relativePath: string,
    sha256: string,
    bytes: number,
  ): Promise<void> {
    const writes = await this.readOwned(),
      row = this.matching(writes, expected);
    if (
      !row.share ||
      row.settled ||
      row.share.nativePending ||
      row.share.file ||
      !row.birth ||
      !SHARE_FILE.test(relativePath) ||
      !relativePath.startsWith(`${row.relativePath}\\`) ||
      !HASH.test(sha256) ||
      bytes !== row.copyBytes ||
      JSON.stringify(await this.birth(row.relativePath, "directory")) !==
        JSON.stringify(row.birth)
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    const proof = await verifyPrivateFile(
      this.host,
      relativePath,
      bytes,
      new AbortController().signal,
    );
    if (proof.sha256 !== sha256) throw new Error("STORAGE_WRITE_CHANGED");
    const birth = await this.birth(relativePath, "file");
    if (
      birth.device !== proof.fingerprint.device ||
      birth.fileId !== proof.fingerprint.fileId
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    row.share.file = {
      relativePath,
      sha256,
      fingerprint: proof.fingerprint,
      bornAt: birth.bornAt,
    };
    this.assertShare(row);
    await this.writeOwned(writes);
  }
  async handoffShareOwned(
    expected: StorageWrite,
    helper: ConsumerProcessIdentity,
  ): Promise<void> {
    const writes = await this.readOwned(),
      row = this.matching(writes, expected);
    helper = processIdentityFromWire(processIdentityToWire(helper));
    if (
      !row.share?.file ||
      row.settled ||
      row.share.nativePending ||
      helper.sid !== row.owner.sid ||
      helper.sessionId !== row.owner.sessionId ||
      JSON.stringify(
        await privateFingerprint(this.host, row.share.file.relativePath),
      ) !== JSON.stringify(row.share.file.fingerprint)
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    row.share.nativePending = true;
    row.share.helper = helper;
    this.assertShare(row);
    await this.writeOwned(writes);
  }
  async confirmShareQuiescedOwned(
    expected: StorageWrite,
    receipt: ConsumerShareReceipt,
    inspect: (requestId: string) => Promise<ConsumerShareReceipt | null>,
  ): Promise<void> {
    const writes = await this.readOwned(),
      row = this.matching(writes, expected),
      share = row.share;
    if (!share?.nativePending || !share.file || !share.helper || row.settled)
      throw new Error("STORAGE_RECOVERY_PENDING");
    const actual = await inspect(row.relativePath.split("\\")[2]!);
    if (
      !actual ||
      !shareReceiptAllowsCleanup(actual) ||
      !shareReceiptAllowsCleanup(receipt) ||
      actual.version !== 1 ||
      actual.requestId !== row.relativePath.split("\\")[2] ||
      actual.relativePath !== share.file.relativePath ||
      actual.sha256 !== share.file.sha256 ||
      actual.bytes !== row.copyBytes ||
      !sameConsumerProcess(actual.windowOwner, row.owner) ||
      !sameConsumerProcess(actual.helper, share.helper) ||
      actual.requestId !== receipt.requestId ||
      actual.nonce !== receipt.nonce ||
      actual.relativePath !== receipt.relativePath ||
      actual.sha256 !== receipt.sha256 ||
      actual.bytes !== receipt.bytes ||
      actual.state !== receipt.state ||
      actual.callback !== receipt.callback ||
      !sameConsumerProcess(actual.helper, receipt.helper) ||
      !sameConsumerProcess(actual.windowOwner, receipt.windowOwner) ||
      JSON.stringify(actual.fileIdentity) !==
        JSON.stringify(receipt.fileIdentity) ||
      (share.receipt &&
        (actual.nonce !== share.receipt.nonce ||
          JSON.stringify(actual.fileIdentity) !==
            JSON.stringify(share.receipt.fileIdentity)))
    )
      throw new Error("STORAGE_RECOVERY_PENDING");
    if (
      !share.quiesced &&
      (JSON.stringify(
        await privateFingerprint(this.host, share.file.relativePath),
      ) !== JSON.stringify(share.file.fingerprint) ||
        (
          await verifyPrivateFile(
            this.host,
            share.file.relativePath,
            row.copyBytes!,
            new AbortController().signal,
          )
        ).sha256 !== share.file.sha256)
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    share.receipt = { nonce: actual.nonce, fileIdentity: actual.fileIdentity };
    share.quiesced = true;
    this.assertShare(row);
    await this.writeOwned(writes);
  }
  private writeOwned(writes: StorageWrite[]) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, writes }));
    if (bytes.length > 256 * 1024) throw new Error("STORAGE_WRITE_LIMIT");
    return writePrivateAtomic(this.host, FILE, bytes);
  }
  async beginOwned(
    relativePath: string,
    kind: "file" | "tree",
    input?: StorageWrite["input"],
    copyBytes?: number,
  ): Promise<StorageWrite> {
    assertStorageWriteTarget(relativePath, kind);
    const writes = await this.readOwned();
    const partial = partialWriteTarget(relativePath);
    const share = SHARE_TREE.test(relativePath);
    if (
      partial
        ? !Number.isSafeInteger(copyBytes) ||
          copyBytes! < 1 ||
          copyBytes! > partial.maxBytes ||
          kind !== "file"
        : share
          ? kind !== "tree" ||
            !Number.isSafeInteger(copyBytes) ||
            copyBytes! < 1 ||
            copyBytes! > SHARE_MAX_BYTES
          : copyBytes !== undefined
    )
      throw new Error("STORAGE_WRITE_INVALID");
    if (relativePath.startsWith("personal\\inputs\\")) {
      if (
        !input ||
        kind !== "tree" ||
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 1 ||
        input.bytes > 256 * 1024 ** 2 ||
        !Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt <= Date.now() ||
        input.expiresAt > Date.now() + 15 * 60000
      )
        throw new Error("STORAGE_WRITE_INVALID");
      const stages = writes.filter((row) => row.input);
      if (
        stages.length >= PERSONAL_STAGING_MAX_ENTRIES ||
        stages.reduce((sum, row) => sum + row.input!.bytes, 0) + input.bytes >
          PERSONAL_STAGING_MAX_BYTES
      )
        throw new Error("INPUT_LIMIT");
    } else if (input) throw new Error("STORAGE_WRITE_INVALID");
    if (
      writes.length >= 256 ||
      writes.some((row) => row.relativePath === relativePath)
    )
      throw new Error("STORAGE_WRITE_LIMIT");
    await this.host.native.validatePath("personal", relativePath, "absent");
    const owner = await this.processIdentity(process.pid);
    if (
      !owner ||
      owner.pid !== process.pid ||
      owner.sid !== this.host.identity.sid ||
      owner.sessionId !== this.host.identity.sessionId
    )
      throw new Error("STORAGE_OWNER_INVALID");
    const row = {
      id: randomUUID(),
      relativePath,
      kind,
      owner,
      settled: false,
      createdAt: Date.now(),
      ...(input ? { input: structuredClone(input) } : {}),
      ...(copyBytes !== undefined ? { copyBytes } : {}),
      ...(share ? { share: { nativePending: false } } : {}),
    };
    this.assertPartialBudgets([...writes, row]);
    await this.writeOwned([...writes, row]);
    return row;
  }
  /** Exact dead/settled Node copier temporaries only; durable Outbox canonical retention stays intact. Caller owns cache/pin authority. */
  async reclaimPartialFilesOwned(
    canonical: string,
    signal: AbortSignal,
    assertUnpinned: (relative: string) => void,
  ): Promise<void> {
    assertPartialCanonical(canonical);
    const writes = await this.readOwned();
    for (const row of writes.filter(
      (row) => partialWriteTarget(row.relativePath)?.canonical === canonical,
    )) {
      signal.throwIfAborted();
      if (!(await this.eligible(row)))
        throw new Error("STORAGE_RECOVERY_PENDING");
      if (await this.exists(row.relativePath)) {
        if (!row.birth) throw new Error("STORAGE_RECOVERY_PENDING");
        if (
          JSON.stringify(await this.birth(row.relativePath, "file")) !==
          JSON.stringify(row.birth)
        )
          throw new Error("STORAGE_WRITE_CHANGED");
        if (
          partialWriteTarget(row.relativePath)?.kind === "diagnostic-report" &&
          (await chromeDiagnosticPartialProtected(
            this.host,
            row.relativePath,
            row.birth,
          ))
        )
          continue;
      }
      if (row.birth) {
        assertUnpinned(row.relativePath);
        await discardStoragePartial(this.host, row.id);
      }
      writes.splice(writes.indexOf(row), 1);
    }
    await this.writeOwned(writes);
  }
  private matching(
    writes: StorageWrite[],
    expected: StorageWrite,
  ): StorageWrite {
    const row = writes.find((row) => row.id === expected.id);
    if (
      !row ||
      !sameConsumerProcess(row.owner, expected.owner) ||
      row.relativePath !== expected.relativePath
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    return row;
  }
  async preparePublishOwned(
    expected: StorageWrite,
    relativePath: string,
    metadataPath: string,
    temporaryMetadata: string,
    sha256: string,
  ): Promise<void> {
    const writes = await this.readOwned(),
      row = this.matching(writes, expected);
    if (
      row.kind !== "file" ||
      row.settled ||
      !row.birth ||
      JSON.stringify(await this.birth(row.relativePath, "file")) !==
        JSON.stringify(row.birth)
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    const value = {
      relativePath,
      metadataPath,
      temporaryMetadata,
      sha256,
      fingerprint: await privateFingerprint(this.host, row.relativePath),
    };
    publication(value, row.relativePath);
    row.publication = value;
    await this.writeOwned(writes);
  }
  async finishOwned(expected: StorageWrite): Promise<void> {
    const writes = await this.readOwned(),
      row = this.matching(writes, expected);
    if (row.share?.nativePending && !row.share.quiesced)
      throw new Error("STORAGE_RECOVERY_PENDING");
    row.settled = true;
    if (
      !(await this.exists(row.relativePath)) &&
      (!row.publication || (await this.committed(row.publication)))
    ) {
      if (row.input)
        await this.host.native.vaultDelete(
          "account",
          `personal_input_${row.relativePath.split("\\")[2]}`,
        );
      writes.splice(writes.indexOf(row), 1);
    }
    await this.writeOwned(writes);
  }
  async eligible(row: StorageWrite): Promise<boolean> {
    if (row.share?.nativePending) return row.share.quiesced === true;
    if (row.input && Date.now() < row.input.expiresAt) return false;
    if (row.settled) return true;
    try {
      const current = await this.processIdentity(row.owner.pid);
      return !current || !sameConsumerProcess(current, row.owner);
    } catch {
      return false;
    }
  }
  async handoffOwned(expected: StorageWrite): Promise<void> {
    const writes = await this.readOwned(),
      row = this.matching(writes, expected);
    if (
      row.kind !== "tree" ||
      !/^(?:prepare|cloud)\\work\\[a-f0-9-]{36}$/u.test(row.relativePath) ||
      !row.birth ||
      JSON.stringify(await this.birth(row.relativePath, "directory")) !==
        JSON.stringify(row.birth)
    )
      throw new Error("STORAGE_WRITE_INVALID");
    await this.writeOwned(writes.filter((value) => value !== row));
  }
  /** Input moves into an already protected native workspace before Node-only ownership retires. */
  async consumeInputOwned(relative: string): Promise<void> {
    const writes = await this.readOwned(),
      row = writes.find((value) => value.relativePath === relative);
    if (!row?.input || !row.settled || (await this.exists(relative)))
      throw new Error("STORAGE_WRITE_CHANGED");
    await this.writeOwned(writes.filter((value) => value !== row));
  }
  private async birth(
    relative: string,
    kind: "file" | "directory",
  ): Promise<StorageBirth> {
    await this.host.native.validatePath("personal", relative, kind);
    const stat = await lstat(win32.join(this.host.personalRoot, relative), {
      bigint: true,
    });
    if (
      stat.isSymbolicLink() ||
      stat.ino === 0n ||
      (kind === "file"
        ? !stat.isFile() || stat.nlink !== 1n
        : !stat.isDirectory())
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    return storageBirth(stat);
  }
  /** Bind the newly created FD/directory before bytes. Caller holds cache mutation authority. */
  async captureCreatedOwned(
    expected: StorageWrite,
    created: StorageBirth,
    relativePath = expected.relativePath,
  ): Promise<void> {
    assertBirth(created);
    const writes = await this.readOwned(),
      row = this.matching(writes, expected);
    if (row.settled || row.input) throw new Error("STORAGE_WRITE_CHANGED");
    const metadata = relativePath === row.publication?.temporaryMetadata;
    if (
      (metadata && row.publication?.temporaryMetadataBirth) ||
      (!metadata && (relativePath !== row.relativePath || row.birth))
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    if (
      JSON.stringify(
        await this.birth(
          relativePath,
          metadata || row.kind === "file" ? "file" : "directory",
        ),
      ) !== JSON.stringify(created)
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    if (metadata) row.publication!.temporaryMetadataBirth = created;
    else row.birth = created;
    await this.writeOwned(writes);
  }
  async recordInputBirthOwned(
    expected: StorageWrite,
    name: string,
    createdFile: StorageBirth,
  ): Promise<void> {
    const writes = await this.readOwned(),
      row = this.matching(writes, expected);
    if (
      !row.input ||
      row.settled ||
      row.input.birth ||
      !/^source\.(mp3|m4a|mp4|mkv|mov|webm|opus|ogg|aac|wav|flac)$/u.test(name)
    )
      throw new Error("STORAGE_WRITE_CHANGED");
    const file = await this.birth(`${row.relativePath}\\${name}`, "file");
    if (JSON.stringify(file) !== JSON.stringify(createdFile))
      throw new Error("STORAGE_WRITE_CHANGED");
    row.input.birth = {
      directory: await this.birth(row.relativePath, "directory"),
      file,
      name,
    };
    await this.writeOwned(writes);
  }
  /** Expired unclaimed input copies only; active Native workspace/pin handoff is a different authority. */
  async reclaimInputsOwned(
    assertUnpinned: (relative: string) => void,
  ): Promise<void> {
    for (const row of await this.readOwned()) {
      const birth = row.input?.birth;
      if (
        !birth ||
        !(await this.eligible(row)) ||
        !(await this.exists(row.relativePath))
      )
        continue;
      try {
        assertUnpinned(row.relativePath);
      } catch (error) {
        if (error instanceof Error && error.message === "LIBRARY_MEDIA_PINNED")
          continue;
        throw error;
      }
      if (
        JSON.stringify(await this.birth(row.relativePath, "directory")) !==
        JSON.stringify(birth.directory)
      )
        throw new Error("STORAGE_WRITE_CHANGED");
      const names = await readdir(
        win32.join(this.host.personalRoot, row.relativePath),
      );
      if (names.some((name) => name !== birth.name))
        throw new Error("STORAGE_WRITE_CHANGED");
      try {
        if (names.length) {
          const relative = `${row.relativePath}\\${birth.name}`;
          if (
            JSON.stringify(await this.birth(relative, "file")) !==
            JSON.stringify(birth.file)
          )
            throw new Error("STORAGE_WRITE_CHANGED");
          const stat = await lstat(
            win32.join(this.host.personalRoot, relative),
            { bigint: true },
          );
          await this.removeExpiredInputPath(relative, "file", {
            ...birth.file,
            bytes: Number(stat.size),
            writtenAt: String(stat.mtimeNs),
            changedAt: String(stat.ctimeNs),
          });
        }
        await this.removeExpiredInputPath(
          row.relativePath,
          "directory",
          birth.directory,
        );
      } catch (error) {
        if (
          ["EBUSY", "EACCES", "EPERM"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          continue;
        throw error;
      }
    }
    await this.removeAbsentOwned();
  }
  private async removeExpiredInputPath(
    relative: string,
    kind: "file" | "directory",
    expected:
      | StorageBirth
      | (StorageBirth & {
          bytes: number;
          writtenAt: string;
          changedAt: string;
        }),
  ): Promise<void> {
    // Caller already holds cache/pin admission and has positively established
    // that the exact input copier/consumer no longer owns this expired copy.
    const native = this.host.native;
    const candidate = await native.beginCacheDeletion(relative, kind, expected);
    if (!candidate) throw new Error("STORAGE_RECOVERY_PENDING");
    if ((await native.commitCacheDeletion(candidate)) !== "completed")
      throw new Error("STORAGE_RECOVERY_PENDING");
    await native.releaseCacheDeletion(candidate);
  }
  private async committed(p: StoragePublication): Promise<boolean> {
    if (
      !(await this.exists(p.relativePath)) ||
      !(await this.exists(p.metadataPath))
    )
      return false;
    const row = parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readPrivateBytes(this.host, p.metadataPath, 4096),
        ),
      ) as Record<string, unknown>,
      parts = p.relativePath.split("\\");
    return (
      Object.keys(row).sort().join() ===
        "artifactId,bytes,contentType,createdAt,durationSeconds,jobId,ownerUid,relativePath,sha256,variant,version" &&
      row.version === 1 &&
      UUID.test(String(row.artifactId)) &&
      typeof row.ownerUid === "string" &&
      createHash("sha256").update(row.ownerUid).digest("hex") === parts[2] &&
      row.jobId === parts[3] &&
      row.variant === parts[4] &&
      row.sha256 === p.sha256 &&
      row.bytes === p.fingerprint.bytes &&
      Number.isFinite(row.durationSeconds) &&
      Number(row.durationSeconds) > 0 &&
      Number(row.durationSeconds) <= 7200 &&
      Number.isSafeInteger(row.createdAt) &&
      Number(row.createdAt) >= 0 &&
      row.contentType ===
        (
          {
            mp3: "audio/mpeg",
            m4a: "audio/mp4",
            mp4: "audio/mp4",
            webm: "audio/webm",
            opus: "audio/ogg",
            ogg: "audio/ogg",
            aac: "audio/aac",
            wav: "audio/wav",
            flac: "audio/flac",
          } as Record<string, string>
        )[win32.extname(p.relativePath).slice(1)] &&
      row.relativePath === p.relativePath
    );
  }
  async targetsOwned(signal: AbortSignal): Promise<StorageWriteTarget[]> {
    const targets: StorageWriteTarget[] = [];
    for (const row of await this.readOwned()) {
      signal.throwIfAborted();
      let eligible = await this.eligible(row);
      if (!row.input && (await this.exists(row.relativePath))) {
        if (!row.birth) eligible = false;
        else if (
          JSON.stringify(
            await this.birth(
              row.relativePath,
              row.kind === "file" ? "file" : "directory",
            ),
          ) !== JSON.stringify(row.birth)
        )
          throw new Error("STORAGE_WRITE_CHANGED");
      }
      if (row.input && (await this.exists(row.relativePath))) {
        const birth = row.input.birth;
        if (!birth) eligible = false;
        else {
          if (
            JSON.stringify(await this.birth(row.relativePath, "directory")) !==
            JSON.stringify(birth.directory)
          )
            throw new Error("STORAGE_WRITE_CHANGED");
          const names = await readdir(
            win32.join(this.host.personalRoot, row.relativePath),
          );
          if (
            names.some((name) => name !== birth.name) ||
            (names.length &&
              JSON.stringify(
                await this.birth(`${row.relativePath}\\${birth.name}`, "file"),
              ) !== JSON.stringify(birth.file))
          )
            throw new Error("STORAGE_WRITE_CHANGED");
        }
      }
      if (await this.exists(row.relativePath))
        targets.push({
          relativePath: row.relativePath,
          kind: row.kind,
          eligible,
        });
      const p = row.publication;
      if (!p) continue;
      if (await this.exists(p.temporaryMetadata)) {
        if (
          p.temporaryMetadataBirth &&
          JSON.stringify(await this.birth(p.temporaryMetadata, "file")) !==
            JSON.stringify(p.temporaryMetadataBirth)
        )
          throw new Error("STORAGE_WRITE_CHANGED");
        targets.push({
          relativePath: p.temporaryMetadata,
          kind: "file",
          eligible: p.temporaryMetadataBirth ? eligible : false,
        });
      }
      if (
        (await this.exists(p.relativePath)) &&
        !(await this.exists(p.metadataPath))
      ) {
        if (!row.birth) eligible = false;
        else if (
          JSON.stringify(await this.birth(p.relativePath, "file")) !==
          JSON.stringify(row.birth)
        )
          throw new Error("STORAGE_WRITE_CHANGED");
        const current = await privateFingerprint(this.host, p.relativePath);
        if (
          ["device", "fileId", "bytes", "writtenAt"].some(
            (key) =>
              current[key as keyof PrivateFileFingerprint] !==
              p.fingerprint[key as keyof PrivateFileFingerprint],
          )
        )
          throw new Error("STORAGE_WRITE_CHANGED");
        if (
          eligible &&
          (
            await verifyPrivateFile(
              this.host,
              p.relativePath,
              p.fingerprint.bytes,
              signal,
            )
          ).sha256 !== p.sha256
        )
          throw new Error("STORAGE_WRITE_CHANGED");
        targets.push({ relativePath: p.relativePath, kind: "file", eligible });
      }
    }
    return targets;
  }
  async removeAbsentOwned(): Promise<void> {
    const keep: StorageWrite[] = [];
    for (const row of await this.readOwned()) {
      if (
        !(await this.eligible(row)) ||
        (await this.exists(row.relativePath)) ||
        (row.publication &&
          ((await this.exists(row.publication.temporaryMetadata)) ||
            ((await this.exists(row.publication.relativePath)) &&
              !(await this.committed(row.publication)))))
      )
        keep.push(row);
      else if (row.input)
        await this.host.native.vaultDelete(
          "account",
          `personal_input_${row.relativePath.split("\\")[2]}`,
        );
    }
    await this.writeOwned(keep);
  }
  static key(relative: string) {
    return createHash("sha256").update(relative).digest("hex");
  }
}
