import { createHash, randomUUID } from "node:crypto";
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
import { acquireLibraryCacheLease } from "./cache-lease.js";
import type { HostContext } from "../host-context.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import type { TrustedLibraryArtifact } from "./artifacts.js";
import { partialWriteTarget } from "../storage/partial-write-policy.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
interface AccessEntry {
  relativePath: string;
  at: number;
}
class StorageAccessInvalid extends Error {
  constructor() {
    super("STORAGE_ACCESS_INVALID");
  }
}
function accessProperties(
  value: unknown,
  keys: readonly string[],
): Record<string, PropertyDescriptor> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new StorageAccessInvalid();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.sort().join() !== [...keys].sort().join()
  )
    throw new StorageAccessInvalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some(
      (key) =>
        !descriptors[key] ||
        !("value" in descriptors[key]!) ||
        !descriptors[key]!.enumerable,
    )
  )
    throw new StorageAccessInvalid();
  return descriptors;
}
/** Copy only canonical data properties; malformed advisory metadata stays intact. */
export function parseStorageAccessIndex(bytes: Buffer): AccessEntry[] {
  try {
    // A full 4096-entry index has 12291 JSON value nodes.
    const value = parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        1024 ** 2,
        16384,
      ),
      row = accessProperties(value, ["entries", "version"]),
      entries: unknown = row.entries!.value;
    if (
      row.version!.value !== 1 ||
      !Array.isArray(entries) ||
      entries.length > 4096 ||
      Object.getPrototypeOf(entries) !== Array.prototype ||
      Reflect.ownKeys(entries).length !== entries.length + 1
    )
      throw new StorageAccessInvalid();
    const result: AccessEntry[] = [],
      paths = new Set<string>();
    for (let index = 0; index < entries.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(entries, index);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new StorageAccessInvalid();
      const entry = accessProperties(descriptor.value, ["relativePath", "at"]),
        relativePath: unknown = entry.relativePath!.value,
        at: unknown = entry.at!.value;
      if (
        typeof relativePath !== "string" ||
        typeof at !== "number" ||
        !Number.isSafeInteger(at) ||
        at < 0
      )
        throw new StorageAccessInvalid();
      assertConsumerRelativePath(relativePath);
      const canonical = relativePath.toLowerCase();
      if (paths.has(canonical)) throw new StorageAccessInvalid();
      paths.add(canonical);
      result.push({ relativePath, at });
    }
    return result;
  } catch {
    throw new StorageAccessInvalid();
  }
}
interface Pin {
  id: string;
  key: string;
  relativePath: string;
  owner: ConsumerProcessIdentity;
  purpose:
    | "playback"
    | "export"
    | "outbox"
    | "processing"
    | "download"
    | "sync"
    | "update"
    | "share";
  kind?: "directory";
  createdAt: number;
}
const PIN_FILE = "library\\pins.json";
export class LibraryPins {
  constructor(
    private readonly host: HostContext,
    private readonly processIdentity: (
      pid: number,
    ) => Promise<ConsumerProcessIdentity | null>,
    private readonly retainedProtectedDirectories: () => Promise<
      ReadonlySet<string>
    > = async () => new Set(),
  ) {}
  private async owned<T>(action: () => Promise<T>): Promise<T> {
    const lease = await acquireLibraryCacheLease(this.host);
    try {
      return await action();
    } finally {
      await this.host.native.releaseMutex(lease);
    }
  }
  private async read(): Promise<Pin[]> {
    try {
      await lstat(win32.join(this.host.personalRoot, PIN_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const value = JSON.parse(
      (await readPrivateBytes(this.host, PIN_FILE, 256 * 1024)).toString(
        "utf8",
      ),
    ) as { version: number; pins: Pin[] };
    if (
      !value ||
      Object.keys(value).sort().join() !== "pins,version" ||
      value.version !== 1 ||
      !Array.isArray(value.pins) ||
      value.pins.length > 128
    )
      throw new Error("LIBRARY_PINS_INVALID");
    const live: Pin[] = [];
    for (const pin of value.pins) {
      if (
        !pin ||
        Object.keys(pin).sort().join() !==
          (pin.kind === undefined
            ? "createdAt,id,key,owner,purpose,relativePath"
            : "createdAt,id,key,kind,owner,purpose,relativePath") ||
        !/^[a-f0-9-]{36}$/.test(pin.id) ||
        !/^[a-f0-9]{64}$/.test(pin.key) ||
        typeof pin.relativePath !== "string" ||
        ![
          "playback",
          "export",
          "outbox",
          "processing",
          "download",
          "sync",
          "update",
          "share",
        ].includes(pin.purpose) ||
        (pin.kind !== undefined && pin.kind !== "directory") ||
        !Number.isSafeInteger(pin.createdAt) ||
        pin.createdAt < 0
      )
        throw new Error("LIBRARY_PINS_INVALID");
      const owner = processIdentityFromWire(processIdentityToWire(pin.owner));
      assertConsumerRelativePath(pin.relativePath);
      if (owner.sid !== this.host.identity.sid)
        throw new Error("LIBRARY_PINS_INVALID");
      const current = await this.processIdentity(owner.pid);
      if (current && sameConsumerProcess(current, owner)) live.push(pin);
    }
    return live;
  }
  private write(pins: Pin[]): Promise<void> {
    return writePrivateAtomic(
      this.host,
      PIN_FILE,
      Buffer.from(JSON.stringify({ version: 1, pins })),
    );
  }
  async pin(
    artifact: TrustedLibraryArtifact,
    purpose: Pin["purpose"] = "playback",
  ): Promise<{
    artifactId: string;
    relativePath: string;
    sha256: string;
    release(): Promise<void>;
  }> {
    const release = await this.recordPin(
      artifact.relativePath,
      "file",
      purpose,
      createHash("sha256")
        .update(`${artifact.relativePath}:${artifact.sha256}`)
        .digest("hex"),
    );
    return {
      artifactId: artifact.artifactId,
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      release,
    };
  }
  async pinTree(
    relativePath: string,
    purpose: Pin["purpose"],
    planned = false,
  ): Promise<{ pinId: string; release(): Promise<void> }> {
    const release = await this.recordPin(
      relativePath,
      "directory",
      purpose,
      createHash("sha256").update(relativePath).digest("hex"),
      planned,
    );
    return { pinId: release.pinId, release };
  }
  private async recordPin(
    relativePath: string,
    kind: "file" | "directory",
    purpose: Pin["purpose"],
    key: string,
    planned = false,
  ): Promise<(() => Promise<void>) & { pinId: string }> {
    assertConsumerRelativePath(relativePath);
    const id = randomUUID();
    await this.owned(async () => {
      await this.host.native.validatePath(
        "personal",
        relativePath,
        planned ? "absent" : kind,
      );
      const pins = await this.read();
      if (pins.length >= 128) throw new Error("LIBRARY_PIN_LIMIT");
      const consuming = await this.processIdentity(process.pid);
      if (
        !consuming ||
        consuming.sid !== this.host.identity.sid ||
        consuming.sessionId !== this.host.identity.sessionId
      )
        throw new Error("LIBRARY_PIN_OWNER_INVALID");
      const owner = processIdentityFromWire(processIdentityToWire(consuming));
      pins.push({
        id,
        key,
        relativePath,
        owner,
        purpose,
        createdAt: Date.now(),
        ...(kind === "directory" ? { kind } : {}),
      });
      try {
        await this.touchOwned(relativePath);
      } catch (error) {
        if (!(error instanceof StorageAccessInvalid)) throw error;
      }
      await this.write(pins);
    });
    let released = false;
    return Object.assign(
      async () => {
        if (released) return;
        await this.owned(async () => {
          await this.write((await this.read()).filter((pin) => pin.id !== id));
        });
        released = true;
      },
      { pinId: id },
    );
  }
  private async touchOwned(relativePath: string): Promise<void> {
    const relative = "storage\\access.json";
    let entries: AccessEntry[] = [],
      present = true;
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      present = false;
    }
    if (present)
      entries = parseStorageAccessIndex(
        await readPrivateBytes(this.host, relative, 1024 ** 2),
      );
    entries = entries.filter(
      (entry) =>
        entry.relativePath.toLowerCase() !== relativePath.toLowerCase(),
    );
    entries.push({ relativePath, at: Date.now() });
    entries.sort(
      (a, b) => b.at - a.at || a.relativePath.localeCompare(b.relativePath),
    );
    await writePrivateAtomic(
      this.host,
      relative,
      Buffer.from(
        JSON.stringify({ version: 1, entries: entries.slice(0, 4096) }),
      ),
    );
  }
  async hasLiveConsumers(excludedOwnUpdatePinId?: string): Promise<boolean> {
    return this.owned(async () => {
      const pins = await this.read();
      const current = excludedOwnUpdatePinId
        ? await this.processIdentity(process.pid)
        : null;
      return pins.some(
        (pin) =>
          !(
            pin.id === excludedOwnUpdatePinId &&
            pin.purpose === "update" &&
            current &&
            sameConsumerProcess(current, pin.owner)
          ),
      );
    });
  }
  async protectedDirectories(): Promise<Set<string>> {
    return this.owned(
      async () =>
        new Set([
          ...(await this.read()).map((pin) =>
            pin.kind === "directory"
              ? pin.relativePath
              : win32.dirname(pin.relativePath),
          ),
          ...(await this.retainedProtectedDirectories()),
        ]),
    );
  }
  async exclusiveUnpinned<T>(
    relatives: readonly string[],
    action: (assertUnpinned: (relative: string) => void) => Promise<T>,
  ): Promise<T> {
    return this.owned(async () => {
      const directories = new Set([
        ...(await this.read()).map((pin) =>
          pin.kind === "directory"
            ? pin.relativePath
            : win32.dirname(pin.relativePath),
        ),
        ...(await this.retainedProtectedDirectories()),
      ]);
      let active = true;
      const assertUnpinned = (relative: string) => {
        if (!active) throw new Error("LIBRARY_LOCK_RELEASED");
        assertConsumerRelativePath(relative);
        if (
          [...directories].some(
            (directory) =>
              relative === directory ||
              relative.startsWith(`${directory}\\`) ||
              directory.startsWith(`${relative}\\`),
          )
        )
          throw new Error("LIBRARY_MEDIA_PINNED");
      };
      relatives.forEach(assertUnpinned);
      try {
        return await action(assertUnpinned);
      } finally {
        active = false;
      }
    });
  }
  /** Recover only closed temporary slots. Live consumers still block; durable Outbox retention protects the canonical pair, not a positively stopped copier's temporary. */
  async exclusivePartialWrites<T>(
    action: (assertUnpinned: (relative: string) => void) => Promise<T>,
  ): Promise<T> {
    return this.owned(async () => {
      const directories = (await this.read()).map((pin) =>
        pin.kind === "directory"
          ? pin.relativePath
          : win32.dirname(pin.relativePath),
      );
      let active = true;
      const assertUnpinned = (relative: string) => {
        if (!active) throw new Error("LIBRARY_LOCK_RELEASED");
        if (!partialWriteTarget(relative))
          throw new Error("STORAGE_WRITE_INVALID");
        if (
          directories.some(
            (directory) =>
              relative === directory ||
              relative.startsWith(`${directory}\\`) ||
              directory.startsWith(`${relative}\\`),
          )
        )
          throw new Error("LIBRARY_MEDIA_PINNED");
      };
      try {
        return await action(assertUnpinned);
      } finally {
        active = false;
      }
    });
  }
  async assertUnpinned(relative: string): Promise<void> {
    const directories = await this.protectedDirectories();
    if (
      [...directories].some(
        (directory) =>
          relative === directory ||
          relative.startsWith(`${directory}\\`) ||
          directory.startsWith(`${relative}\\`),
      )
    )
      throw new Error("LIBRARY_MEDIA_PINNED");
  }
}
