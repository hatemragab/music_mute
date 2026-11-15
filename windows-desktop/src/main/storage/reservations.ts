import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
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
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
export interface VoiceReservation {
  id: string;
  bytes: number;
  relativePath: string;
  owner: ConsumerProcessIdentity;
  createdAt: number;
}
const FILE = "storage\\reservations.json";
export class WindowsVoiceReservations {
  constructor(
    private readonly host: HostContext,
    private readonly processIdentity: (
      pid: number,
    ) => Promise<ConsumerProcessIdentity | null>,
  ) {}
  async readOwned(): Promise<VoiceReservation[]> {
    try {
      await lstat(win32.join(this.host.personalRoot, FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const value = JSON.parse(
      (await readPrivateBytes(this.host, FILE, 256 * 1024)).toString("utf8"),
    ) as { version: number; reservations: VoiceReservation[] };
    if (
      !value ||
      Object.keys(value).sort().join() !== "reservations,version" ||
      value.version !== 1 ||
      !Array.isArray(value.reservations) ||
      value.reservations.length > 128
    )
      throw new Error("STORAGE_RESERVATIONS_INVALID");
    const live: VoiceReservation[] = [];
    for (const row of value.reservations) {
      if (
        !row ||
        Object.keys(row).sort().join() !==
          "bytes,createdAt,id,owner,relativePath" ||
        !/^[a-f0-9-]{36}$/u.test(row.id) ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 1 ||
        row.bytes > 100000000 ||
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0
      )
        throw new Error("STORAGE_RESERVATIONS_INVALID");
      assertConsumerRelativePath(row.relativePath);
      row.owner = processIdentityFromWire(processIdentityToWire(row.owner));
      if (row.owner.sid !== this.host.identity.sid)
        throw new Error("STORAGE_RESERVATIONS_INVALID");
      try {
        const current = await this.processIdentity(row.owner.pid);
        if (current && sameConsumerProcess(current, row.owner)) live.push(row);
      } catch {
        live.push(row);
      }
    }
    return live;
  }
  async writeOwned(reservations: VoiceReservation[]): Promise<void> {
    await writePrivateAtomic(
      this.host,
      FILE,
      Buffer.from(JSON.stringify({ version: 1, reservations })),
    );
  }
  async createOwned(
    bytes: number,
    relativePath: string,
    current: VoiceReservation[],
  ): Promise<VoiceReservation> {
    if (current.length >= 128) throw new Error("STORAGE_RESERVATION_LIMIT");
    const owner = await this.processIdentity(process.pid);
    if (
      !owner ||
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
    };
    await this.writeOwned([...current, row]);
    return row;
  }
}
