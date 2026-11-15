import { createHash } from "node:crypto";
import { lstat, readdir, rename } from "node:fs/promises";
import { win32 } from "node:path";
import {
  sameConsumerProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  assertConsumerRelativePath,
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { HostContext } from "../host-context.js";
import type { PreparationBundle } from "./bundle.js";
import { PrepareFailure, type PrepareTarget } from "./controller.js";
import {
  readPrivateBytes,
  verifyPrivateFile,
  writePrivateAtomic,
} from "./private-files.js";
import {
  RUNTIME_STAGING_PATH,
  runtimeBirth,
  sameRuntimeBirth,
  type RuntimeDirectoryBirth,
  type RuntimeStagingRecord,
} from "./runtime-staging.js";
import { MAX_UNPACKED_BYTES } from "./verified-archive.js";

import {
  RUNTIME_REPAIR_KEY,
  RUNTIME_BACKUP_PATH,
  RUNTIME_BACKUP_INVENTORY,
  RUNTIME_BACKUP_INVENTORY_MAX as MAX_INVENTORY_BYTES,
  RUNTIME_BACKUP_ENTRY_MAX,
} from "./runtime-repair-policy.js";
export {
  RUNTIME_REPAIR_KEY,
  RUNTIME_BACKUP_PATH,
  RUNTIME_BACKUP_INVENTORY,
} from "./runtime-repair-policy.js";
const HEX = /^[a-f0-9]{64}$/u;
type Phase =
  | "snapshotting"
  | "quarantining"
  | "promoting"
  | "promoted"
  | "activated"
  | "deleting";
export interface RuntimeRepairRecord {
  version: 1;
  target: string;
  archiveSha256: string;
  releaseVersion: string;
  sequence: number;
  owner: ConsumerProcessIdentity;
  oldBirth: RuntimeDirectoryBirth;
  newBirth: RuntimeDirectoryBirth;
  oldTreeDigest: string | null;
  manifestSha256: string;
  previousManifestSha256: string | null;
  phase: Phase;
}
export interface RuntimeBackupEntry {
  path: string;
  kind: "directory" | "file";
  birth: RuntimeDirectoryBirth;
  bytes: number | null;
  sha256: string | null;
}
export function parseRuntimeBackupInventory(
  bytes: Buffer,
): RuntimeBackupEntry[] {
  if (bytes.length > MAX_INVENTORY_BYTES) return invalid();
  let raw: { version: number; entries: RuntimeBackupEntry[] };
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
  if (
    !raw ||
    Object.keys(raw).sort().join() !== "entries,version" ||
    raw.version !== 1 ||
    !Array.isArray(raw.entries) ||
    raw.entries.length < 1 ||
    raw.entries.length > RUNTIME_BACKUP_ENTRY_MAX
  )
    return invalid();
  const paths = new Map<string, "directory" | "file">();
  let total = 0;
  for (const entry of raw.entries) {
    if (
      !entry ||
      Object.keys(entry).sort().join() !== "birth,bytes,kind,path,sha256" ||
      !validBirth(entry.birth) ||
      typeof entry.path !== "string" ||
      !["file", "directory"].includes(entry.kind) ||
      paths.has(entry.path.toLowerCase())
    )
      return invalid();
    if (entry.path) {
      try {
        assertConsumerRelativePath(entry.path.replaceAll("/", "\\"));
      } catch {
        return invalid();
      }
      if (
        entry.path.includes("\\") ||
        entry.path.split("/").length > 32 ||
        paths.get(
          entry.path.includes("/")
            ? entry.path.slice(0, entry.path.lastIndexOf("/")).toLowerCase()
            : "",
        ) !== "directory"
      )
        return invalid();
    } else if (paths.size !== 0 || entry.kind !== "directory") return invalid();
    if (
      entry.kind === "directory"
        ? entry.bytes !== null || entry.sha256 !== null
        : !Number.isSafeInteger(entry.bytes) ||
          entry.bytes === null ||
          entry.bytes < 0 ||
          typeof entry.sha256 !== "string" ||
          !HEX.test(entry.sha256)
    )
      return invalid();
    total += entry.bytes ?? 0;
    if (total > MAX_UNPACKED_BYTES) return invalid();
    paths.set(entry.path.toLowerCase(), entry.kind);
  }
  return raw.entries;
}
function invalid(): never {
  throw new PrepareFailure("INTEGRITY_INVALID");
}
function validBirth(value: unknown): value is RuntimeDirectoryBirth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as RuntimeDirectoryBirth;
  return (
    Object.keys(row).sort().join() === "bornAt,device,fileId" &&
    [row.device, row.fileId, row.bornAt].every(
      (part) => typeof part === "string" && /^\d{1,30}$/u.test(part),
    ) &&
    row.fileId !== "0"
  );
}
function parse(value: unknown, sid: string): RuntimeRepairRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const row = value as RuntimeRepairRecord;
  if (
    Object.keys(row).sort().join() !==
      "archiveSha256,manifestSha256,newBirth,oldBirth,oldTreeDigest,owner,phase,previousManifestSha256,releaseVersion,sequence,target,version" ||
    row.version !== 1 ||
    !HEX.test(row.target) ||
    !HEX.test(row.archiveSha256) ||
    !HEX.test(row.manifestSha256) ||
    typeof row.releaseVersion !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(row.releaseVersion) ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !validBirth(row.oldBirth) ||
    !validBirth(row.newBirth) ||
    ![
      "snapshotting",
      "quarantining",
      "promoting",
      "promoted",
      "activated",
      "deleting",
    ].includes(row.phase) ||
    (row.oldTreeDigest === null
      ? row.phase !== "snapshotting"
      : !HEX.test(row.oldTreeDigest)) ||
    (row.previousManifestSha256 !== null &&
      !HEX.test(row.previousManifestSha256))
  )
    return invalid();
  try {
    row.owner = processIdentityFromWire(processIdentityToWire(row.owner));
  } catch {
    return invalid();
  }
  if (row.owner.sid !== sid || sameRuntimeBirth(row.oldBirth, row.newBirth))
    return invalid();
  return row;
}

