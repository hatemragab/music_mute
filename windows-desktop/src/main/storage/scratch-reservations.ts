import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import type {
  ConsumerOwnedProcess,
  ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { sameConsumerProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { HostContext } from "../host-context.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import { parseWorkspace } from "./inventory.js";
import {
  isStoreCpuOwner,
  assertStoreCpuOwnerHost,
  storeCpuOwnerExpectation,
  storeCpuOwnerRetired,
  type StoreCpuOwner,
} from "../session/store-cpu-owner.js";
import {
  parseStoreCpuOperationExpectation,
  type StoreCpuOperationExpectation,
} from "../../../../worker/src/platform/windows/consumer-store-cpu.js";
export const CPU_SCRATCH_MAX_BYTES = 512 * 1024 ** 2,
  CPU_SCRATCH_MAX_ENTRIES = 64;
const FILE = "storage\\scratch-reservations.json",
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface ScratchReservation {
  id: string;
  bytes: number;
  relativePath: string;
  owner: ConsumerProcessIdentity;
  createdAt: number;
  nativePending: boolean;
  nativeOwner?: ConsumerOwnedProcess;
  storeCpuOwner?: StoreCpuOperationExpectation;
}
export interface ScratchReservationLease {
  handoff(): Promise<void>;
  bind(owner: ConsumerOwnedProcess | StoreCpuOwner): Promise<void>;
  release(): Promise<void>;
}
export class WindowsScratchReservations {
  private readonly storeOwners = new Map<string, StoreCpuOwner>();
  constructor(
    private readonly host: HostContext,
    private readonly processIdentity: (
      pid: number,
    ) => Promise<ConsumerProcessIdentity | null>,
    private readonly treeExited: (
      owner: ConsumerOwnedProcess,
    ) => Promise<boolean>,
  ) {}
  private async exists(relative: string) {
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private write(rows: ScratchReservation[]) {
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, reservations: rows }),
    );
    if (bytes.length > 65536) throw new Error("STORAGE_SCRATCH_INVALID");
    return writePrivateAtomic(this.host, FILE, bytes);
  }
  async readOwned(): Promise<ScratchReservation[]> {
    if (!(await this.exists(FILE))) return [];
    const value = JSON.parse(
      (await readPrivateBytes(this.host, FILE, 65536)).toString("utf8"),
    ) as { version: number; reservations: ScratchReservation[] };
    if (
      !value ||
      Object.keys(value).sort().join() !== "reservations,version" ||
      value.version !== 1 ||
      !Array.isArray(value.reservations) ||
      value.reservations.length > CPU_SCRATCH_MAX_ENTRIES
    )
      throw new Error("STORAGE_SCRATCH_INVALID");
    const paths = new Set<string>(),
      ids = new Set<string>();
    let total = 0;
    for (const row of value.reservations) {
      if (
        !row ||
        Object.keys(row).sort().join() !==
          [
            "bytes",
            "createdAt",
            "id",
            "nativePending",
            "owner",
            "relativePath",
            ...(row.nativeOwner ? ["nativeOwner"] : []),
            ...(row.storeCpuOwner ? ["storeCpuOwner"] : []),
          ]
            .sort()
            .join() ||
        !UUID.test(row.id) ||
        ids.has(row.id) ||
        paths.has(row.relativePath) ||
        !/^(?:cloud|prepare)\\work\\[a-f0-9-]{36}$/u.test(row.relativePath) ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 1 ||
        row.bytes > CPU_SCRATCH_MAX_BYTES ||
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0 ||
        typeof row.nativePending !== "boolean"
      )
        throw new Error("STORAGE_SCRATCH_INVALID");
      row.owner = processIdentityFromWire(processIdentityToWire(row.owner));
      if (row.owner.sid !== this.host.identity.sid)
        throw new Error("STORAGE_SCRATCH_INVALID");
      if (row.nativeOwner) {
        if (row.storeCpuOwner) throw new Error("STORAGE_SCRATCH_INVALID");
        if (!row.nativePending) throw new Error("STORAGE_SCRATCH_INVALID");
        row.nativeOwner = parseWorkspace(
          {
            version: 1,
            relativePath: row.relativePath,
            owner: row.nativeOwner,
            purpose: "processing",
            createdAt: row.createdAt,
          },
          this.host.identity.sid,
        ).owner;
        if (
          row.nativeOwner.role !== "prepare" ||
          row.nativeOwner.identity.sessionId !== row.owner.sessionId
        )
          throw new Error("STORAGE_SCRATCH_INVALID");
      }
      if (row.storeCpuOwner) {
        row.storeCpuOwner = parseStoreCpuOperationExpectation(
          row.storeCpuOwner,
        );
        const owner = row.storeCpuOwner;
        if (
          !row.nativePending ||
          owner.nodeOwner.identity.sid !== this.host.identity.sid ||
          owner.nodeOwner.identity.sessionId !== row.owner.sessionId ||
          row.relativePath !==
            `${owner.operation === "silence_analyze" ? "prepare" : "cloud"}\\work\\${owner.requestId}`
        )
          throw new Error("STORAGE_SCRATCH_INVALID");
      }
      ids.add(row.id);
      paths.add(row.relativePath);
      total += row.bytes;
    }
    if (total > CPU_SCRATCH_MAX_BYTES)
      throw new Error("STORAGE_SCRATCH_INVALID");
    return value.reservations;
  }
  async pruneOwned(): Promise<void> {
    const keep: ScratchReservation[] = [];
    for (const row of await this.readOwned()) {
      if (await this.exists(row.relativePath)) {
        keep.push(row);
        continue;
      }
      try {
        if (row.nativePending) {
          if (!(await this.retired(row))) {
            keep.push(row);
            continue;
          }
        } else {
          const live = await this.processIdentity(row.owner.pid);
          if (live && sameConsumerProcess(live, row.owner)) {
            keep.push(row);
            continue;
          }
        }
      } catch {
        keep.push(row);
      }
    }
    await this.write(keep);
  }
  private async retired(row: ScratchReservation): Promise<boolean> {
    if (row.storeCpuOwner) {
      const original = this.storeOwners.get(row.id);
      if (original) return storeCpuOwnerRetired(original);
      if (!this.host.native.inspectStoreCpuOperation)
        throw new Error("STORAGE_RECOVERY_PENDING");
      const retired = await this.host.native.inspectStoreCpuOperation(
        row.storeCpuOwner,
      );
      if (typeof retired !== "boolean")
        throw new Error("STORAGE_RECOVERY_PENDING");
      return retired;
    }
    return !!row.nativeOwner && this.treeExited(row.nativeOwner);
  }
  async createOwned(
    bytes: number,
    relativePath: string,
  ): Promise<ScratchReservation> {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > CPU_SCRATCH_MAX_BYTES ||
      !/^(?:cloud|prepare)\\work\\[a-f0-9-]{36}$/u.test(relativePath)
    )
      throw new Error("STORAGE_SCRATCH_INVALID");
    await this.pruneOwned();
    const rows = await this.readOwned();
    if (
      rows.length >= CPU_SCRATCH_MAX_ENTRIES ||
      rows.some((row) => row.relativePath === relativePath) ||
      rows.reduce((sum, row) => sum + row.bytes, 0) + bytes >
        CPU_SCRATCH_MAX_BYTES
    )
      throw new Error("STORAGE_SCRATCH_FULL");
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
      bytes,
      relativePath,
      owner,
      createdAt: Date.now(),
      nativePending: false,
    };
    await this.write([...rows, row]);
    return row;
  }
  async mutateOwned(
    expected: ScratchReservation,
    action: "handoff" | "bind" | "release",
    owner?: ConsumerOwnedProcess | StoreCpuOwner,
  ): Promise<void> {
    const rows = await this.readOwned(),
      row = rows.find((row) => row.id === expected.id);
    if (
      !row ||
      row.relativePath !== expected.relativePath ||
      !sameConsumerProcess(row.owner, expected.owner)
    )
      throw new Error("STORAGE_SCRATCH_CHANGED");
    if (action === "release") {
      if (await this.exists(row.relativePath))
        throw new Error("STORAGE_RECOVERY_PENDING");
      if (row.nativePending && !(await this.retired(row)))
        throw new Error("STORAGE_RECOVERY_PENDING");
      rows.splice(rows.indexOf(row), 1);
      this.storeOwners.delete(row.id);
    } else if (action === "handoff") {
      if ((row.nativeOwner || row.storeCpuOwner) && !(await this.retired(row)))
        throw new Error("STORAGE_RECOVERY_PENDING");
      row.nativePending = true;
      delete row.nativeOwner;
      delete row.storeCpuOwner;
      this.storeOwners.delete(row.id);
    } else {
      if (isStoreCpuOwner(owner)) {
        assertStoreCpuOwnerHost(owner, this.host);
        const expectation = storeCpuOwnerExpectation(owner);
        if (
          !row.nativePending ||
          row.nativeOwner ||
          expectation.nodeOwner.identity.sessionId !== row.owner.sessionId ||
          row.relativePath !==
            `${expectation.operation === "silence_analyze" ? "prepare" : "cloud"}\\work\\${expectation.requestId}` ||
          (row.storeCpuOwner &&
            JSON.stringify(row.storeCpuOwner) !== JSON.stringify(expectation))
        )
          throw new Error("STORAGE_SCRATCH_CHANGED");
        row.storeCpuOwner = expectation;
        this.storeOwners.set(row.id, owner);
        await this.write(rows);
        return;
      }
      if (
        !row.nativePending ||
        !owner ||
        owner.role !== "prepare" ||
        owner.identity.sessionId !== row.owner.sessionId
      )
        throw new Error("STORAGE_SCRATCH_CHANGED");
      row.nativeOwner = parseWorkspace(
        {
          version: 1,
          relativePath: row.relativePath,
          owner,
          purpose: "processing",
          createdAt: row.createdAt,
        },
        this.host.identity.sid,
      ).owner;
    }
    await this.write(rows);
  }
}
