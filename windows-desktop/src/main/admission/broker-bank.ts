import { createHash } from "node:crypto";
import {
  processIdentityToWire,
  type ConsumerOwnedProcess,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { parseDirectmlGpuIdentity } from "../../../../worker/src/enrollment/report-builder.js";
import type { GpuPersistentState } from "./gpu-broker.js";

const INDEX = "gpu_broker_index",
  LEGACY = "gpu_broker_state";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const LUID = /^[a-f0-9]{16}$/u,
  SHA = /^[a-f0-9]{64}$/u;
type Native = Pick<
  WindowsConsumerNative,
  "vaultRead" | "vaultWrite" | "vaultDelete" | "ownedTreeExited"
>;
type Retirement = { digest: string; owner: ConsumerOwnedProcess | null };
type Entry = {
  luid: string;
  phase: "opening" | "ready" | "retiring";
  retirement: Retirement | null;
};
interface Index {
  version: 1;
  sid: string;
  entries: Entry[];
  legacy: Retirement | null;
}
const key = (luid: string) => `gpu_broker_${luid}`;
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function invalid(): never {
  throw new Error("RESERVATION_INVALID");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function owner(value: unknown): ConsumerOwnedProcess {
  const row = object(value);
  if (
    Object.keys(row).sort().join() !== "identity,nonce,role" ||
    !["personal", "fleet"].includes(
      typeof row.role === "string" ? row.role : "",
    ) ||
    typeof row.nonce !== "string" ||
    !SHA.test(row.nonce)
  )
    return invalid();
  processIdentityToWire(
    object(row.identity) as unknown as ConsumerOwnedProcess["identity"],
  );
  return row as unknown as ConsumerOwnedProcess;
}
/** Strict historical data can identify an old tree; it is never a new permit. */
export function parseStoredGpuState(
  bytes: Buffer,
  sid: string,
): GpuPersistentState {
  if (bytes.length > 16384) return invalid();
  const row = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    Object.keys(row).sort().join() !== "active,gpuLuid,sid,version" ||
    row.version !== 1 ||
    row.sid !== sid ||
    typeof row.gpuLuid !== "string" ||
    !LUID.test(row.gpuLuid)
  )
    return invalid();
  if (row.active !== null) {
    const active = object(row.active),
      request = object(active.request),
      roleOwner = owner(request.owner);
    if (
      Object.keys(active).sort().join() !== "nonce,request" ||
      Object.keys(request).sort().join() !==
        "generation,gpu,kind,owner,peer,requestId" ||
      typeof active.nonce !== "string" ||
      !SHA.test(active.nonce) ||
      typeof request.requestId !== "string" ||
      !UUID.test(request.requestId) ||
      typeof request.generation !== "string" ||
      !UUID.test(request.generation) ||
      request.kind !== roleOwner.role ||
      roleOwner.identity.sid !== sid
    )
      return invalid();
    const peer = object(request.peer);
    processIdentityToWire(peer as unknown as ConsumerOwnedProcess["identity"]);
    if (
      peer.sid !== sid ||
      parseDirectmlGpuIdentity(request.gpu).luid !== row.gpuLuid
    )
      return invalid();
  }
  return row as unknown as GpuPersistentState;
}
function retirement(value: unknown, sid: string): Retirement {
  const row = object(value);
  if (
    Object.keys(row).sort().join() !== "digest,owner" ||
    typeof row.digest !== "string" ||
    !SHA.test(row.digest)
  )
    return invalid();
  const previous = row.owner === null ? null : owner(row.owner);
  if (previous && previous.identity.sid !== sid) return invalid();
  return { digest: row.digest, owner: previous };
}
function parseIndex(bytes: Buffer | null, sid: string): Index {
  if (!bytes) return { version: 1, sid, entries: [], legacy: null };
  if (bytes.length > 32768) return invalid();
  const row = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (
    Object.keys(row).sort().join() !== "entries,legacy,sid,version" ||
    row.version !== 1 ||
    row.sid !== sid ||
    !Array.isArray(row.entries) ||
    row.entries.length > 16
  )
    return invalid();
  const entries: Entry[] = row.entries.map((value) => {
    const entry = object(value);
    if (
      Object.keys(entry).sort().join() !== "luid,phase,retirement" ||
      typeof entry.luid !== "string" ||
      !LUID.test(entry.luid) ||
      !["opening", "ready", "retiring"].includes(
        typeof entry.phase === "string" ? entry.phase : "",
      ) ||
      (entry.phase === "retiring") !== (entry.retirement !== null)
    )
      return invalid();
    return {
      luid: entry.luid,
      phase: entry.phase as Entry["phase"],
      retirement:
        entry.retirement === null ? null : retirement(entry.retirement, sid),
    };
  });
  if (new Set(entries.map((entry) => entry.luid)).size !== entries.length)
    return invalid();
  return {
    version: 1,
    sid,
    entries,
    legacy: row.legacy === null ? null : retirement(row.legacy, sid),
  };
}
/** At most16 fixed GPU slots plus one legacy slot. The caller holds the actual
 * SID session authority. Before-effect and retirement states survive lost ACKs;
 * absent ready data or unknown old tree proof never means free capacity. */
export class GpuBrokerBank {
  private index: Index | undefined;
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly native: Native,
    private readonly sid: string,
  ) {}
  private async persist() {
    const bytes = Buffer.from(JSON.stringify(this.index));
    if (bytes.length > 32768) return invalid();
    await this.native.vaultWrite("fleet", INDEX, bytes);
  }
  private async prove(previous: Retirement) {
    if (previous.owner && !(await this.native.ownedTreeExited(previous.owner)))
      throw new Error("GPU_CHILDREN_STILL_ACTIVE");
  }
  private async remove(slot: string, previous: Retirement) {
    await this.prove(previous);
    const raw = await this.native.vaultRead("fleet", slot);
    if (raw && hash(raw) !== previous.digest) return invalid();
    if (raw) await this.native.vaultDelete("fleet", slot);
    if (await this.native.vaultRead("fleet", slot)) return invalid();
  }
  async start() {
    if (this.initialized) return;
    this.index = parseIndex(
      await this.native.vaultRead("fleet", INDEX),
      this.sid,
    );
    const legacy = await this.native.vaultRead("fleet", LEGACY);
    if (!this.index.legacy && legacy) {
      const state = parseStoredGpuState(legacy, this.sid),
        previous = {
          digest: hash(legacy),
          owner: state.active?.request.owner ?? null,
        };
      await this.prove(previous);
      this.index.legacy = previous;
      await this.persist();
    }
    if (this.index.legacy) {
      await this.remove(LEGACY, this.index.legacy);
      this.index.legacy = null;
      await this.persist();
    }
    for (const entry of Array.from(this.index.entries)) {
      const raw = await this.native.vaultRead("fleet", key(entry.luid));
      if (entry.phase !== "retiring") {
        if (!raw && entry.phase !== "opening") return invalid();
        if (raw) {
          const state = parseStoredGpuState(raw, this.sid);
          if (
            state.gpuLuid !== entry.luid ||
            (entry.phase === "opening" && state.active)
          )
            return invalid();
          entry.retirement = {
            digest: hash(raw),
            owner: state.active?.request.owner ?? null,
          };
          await this.prove(entry.retirement);
          entry.phase = "retiring";
          await this.persist();
        }
      }
      if (entry.retirement)
        await this.remove(key(entry.luid), entry.retirement);
      this.index.entries.splice(this.index.entries.indexOf(entry), 1);
      await this.persist();
    }
    this.initialized = true;
  }
  open<T>(luid: string, create: (stateKey: string) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.start();
      if (!LUID.test(luid) || this.index!.entries.length >= 16)
        throw new Error("GPU_BUSY");
      const entry: Entry = { luid, phase: "opening", retirement: null };
      if (this.index!.entries.some((row) => row.luid === luid))
        return invalid();
      this.index!.entries.push(entry);
      await this.persist();
      const value = await create(key(luid));
      entry.phase = "ready";
      await this.persist();
      return value;
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
