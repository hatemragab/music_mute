import { lstat, readdir, rename, rmdir, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { win32 } from "node:path";
import {
  sameConsumerProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { HostContext } from "../host-context.js";
import type { PreparationBundle } from "./bundle.js";
import { PrepareFailure } from "./controller.js";
import type { RuntimeRepairRecord } from "./runtime-repair.js";

export const RUNTIME_STAGING_PATH = "staging\\prepare-runtime";
export const RUNTIME_STAGING_KEY = "prepare_runtime_staging";
export interface RuntimeDirectoryBirth {
  device: string;
  fileId: string;
  bornAt: string;
}
export interface RuntimeStagingRecord {
  version: 1;
  target: string;
  archiveSha256: string;
  releaseVersion: string;
  sequence: number;
  path: typeof RUNTIME_STAGING_PATH;
  owner: ConsumerProcessIdentity;
  birth: RuntimeDirectoryBirth;
  state: "copying" | "verified";
  manifestSha256: string | null;
}
function invalid(): never {
  throw new PrepareFailure("INTEGRITY_INVALID");
}
export function runtimeBirth(
  value: BigIntStats,
  directory: boolean,
): RuntimeDirectoryBirth {
  if (
    value.isSymbolicLink() ||
    !(directory ? value.isDirectory() : value.isFile() && value.nlink === 1n) ||
    value.ino === 0n
  )
    return invalid();
  return {
    device: String(value.dev),
    fileId: String(value.ino),
    bornAt: String(value.birthtimeNs),
  };
}
export function sameRuntimeBirth(
  a: RuntimeDirectoryBirth,
  b: RuntimeDirectoryBirth,
): boolean {
  return (
    a.device === b.device && a.fileId === b.fileId && a.bornAt === b.bornAt
  );
}
function parse(value: unknown, sid: string): RuntimeStagingRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const row = value as RuntimeStagingRecord;
  if (
    Object.keys(row).sort().join() !==
      "archiveSha256,birth,manifestSha256,owner,path,releaseVersion,sequence,state,target,version" ||
    row.version !== 1 ||
    row.path !== RUNTIME_STAGING_PATH ||
    !/^[a-f0-9]{64}$/u.test(row.target) ||
    !/^[a-f0-9]{64}$/u.test(row.archiveSha256) ||
    typeof row.releaseVersion !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(row.releaseVersion) ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !["copying", "verified"].includes(row.state) ||
    (row.state === "copying"
      ? row.manifestSha256 !== null
      : typeof row.manifestSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(row.manifestSha256)) ||
    !row.birth ||
    Object.keys(row.birth).sort().join() !== "bornAt,device,fileId" ||
    [row.birth.device, row.birth.fileId, row.birth.bornAt].some(
      (part) => typeof part !== "string" || !/^\d{1,30}$/u.test(part),
    ) ||
    row.birth.fileId === "0"
  )
    return invalid();
  try {
    row.owner = processIdentityFromWire(processIdentityToWire(row.owner));
  } catch {
    return invalid();
  }
  if (row.owner.sid !== sid) return invalid();
  return row;
}

/** Caller holds the real SID-wide Prepare lease. Only Node extraction writes this
 * fixed directory: it is never an engine/decoder workspace or a user file root. */
export class RuntimeStaging {
  private owned: RuntimeStagingRecord | undefined;
  private ownedCopyClosed = false;
  constructor(
    private readonly host: HostContext,
    private readonly verifyPromoted: (
      record: RuntimeStagingRecord,
      relative: string,
    ) => Promise<void>,
  ) {}
  private path(relative: string): string {
    return win32.join(this.host.personalRoot, relative);
  }
  private async exists(relative: string): Promise<boolean> {
    try {
      await lstat(this.path(relative));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async read(): Promise<RuntimeStagingRecord | null> {
    const bytes = await this.host.native.vaultRead(
      "account",
      RUNTIME_STAGING_KEY,
    );
    if (!bytes) return null;
    try {
      if (bytes.length > 4096) return invalid();
      return parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        this.host.identity.sid,
      );
    } catch {
      return invalid();
    } finally {
      bytes.fill(0);
    }
  }
  private async exact(
    relative: string,
    expected: RuntimeDirectoryBirth,
    directory = true,
  ) {
    await this.host.native.validatePath(
      "personal",
      relative,
      directory ? "directory" : "file",
    );
    if (
      !sameRuntimeBirth(
        runtimeBirth(
          await lstat(this.path(relative), { bigint: true }),
          directory,
        ),
        expected,
      )
    )
      return invalid();
  }
  private async remove(record: RuntimeStagingRecord): Promise<void> {
    await this.exact(record.path, record.birth);
    let entries = 0;
    const visit = async (
      relative: string,
      expected: RuntimeDirectoryBirth,
    ): Promise<void> => {
      await this.exact(relative, expected);
      for (const item of await readdir(this.path(relative), {
        withFileTypes: true,
      })) {
        if (++entries > 100_000) return invalid();
        const child = `${relative}\\${item.name}`;
        const info = await lstat(this.path(child), { bigint: true });
        const directory = info.isDirectory();
        const childBirth = runtimeBirth(info, directory);
        await this.exact(record.path, record.birth);
        await this.exact(child, childBirth, directory);
        if (directory) await visit(child, childBirth);
        else {
          await this.exact(child, childBirth, false);
          await unlink(this.path(child));
        }
      }
      await this.exact(relative, expected);
      await rmdir(this.path(relative));
    };
    await visit(record.path, record.birth);
  }
  /** A live/reused/unknown consuming Node cannot be treated as a dead writer. */
  async recover(): Promise<void> {
    const record = await this.read();
    if (!record) {
      if (await this.exists(RUNTIME_STAGING_PATH)) return invalid();
      return;
    }
    // The same instance may retire its own acknowledged, fully closed copy
    // after a rename ACK fault. A new/restarted instance must prove the old
    // consuming Node birth is gone before changing even an absent-stage WAL.
    if (
      this.ownedCopyClosed &&
      this.owned &&
      JSON.stringify(record) === JSON.stringify(this.owned) &&
      !(await this.exists(record.path))
    ) {
      await this.complete();
      return;
    }
    if (!this.host.native.processIdentity) return invalid();
    let current: ConsumerProcessIdentity | null;
    try {
      current = await this.host.native.processIdentity(record.owner.pid);
    } catch {
      return invalid();
    }
    if (current && sameConsumerProcess(current, record.owner))
      throw new PrepareFailure("BUSY");
    const final = `runtime\\releases\\${record.target}`;
    if (!(await this.exists(record.path))) {
      // Rename may have succeeded before its ACK/record retirement. Preserve the
      // final release and clear only after its exact birth and full proof pass.
      if (await this.exists(final)) {
        if (record.state !== "verified") return invalid();
        await this.exact(final, record.birth);
        await this.verifyPromoted(record, final);
      }
      await this.host.native.vaultDelete("account", RUNTIME_STAGING_KEY);
      return;
    }
    await this.exact(record.path, record.birth);
    await this.remove(record);
    await this.host.native.vaultDelete("account", RUNTIME_STAGING_KEY);
  }
  async create(bundle: PreparationBundle): Promise<string> {
    await this.recover();
    if (!this.host.native.processIdentity) return invalid();
    const owner = await this.host.native.processIdentity(process.pid);
    if (
      !owner ||
      owner.pid !== process.pid ||
      owner.sid !== this.host.identity.sid ||
      owner.sessionId !== this.host.identity.sessionId
    )
      return invalid();
    await this.host.native.validatePath(
      "personal",
      RUNTIME_STAGING_PATH,
      "absent",
    );
    const path = await this.host.directory(RUNTIME_STAGING_PATH);
    const row: RuntimeStagingRecord = {
      version: 1,
      target: bundle.targetIdentity,
      archiveSha256: bundle.metadata.release.sha256,
      releaseVersion: bundle.metadata.releaseVersion,
      sequence: bundle.metadata.sequence,
      path: RUNTIME_STAGING_PATH,
      owner,
      birth: runtimeBirth(await lstat(path, { bigint: true }), true),
      state: "copying",
      manifestSha256: null,
    };
    parse(row, this.host.identity.sid);
    this.owned = row;
    this.ownedCopyClosed = false;
    try {
      await this.exact(row.path, row.birth);
      await this.host.native.vaultWrite(
        "account",
        RUNTIME_STAGING_KEY,
        Buffer.from(JSON.stringify(row)),
      );
      return path;
    } catch (error) {
      await this.discardOwned();
      throw error;
    }
  }
  async verified(manifestSha256: string): Promise<void> {
    if (!this.owned || !/^[a-f0-9]{64}$/u.test(manifestSha256))
      return invalid();
    await this.exact(this.owned.path, this.owned.birth);
    this.owned = { ...this.owned, state: "verified", manifestSha256 };
    await this.host.native.vaultWrite(
      "account",
      RUNTIME_STAGING_KEY,
      Buffer.from(JSON.stringify(this.owned)),
    );
  }
  verifiedRecord(): RuntimeStagingRecord {
    if (!this.owned || this.owned.state !== "verified") return invalid();
    return structuredClone(this.owned);
  }
  async promote(): Promise<void> {
    const record = this.owned;
    if (!record || record.state !== "verified") return invalid();
    const final = `runtime\\releases\\${record.target}`;
    await this.exact(record.path, record.birth);
    await this.host.native.validatePath("personal", final, "absent");
    await rename(this.path(record.path), this.path(final));
    await this.exact(final, record.birth);
  }
  async complete(): Promise<void> {
    const record = this.owned;
    if (!record || record.state !== "verified") return invalid();
    if (await this.exists(record.path)) return invalid();
    const final = `runtime\\releases\\${record.target}`;
    await this.exact(final, record.birth);
    await this.verifyPromoted(record, final);
    await this.host.native.vaultDelete("account", RUNTIME_STAGING_KEY);
    this.owned = undefined;
    this.ownedCopyClosed = false;
  }
  /** A durable, positively verified repair promotion proves this exact copy has
   * closed even when the original Node remains alive. It never permits reclaim
   * of an earlier copying/rename phase or another staging birth. */
  async acceptRepairPromotion(repair: RuntimeRepairRecord): Promise<void> {
    const row = await this.read();
    if (!row) return;
    if (
      !["promoted", "activated"].includes(repair.phase) ||
      row.state !== "verified" ||
      row.target !== repair.target ||
      row.archiveSha256 !== repair.archiveSha256 ||
      row.sequence !== repair.sequence ||
      row.releaseVersion !== repair.releaseVersion ||
      row.manifestSha256 !== repair.manifestSha256 ||
      !sameRuntimeBirth(row.birth, repair.newBirth) ||
      !sameConsumerProcess(row.owner, repair.owner) ||
      (await this.exists(row.path))
    )
      return invalid();
    const final = `runtime\\releases\\${row.target}`;
    await this.exact(final, row.birth);
    await this.verifyPromoted(row, final);
    await this.host.native.vaultDelete("account", RUNTIME_STAGING_KEY);
    this.owned = undefined;
    this.ownedCopyClosed = false;
  }
  /** Only after this instance's extraction has returned and closed every FD. A
   * published final release is preserved even if proof/retirement ACK is lost. */
  async discardOwned(): Promise<void> {
    const record = this.owned;
    if (!record) return;
    this.ownedCopyClosed = true;
    if (!(await this.exists(record.path))) return;
    const saved = await this.read();
    if (
      saved &&
      (!sameRuntimeBirth(saved.birth, record.birth) ||
        !sameConsumerProcess(saved.owner, record.owner))
    )
      return invalid();
    await this.remove(record);
    await this.host.native.vaultDelete("account", RUNTIME_STAGING_KEY);
    this.owned = undefined;
  }
}
