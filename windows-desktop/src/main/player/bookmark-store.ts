import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import type { ConsumerMutexLease } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { HostContext } from "../host-context.js";
import type { BookmarkStore } from "./listening.js";
import { TRACK_ID } from "../../shared/playback-contracts.js";

const VALUE_LIMIT = 16384;
const RECORD_LIMIT = 65536;
const PARTS_LIMIT = 4;
const queues = new WeakMap<object, Promise<void>>();
interface Manifest {
  version: 2;
  kind: "bookmark-parts";
  generation: string;
  slot: 0 | 1;
  bytes: number;
  sha256: string;
  parts: { bytes: number; sha256: string }[];
}
interface Snapshot {
  head: Buffer | null;
  manifest: Manifest | null;
  parts: (Buffer | null)[];
  complete: boolean;
  valid: boolean;
  quarantined: boolean;
}
function unavailable(): never {
  throw new Error("PREFERENCES_UNAVAILABLE");
}
const sha = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown =>
  parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const equal = (a: Buffer | null, b: Buffer | null): boolean =>
  a === null ? b === null : b !== null && a.equals(b);
function parseManifest(raw: unknown): Manifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.kind !== "bookmark-parts") return null; // Existing v1 JSON remains readable.
  if (
    Object.keys(row).sort().join() !==
      "bytes,generation,kind,parts,sha256,slot,version" ||
    row.version !== 2 ||
    (row.slot !== 0 && row.slot !== 1) ||
    typeof row.generation !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      row.generation,
    ) ||
    !Number.isInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > RECORD_LIMIT ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256) ||
    !Array.isArray(row.parts) ||
    row.parts.length !== Math.ceil((row.bytes as number) / VALUE_LIMIT) ||
    row.parts.length > PARTS_LIMIT
  )
    unavailable();
  let bytes = 0;
  for (const [index, part] of row.parts.entries()) {
    if (!part || typeof part !== "object" || Array.isArray(part)) unavailable();
    const p = part as Record<string, unknown>;
    const expected = Math.min(
      VALUE_LIMIT,
      (row.bytes as number) - index * VALUE_LIMIT,
    );
    if (
      Object.keys(p).sort().join() !== "bytes,sha256" ||
      p.bytes !== expected ||
      typeof p.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(p.sha256)
    )
      unavailable();
    bytes += expected;
  }
  if (bytes !== row.bytes) unavailable();
  return raw as Manifest;
}