/** One closed backup slot. Neither corrupt bytes nor an uncertain rename are
 * deleted by Node. Deletion requires the separate fixed native repair adapter. */
export class RuntimeRepair {
  private owned: RuntimeRepairRecord | undefined;
  private uncertain = false;
  private cleanupDigest: string | undefined;
  constructor(
    private readonly host: HostContext,
    private readonly assertMutation: (target: PrepareTarget) => Promise<void>,
    private readonly verifyNew: (
      relative: string,
      record: RuntimeRepairRecord,
    ) => Promise<readonly string[]>,
  ) {}
  private path(relative: string) {
    return win32.join(this.host.personalRoot, relative);
  }
  private final(row: RuntimeRepairRecord) {
    return `runtime\\releases\\${row.target}`;
  }
  private async read(): Promise<RuntimeRepairRecord | null> {
    return (await this.readRaw())?.row ?? null;
  }
  private async readRaw(): Promise<{
    row: RuntimeRepairRecord;
    digest: string;
  } | null> {
    const bytes = await this.host.native.vaultRead(
      "account",
      RUNTIME_REPAIR_KEY,
    );
    if (!bytes) return null;
    try {
      if (bytes.length > 8192) return invalid();
      const digest = createHash("sha256").update(bytes).digest("hex");
      const row = parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        this.host.identity.sid,
      );
      return { row, digest };
    } catch {
      return invalid();
    } finally {
      bytes.fill(0);
    }
  }
  async blocksReady(): Promise<boolean> {
    const row = await this.read();
    return row !== null;
  }
  cleanupPending(): boolean {
    return this.uncertain;
  }
  async promotedRecord(): Promise<RuntimeRepairRecord | null> {
    const row = await this.read();
    return row && ["promoted", "activated"].includes(row.phase) ? row : null;
  }
  private async at(relative: string): Promise<RuntimeDirectoryBirth | null> {
    try {
      const info = await lstat(this.path(relative), { bigint: true });
      await this.host.native.validatePath("personal", relative, "directory");
      return runtimeBirth(info, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async exact(relative: string, expected: RuntimeDirectoryBirth) {
    const actual = await this.at(relative);
    if (!actual || !sameRuntimeBirth(actual, expected)) return invalid();
  }
  private async snapshot(
    relative: string,
    expected: RuntimeDirectoryBirth,
    allowed?: ReadonlySet<string>,
  ): Promise<Buffer> {
    await this.exact(relative, expected);
    const entries: RuntimeBackupEntry[] = [];
    let total = 0;
    const visit = async (path: string, local: string, depth: number) => {
      if (allowed && !allowed.has(local.normalize("NFC").toLowerCase()))
        return invalid();
      if (depth > 32 || entries.length >= RUNTIME_BACKUP_ENTRY_MAX)
        return invalid();
      const info = await lstat(this.path(path), { bigint: true }),
        directory = info.isDirectory();
      await this.host.native.validatePath(
        "personal",
        path,
        directory ? "directory" : "file",
      );
      const birth = runtimeBirth(info, directory);
      let bytes: number | null = null,
        sha256: string | null = null;
      if (!directory) {
        if (info.size > BigInt(MAX_UNPACKED_BYTES)) return invalid();
        bytes = Number(info.size);
        total += bytes;
        if (total > MAX_UNPACKED_BYTES) return invalid();
        const checked = await verifyPrivateFile(
          this.host,
          path,
          bytes,
          new AbortController().signal,
        );
        if (
          !sameRuntimeBirth(
            runtimeBirth(await lstat(this.path(path), { bigint: true }), false),
            birth,
          )
        )
          return invalid();
        sha256 = checked.sha256;
      }
      entries.push({
        path: local,
        kind: directory ? "directory" : "file",
        birth,
        bytes,
        sha256,
      });
      if (directory) {
        const names = (await readdir(this.path(path))).sort();
        for (const name of names) {
          try {
            assertConsumerRelativePath(name);
          } catch {
            return invalid();
          }
          if (name.includes("\\") || name.includes("/")) return invalid();
          await visit(
            `${path}\\${name}`,
            local ? `${local}/${name}` : name,
            depth + 1,
          );
        }
        const after = (await readdir(this.path(path))).sort();
        if (JSON.stringify(names) !== JSON.stringify(after)) return invalid();
      }
      if (
        !sameRuntimeBirth(
          runtimeBirth(
            await lstat(this.path(path), { bigint: true }),
            directory,
          ),
          birth,
        )
      )
        return invalid();
    };
    await visit(relative, "", 0);
    await this.exact(relative, expected);
    const bytes = Buffer.from(JSON.stringify({ version: 1, entries }));
    parseRuntimeBackupInventory(bytes);
    return bytes;
  }
  private async oldExact(
    relative: string,
    row: RuntimeRepairRecord,
  ): Promise<void> {
    if (!row.oldTreeDigest) return invalid();
    const sealed = await readPrivateBytes(
      this.host,
      RUNTIME_BACKUP_INVENTORY,
      MAX_INVENTORY_BYTES,
    );
    parseRuntimeBackupInventory(sealed);
    if (createHash("sha256").update(sealed).digest("hex") !== row.oldTreeDigest)
      return invalid();
    const current = await this.snapshot(relative, row.oldBirth);
    if (!current.equals(sealed)) return invalid();
  }
  private async save(row: RuntimeRepairRecord) {
    parse(row, this.host.identity.sid);
    this.owned = row;
    this.uncertain = true;
    await this.host.native.vaultWrite(
      "account",
      RUNTIME_REPAIR_KEY,
      Buffer.from(JSON.stringify(row)),
    );
  }
  private matches(row: RuntimeRepairRecord, bundle: PreparationBundle) {
    if (
      row.target !== bundle.targetIdentity ||
      row.archiveSha256 !== bundle.metadata.release.sha256 ||
      row.releaseVersion !== bundle.metadata.releaseVersion ||
      row.sequence !== bundle.metadata.sequence
    )
      return invalid();
  }
  async recover(bundle: PreparationBundle): Promise<void> {
    const saved = await this.read();
    if (!saved) {
      if (this.uncertain && this.cleanupDigest) {
        await this.cleanupBackup(bundle);
        return;
      }
      if (this.uncertain && this.owned?.phase === "snapshotting") {
        // The first WAL write can fail before commit. Only this same live
        // instance knows no rename/snapshot effect was yet attempted.
        const row = this.owned;
        this.matches(row, bundle);
        await this.assertMutation({
          sid: this.host.identity.sid,
          identity: row.target,
        });
        const current = await this.host.native.processIdentity?.(row.owner.pid);
        if (!current || !sameConsumerProcess(current, row.owner))
          return invalid();
        await this.exact(this.final(row), row.oldBirth);
        await this.exact(RUNTIME_STAGING_PATH, row.newBirth);
        await this.host.native.validatePath(
          "personal",
          RUNTIME_BACKUP_PATH,
          "absent",
        );
        await this.host.native.validatePath(
          "personal",
          RUNTIME_BACKUP_INVENTORY,
          "absent",
        );
        await this.verifyNew(RUNTIME_STAGING_PATH, row);
        await this.save(row);
        await this.advance(row);
        return;
      }
      if (this.uncertain) return invalid();
      return;
    }
    this.matches(saved, bundle);
    if (saved.phase === "activated" || saved.phase === "deleting") {
      await this.cleanupBackup(bundle);
      return;
    }
    await this.assertMutation({
      sid: this.host.identity.sid,
      identity: saved.target,
    });
    // A fully acknowledged promoted record has no copier/rename still running.
    // Earlier phases need exact current-instance ownership or a dead old birth.
    if (
      saved.phase !== "promoted" &&
      (!this.owned || !sameConsumerProcess(this.owned.owner, saved.owner))
    ) {
      if (!this.host.native.processIdentity) return invalid();
      const actual = await this.host.native.processIdentity(saved.owner.pid);
      if (actual && sameConsumerProcess(actual, saved.owner))
        throw new PrepareFailure("BUSY");
    }
    this.owned = saved;
    this.uncertain = true;
    await this.advance(saved);
  }
  async replace(
    bundle: PreparationBundle,
    staged: RuntimeStagingRecord,
    previousManifestSha256: string | null,
  ) {
    if ((await this.read()) || (await this.at(RUNTIME_BACKUP_PATH)))
      throw new PrepareFailure("BUSY");
    await this.host.native.validatePath(
      "personal",
      RUNTIME_BACKUP_INVENTORY,
      "absent",
    );
    await this.assertMutation({
      sid: this.host.identity.sid,
      identity: bundle.targetIdentity,
    });
    if (
      staged.state !== "verified" ||
      !staged.manifestSha256 ||
      staged.target !== bundle.targetIdentity ||
      staged.archiveSha256 !== bundle.metadata.release.sha256
    )
      return invalid();
    const oldBirth = await this.at(
      `runtime\\releases\\${bundle.targetIdentity}`,
    );
    if (!oldBirth || !this.host.native.processIdentity) return invalid();
    const owner = await this.host.native.processIdentity(process.pid);
    if (
      !owner ||
      owner.pid !== process.pid ||
      owner.sid !== this.host.identity.sid ||
      owner.sessionId !== this.host.identity.sessionId
    )
      return invalid();
    await this.save({
      version: 1,
      target: bundle.targetIdentity,
      archiveSha256: bundle.metadata.release.sha256,
      releaseVersion: bundle.metadata.releaseVersion,
      sequence: bundle.metadata.sequence,
      owner,
      oldBirth,
      newBirth: staged.birth,
      oldTreeDigest: null,
      manifestSha256: staged.manifestSha256,
      previousManifestSha256,
      phase: "snapshotting",
    });
    await this.advance(this.owned!);
  }
  private async advance(original: RuntimeRepairRecord) {
    let row = original;
    const canonical = this.final(row);
    const here = await this.at(canonical),
      stage = await this.at(RUNTIME_STAGING_PATH),
      backup = await this.at(RUNTIME_BACKUP_PATH);
    if (
      (here &&
        !sameRuntimeBirth(here, row.oldBirth) &&
        !sameRuntimeBirth(here, row.newBirth)) ||
      (stage && !sameRuntimeBirth(stage, row.newBirth)) ||
      (backup && !sameRuntimeBirth(backup, row.oldBirth)) ||
      (here && sameRuntimeBirth(here, row.oldBirth)
        ? backup !== null
        : backup === null) ||
      (here && sameRuntimeBirth(here, row.newBirth)
        ? stage !== null
        : stage === null)
    )
      return invalid();
    if (row.phase === "snapshotting") {
      await this.exact(canonical, row.oldBirth);
      await this.exact(RUNTIME_STAGING_PATH, row.newBirth);
      const signedPaths = await this.verifyNew(RUNTIME_STAGING_PATH, row);
      const allowed = new Set([
        "",
        ...signedPaths.map((path) => path.normalize("NFC").toLowerCase()),
      ]);
      const bytes = await this.snapshot(canonical, row.oldBirth, allowed);
      await writePrivateAtomic(this.host, RUNTIME_BACKUP_INVENTORY, bytes);
      row = {
        ...row,
        oldTreeDigest: createHash("sha256").update(bytes).digest("hex"),
        phase: "quarantining",
      };
      await this.save(row);
    }
    const newRelative =
      here && sameRuntimeBirth(here, row.newBirth)
        ? canonical
        : RUNTIME_STAGING_PATH;
    await this.verifyNew(newRelative, row);
    if (here && sameRuntimeBirth(here, row.oldBirth)) {
      await this.oldExact(canonical, row);
      await this.assertMutation({
        sid: this.host.identity.sid,
        identity: row.target,
      });
      await this.save({ ...row, phase: "quarantining" });
      await this.host.native.validatePath(
        "personal",
        RUNTIME_BACKUP_PATH,
        "absent",
      );
      await this.exact(canonical, row.oldBirth);
      await rename(this.path(canonical), this.path(RUNTIME_BACKUP_PATH));
    }
    await this.oldExact(RUNTIME_BACKUP_PATH, row);
    if (stage) {
      row = { ...row, phase: "promoting" };
      await this.save(row);
      await this.assertMutation({
        sid: this.host.identity.sid,
        identity: row.target,
      });
      await this.verifyNew(RUNTIME_STAGING_PATH, row);
      await this.exact(RUNTIME_STAGING_PATH, row.newBirth);
      await this.host.native.validatePath("personal", canonical, "absent");
      await rename(this.path(RUNTIME_STAGING_PATH), this.path(canonical));
    }
    await this.exact(canonical, row.newBirth);
    await this.verifyNew(canonical, row);
    row = { ...row, phase: "promoted" };
    await this.save(row);
    this.uncertain = false;
  }
  async activated(bundle: PreparationBundle): Promise<void> {
    const row = await this.read();
    if (!row) return;
    this.matches(row, bundle);
    if (row.phase === "activated" || row.phase === "deleting") return;
    if (row.phase !== "promoted") return invalid();
    await this.assertMutation({
      sid: this.host.identity.sid,
      identity: row.target,
    });
    await this.exact(this.final(row), row.newBirth);
    await this.verifyNew(this.final(row), row);
    await this.save({ ...row, phase: "activated" });
    this.uncertain = false;
  }
  /** Native's protected completion certificate, never path absence alone,
   * acknowledges the fixed backup's removal and any lost reply. */
  async cleanupBackup(bundle: PreparationBundle): Promise<void> {
    const raw = await this.readRaw(),
      row = raw?.row ?? this.owned;
    if (!raw && !this.cleanupDigest) return;
    if (!row || !["activated", "deleting"].includes(row.phase))
      return invalid();
    this.matches(row, bundle);
    const digest = raw?.digest ?? this.cleanupDigest;
    if (!digest || !this.host.native.removeRuntimeRepairBackup)
      return invalid();
    await this.assertMutation({
      sid: this.host.identity.sid,
      identity: row.target,
    });
    this.owned = row;
    this.cleanupDigest = digest;
    this.uncertain = true;
    const result = await this.host.native.removeRuntimeRepairBackup(
      row.target,
      digest,
    );
    if (result.state !== "completed") throw new PrepareFailure("BUSY");
    await this.assertMutation({
      sid: this.host.identity.sid,
      identity: row.target,
    });
    if (await this.read()) return invalid();
    await this.host.native.validatePath(
      "personal",
      RUNTIME_BACKUP_PATH,
      "absent",
    );
    await this.host.native.validatePath(
      "personal",
      RUNTIME_BACKUP_INVENTORY,
      "absent",
    );
    this.uncertain = false;
    this.owned = undefined;
    this.cleanupDigest = undefined;
  }
  /** No old bytes changed, no sidecar/temporary exists, and this exact current
   * writer has stopped. Unknown slots or effects after quarantine remain held. */
  async cancelBeforeEffects(): Promise<boolean> {
    const row = this.owned;
    if (!row || row.phase !== "snapshotting") return false;
    const saved = await this.read();
    if (
      saved &&
      (saved.phase !== "snapshotting" ||
        JSON.stringify(saved) !== JSON.stringify(row))
    )
      return invalid();
    await this.assertMutation({
      sid: this.host.identity.sid,
      identity: row.target,
    });
    const owner = await this.host.native.processIdentity?.(row.owner.pid);
    if (!owner || !sameConsumerProcess(owner, row.owner)) return invalid();
    await this.exact(this.final(row), row.oldBirth);
    await this.exact(RUNTIME_STAGING_PATH, row.newBirth);
    for (const relative of [
      RUNTIME_BACKUP_PATH,
      RUNTIME_BACKUP_INVENTORY,
      `${RUNTIME_BACKUP_INVENTORY}.atomic.lock`,
      `${RUNTIME_BACKUP_INVENTORY}.atomic.tmp`,
    ])
      await this.host.native.validatePath("personal", relative, "absent");
    await this.host.native.vaultDelete("account", RUNTIME_REPAIR_KEY);
    this.uncertain = false;
    this.owned = undefined;
    return true;
  }
}
