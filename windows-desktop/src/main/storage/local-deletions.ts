import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
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
import type { LibraryPartition } from "../library/store.js";
import { parsePersonalPair } from "../reuse/pair.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
const FILE = "storage\\deletions.json",
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface LocalDeletion {
  id: string;
  jobId: string;
  owner: ConsumerProcessIdentity;
  settled: boolean;
  pairSha256: string;
  originalSha256: string;
  vocalsSha256: string;
  directory: { device: string; fileId: string; bornAt: string };
}
export class WindowsLocalDeletionJournal {
  constructor(
    private readonly host: HostContext,
    private readonly processIdentity: (
      pid: number,
    ) => Promise<ConsumerProcessIdentity | null>,
  ) {}
  canonical(row: LocalDeletion) {
    return `personal\\results\\${row.jobId}`;
  }
  tombstone(row: LocalDeletion) {
    return `${this.canonical(row)}.${row.id}.deleted`;
  }
  private async exists(relative: string) {
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async directory(relative: string) {
    await this.host.native.validatePath("personal", relative, "directory");
    const stat = await lstat(win32.join(this.host.personalRoot, relative), {
      bigint: true,
    });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n)
      throw new Error("LIBRARY_DELETE_INVALID");
    return {
      device: String(stat.dev),
      fileId: String(stat.ino),
      bornAt: String(stat.birthtimeNs),
    };
  }
  async readOwned(): Promise<LocalDeletion[]> {
    if (!(await this.exists(FILE))) return [];
    const value = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readPrivateBytes(this.host, FILE, 128 * 1024),
      ),
      128 * 1024,
      16384,
    ) as { version: number; deletions: LocalDeletion[] };
    if (
      !value ||
      Object.keys(value).sort().join() !== "deletions,version" ||
      value.version !== 1 ||
      !Array.isArray(value.deletions) ||
      value.deletions.length > 128
    )
      throw new Error("LIBRARY_DELETE_INVALID");
    const jobs = new Set<string>();
    for (const row of value.deletions) {
      if (
        !row ||
        Object.keys(row).sort().join() !==
          "directory,id,jobId,originalSha256,owner,pairSha256,settled,vocalsSha256" ||
        !UUID.test(row.id) ||
        !UUID.test(row.jobId) ||
        jobs.has(row.jobId) ||
        typeof row.settled !== "boolean" ||
        ![row.pairSha256, row.originalSha256, row.vocalsSha256].every((sha) =>
          /^[a-f0-9]{64}$/u.test(sha),
        ) ||
        !row.directory ||
        Object.keys(row.directory).sort().join() !== "bornAt,device,fileId" ||
        ![
          row.directory.device,
          row.directory.fileId,
          row.directory.bornAt,
        ].every((v) => /^\d{1,30}$/u.test(v)) ||
        row.directory.fileId === "0"
      )
        throw new Error("LIBRARY_DELETE_INVALID");
      row.owner = processIdentityFromWire(processIdentityToWire(row.owner));
      if (row.owner.sid !== this.host.identity.sid)
        throw new Error("LIBRARY_DELETE_INVALID");
      jobs.add(row.jobId);
    }
    return value.deletions;
  }
  private writeOwned(deletions: LocalDeletion[]) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, deletions }));
    if (bytes.length > 128 * 1024) throw new Error("LIBRARY_DELETE_LIMIT");
    return writePrivateAtomic(this.host, FILE, bytes);
  }
  async beginOwned(
    jobId: string,
    originalSha256: string,
    vocalsSha256: string,
  ): Promise<LocalDeletion> {
    if (!UUID.test(jobId)) throw new Error("LIBRARY_DELETE_INVALID");
    const rows = await this.readOwned();
    if (rows.length >= 128 || rows.some((row) => row.jobId === jobId))
      throw new Error("LIBRARY_DELETE_PENDING");
    const relative = `personal\\results\\${jobId}`,
      bytes = await readPrivateBytes(
        this.host,
        `${relative}\\pair.json`,
        16384,
      ),
      pair = parsePersonalPair(
        JSON.parse(bytes.toString("utf8")),
        this.host.report.installationId,
        jobId,
      );
    if (
      pair.entry.original.sha256 !== originalSha256 ||
      pair.entry.vocals.sha256 !== vocalsSha256
    )
      throw new Error("LIBRARY_DELETE_CHANGED");
    const owner = await this.processIdentity(process.pid);
    if (
      !owner ||
      owner.pid !== process.pid ||
      owner.sid !== this.host.identity.sid ||
      owner.sessionId !== this.host.identity.sessionId
    )
      throw new Error("LIBRARY_DELETE_INVALID");
    const row = {
      id: randomUUID(),
      jobId,
      owner,
      settled: false,
      pairSha256: createHash("sha256").update(bytes).digest("hex"),
      originalSha256,
      vocalsSha256,
      directory: await this.directory(relative),
    };
    await this.writeOwned([...rows, row]);
    return row;
  }
  async settleOwned(expected: LocalDeletion): Promise<void> {
    const rows = await this.readOwned(),
      row = rows.find((row) => row.id === expected.id);
    if (!row || !sameConsumerProcess(row.owner, expected.owner))
      throw new Error("LIBRARY_DELETE_CHANGED");
    row.settled = true;
    await this.writeOwned(rows);
  }
  async finishOwned(expected: LocalDeletion): Promise<void> {
    await this.writeOwned(
      (await this.readOwned()).filter((row) => row.id !== expected.id),
    );
  }
  /** Cache mutex and all consumer/outbox pins are held/rechecked by the caller throughout reconciliation. */
  async recoverOwned(
    guest: LibraryPartition,
    assertUnpinned: (relative: string) => void,
    removeTree: (
      relative: string,
      birth?: LocalDeletion["directory"],
    ) => Promise<void>,
  ): Promise<{ restored: number; removed: number; deferred: number }> {
    const rows = await this.readOwned(),
      keep: LocalDeletion[] = [];
    let restored = 0,
      removed = 0,
      deferred = 0;
    for (const row of rows) {
      let eligible = row.settled;
      try {
        if (!eligible) {
          const owner = await this.processIdentity(row.owner.pid);
          eligible = !owner || !sameConsumerProcess(owner, row.owner);
        }
      } catch {
        /* Uncertain owner remains protected. */
      }
      if (!eligible) {
        keep.push(row);
        deferred++;
        continue;
      }
      const canonical = this.canonical(row),
        tombstone = this.tombstone(row),
        hasCanonical = await this.exists(canonical),
        hasTombstone = await this.exists(tombstone);
      try {
        assertUnpinned(canonical);
        assertUnpinned(tombstone);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "LIBRARY_MEDIA_PINNED"
        ) {
          keep.push(row);
          deferred++;
          continue;
        }
        throw error;
      }
      const entry = guest.entries.find(
        (entry) => entry.personalJobId === row.jobId,
      );
      if (
        entry &&
        (entry.original.sha256 !== row.originalSha256 ||
          entry.vocals.sha256 !== row.vocalsSha256)
      )
        throw new Error("LIBRARY_DELETE_CHANGED");
      if (!hasTombstone) {
        if (
          (entry && !hasCanonical) ||
          (hasCanonical &&
            (!entry ||
              JSON.stringify(await this.directory(canonical)) !==
                JSON.stringify(row.directory)))
        )
          throw new Error("LIBRARY_DELETE_CHANGED");
        if (!entry && !hasCanonical) {
          try {
            await removeTree(tombstone, row.directory);
            removed++;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "LIBRARY_DELETE_PENDING"
            ) {
              keep.push(row);
              deferred++;
              continue;
            }
            throw error;
          }
        }
        continue;
      }
      if (
        hasCanonical ||
        JSON.stringify(await this.directory(tombstone)) !==
          JSON.stringify(row.directory)
      )
        throw new Error("LIBRARY_DELETE_CHANGED");
      if (entry) {
        const bytes = await readPrivateBytes(
          this.host,
          `${tombstone}\\pair.json`,
          16384,
        );
        if (createHash("sha256").update(bytes).digest("hex") !== row.pairSha256)
          throw new Error("LIBRARY_DELETE_CHANGED");
        parsePersonalPair(
          JSON.parse(bytes.toString("utf8")),
          this.host.report.installationId,
          row.jobId,
        );
        await this.host.native.validatePath("personal", canonical, "absent");
        if (!this.host.native.moveLocalLibraryDeletion)
          throw new Error("LIBRARY_DELETE_PENDING");
        await this.host.native.moveLocalLibraryDeletion(row.id, "restore");
        restored++;
      } else {
        try {
          await removeTree(tombstone, row.directory);
          removed++;
        } catch (error) {
          if (
            (error instanceof Error &&
              error.message === "LIBRARY_DELETE_PENDING") ||
            ["EBUSY", "EPERM", "EACCES"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            keep.push(row);
            deferred++;
            continue;
          }
          throw error;
        }
      }
    }
    await this.writeOwned(keep);
    return { restored, removed, deferred };
  }
}