/** Current-user DPAPI chunks; the atomic head commits at most 64 KiB in two fixed slots. */
export class WindowsBookmarkStore implements BookmarkStore {
  private readonly observed = new Map<string, Snapshot>();
  private releasePending: ConsumerMutexLease | undefined;
  constructor(
    private readonly host: {
      identity: Pick<HostContext["identity"], "sid">;
      report: Pick<HostContext["report"], "installationId">;
      native: Pick<
        HostContext["native"],
        | "vaultRead"
        | "vaultWrite"
        | "vaultDelete"
        | "acquireMutex"
        | "releaseMutex"
      >;
    },
  ) {}
  private digest(owner: string, trackId: string): string {
    if (
      owner.length < 1 ||
      owner.length > 256 ||
      /[\p{Cc}\p{Cf}]/u.test(owner) ||
      !TRACK_ID.test(trackId)
    )
      unavailable();
    return sha(
      Buffer.from(
        JSON.stringify([
          this.host.identity.sid,
          this.host.report.installationId,
          owner,
          trackId,
        ]),
      ),
    ).slice(0, 58);
  }
  private remember(digest: string, snapshot: Snapshot): void {
    this.observed.delete(digest);
    this.observed.set(digest, snapshot);
    while (this.observed.size > 8)
      this.observed.delete(this.observed.keys().next().value!);
  }
  private async locked<T>(
    work: (current: () => void) => Promise<T>,
  ): Promise<T> {
    const sid = this.host.identity.sid,
      installation = this.host.report.installationId;
    const current = () => {
      if (
        sid !== this.host.identity.sid ||
        installation !== this.host.report.installationId
      )
        unavailable();
    };
    // Native rejects a duplicate lease in one helper; all store instances sharing it serialize first.
    const previous = queues.get(this.host.native) ?? Promise.resolve();
    let unlock!: () => void;
    const queued = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => queued);
    queues.set(this.host.native, tail);
    await previous;
    try {
      current();
      if (this.releasePending) {
        await this.host.native.releaseMutex(this.releasePending);
        this.releasePending = undefined;
      }
      let lease: ConsumerMutexLease | null = null;
      const deadline = performance.now() + 5000;
      try {
        do {
          lease = await this.host.native.acquireMutex("metadata");
          if (lease) this.releasePending = lease;
          current();
          if (lease) break;
          if (performance.now() >= deadline) unavailable();
          await delay(20);
        } while (!lease);
        return await work(current);
      } finally {
        if (lease) {
          await this.host.native.releaseMutex(lease);
          this.releasePending = undefined;
        }
      }
    } catch {
      return unavailable();
    } finally {
      unlock();
      if (queues.get(this.host.native) === tail)
        queues.delete(this.host.native);
    }
  }
  private partKey(digest: string, slot: 0 | 1, index: number): string {
    return `b${slot}_${digest}_${index}`;
  }
  private async assertUnchanged(
    digest: string,
    expected: Snapshot | undefined,
    current: () => void,
  ): Promise<void> {
    const head = await this.host.native.vaultRead("account", `bm_${digest}`);
    current();
    // A new store may initialize an absent record; overwriting requires an observed read.
    if (!expected) {
      if (head !== null) unavailable();
      return;
    }
    if (!expected.complete || !equal(expected.head, head)) unavailable();
    if (expected.manifest) {
      for (const [index, prior] of expected.parts.entries()) {
        const part = await this.host.native.vaultRead(
          "account",
          this.partKey(digest, expected.manifest.slot, index),
        );
        current();
        if (!equal(prior, part)) unavailable();
      }
    }
  }
  read(owner: string, trackId: string): Promise<unknown> {
    const digest = this.digest(owner, trackId);
    return this.locked(async (current) => {
      const head = await this.host.native.vaultRead("account", `bm_${digest}`);
      current();
      const snapshot: Snapshot = {
        head,
        manifest: null,
        parts: [],
        complete: true,
        valid: false,
        quarantined: false,
      };
      this.remember(digest, snapshot);
      if (!head) {
        snapshot.valid = true;
        return null;
      }
      if (head.length > VALUE_LIMIT) unavailable();
      const raw = decode(head),
        manifest = parseManifest(raw);
      if (!manifest) {
        snapshot.valid = true;
        return raw;
      }
      snapshot.manifest = manifest;
      snapshot.complete = false;
      for (let index = 0; index < manifest.parts.length; index++) {
        const part = await this.host.native.vaultRead(
          "account",
          this.partKey(digest, manifest.slot, index),
        );
        current();
        snapshot.parts.push(part);
      }
      snapshot.complete = true;
      for (const [index, part] of snapshot.parts.entries()) {
        const bound = manifest.parts[index]!;
        if (!part || part.length !== bound.bytes || sha(part) !== bound.sha256)
          unavailable();
      }
      const bytes = Buffer.concat(snapshot.parts as Buffer[]);
      if (bytes.length !== manifest.bytes || sha(bytes) !== manifest.sha256)
        unavailable();
      const record = decode(bytes);
      snapshot.valid = true;
      return record;
    });
  }
  write(owner: string, trackId: string, record: unknown): Promise<void> {
    const digest = this.digest(owner, trackId),
      expected = this.observed.get(digest);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(JSON.stringify(record));
    } catch {
      return Promise.reject(new Error("PREFERENCES_UNAVAILABLE"));
    }
    if (bytes.length < 1 || bytes.length > RECORD_LIMIT)
      return Promise.reject(new Error("PREFERENCES_UNAVAILABLE"));
    try {
      decode(bytes);
    } catch {
      return Promise.reject(new Error("PREFERENCES_UNAVAILABLE"));
    }
    return this.locked(async (current) => {
      await this.assertUnchanged(digest, expected, current);
      if (expected && !expected.valid && !expected.quarantined) unavailable();
      const slot = expected?.manifest?.slot === 0 ? 1 : 0;
      const parts: Buffer[] = [];
      for (let at = 0; at < bytes.length; at += VALUE_LIMIT)
        parts.push(bytes.subarray(at, at + VALUE_LIMIT));
      const manifest: Manifest = {
        version: 2,
        kind: "bookmark-parts",
        generation: randomUUID(),
        slot,
        bytes: bytes.length,
        sha256: sha(bytes),
        parts: parts.map((part) => ({ bytes: part.length, sha256: sha(part) })),
      };
      for (let index = 0; index < PARTS_LIMIT; index++) {
        current();
        const key = this.partKey(digest, slot, index),
          part = parts[index];
        if (part) await this.host.native.vaultWrite("account", key, part);
        else await this.host.native.vaultDelete("account", key);
        current();
      }
      // All inactive chunks precede the sole atomic commit; the old active slot remains intact.
      const head = Buffer.from(JSON.stringify(manifest));
      current();
      await this.host.native.vaultWrite("account", `bm_${digest}`, head);
      current();
      this.remember(digest, {
        head,
        manifest,
        parts,
        complete: true,
        valid: true,
        quarantined: false,
      });
    });
  }
  quarantine(owner: string, trackId: string): Promise<void> {
    const digest = this.digest(owner, trackId),
      expected = this.observed.get(digest);
    return this.locked(async (current) => {
      if (!expected?.head) unavailable();
      await this.assertUnchanged(digest, expected, current);
      // Copy bytes verbatim, including corrupt/missing chunk evidence; never serialize damaged JSON.
      for (let index = 0; index < PARTS_LIMIT; index++) {
        const key = `bq_${digest}_${index}`,
          part = expected.parts[index];
        if (part) {
          if (part.length > VALUE_LIMIT) unavailable();
          await this.host.native.vaultWrite("account", key, part);
        } else await this.host.native.vaultDelete("account", key);
        current();
      }
      if (expected.head.length > VALUE_LIMIT) unavailable();
      await this.host.native.vaultWrite(
        "account",
        `bmbad_${digest}`,
        expected.head,
      );
      current();
      expected.quarantined = true;
    });
  }
}
