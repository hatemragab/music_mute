import { createHash } from "node:crypto";
import { lstat, statfs } from "node:fs/promises";
import { win32 } from "node:path";
import type {
  ConsumerOwnedProcess,
  ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { storageErrorCode } from "./errors.js";
import type { HostContext } from "../host-context.js";
import type { LibraryPins } from "../library/pins.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import {
  parseStorageCommand,
  OFFLINE_VOCALS_BUDGET_BYTES,
  type StorageView,
  type StorageCleanupTarget,
} from "../../shared/storage-contracts.js";
import {
  WindowsStorageInventory,
  parseWorkspace,
  parseAnyWorkspace,
  parseStoreCpuWorkspace,
  workspaceExited,
} from "./inventory.js";
import {
  isStoreCpuOwner,
  assertStoreCpuOwnerHost,
  storeCpuOwnerExpectation,
  storeCpuOwnerRetired,
  type StoreCpuOwner,
} from "../session/store-cpu-owner.js";
import { WindowsStorageSettings } from "./settings.js";
import { WindowsVoiceReservations } from "./reservations.js";
import { WindowsStorageFiles } from "./files.js";
import {
  WindowsStorageWriteJournal,
  SHARE_TREE,
  type StorageWrite,
  type StorageWriteLease,
} from "./write-journal.js";
import {
  PENDING_ORIGINALS_LIMIT_BYTES,
  STORAGE_FREE_RESERVE_BYTES,
  storageEvictionPlan,
  storageTotals,
  type StorageItem,
} from "./model.js";
import {
  WindowsScratchReservations,
  type ScratchReservationLease,
} from "./scratch-reservations.js";
import { partialWriteTarget } from "./partial-write-policy.js";
import { retireStorageWorkspaceMarker } from "./native-cleanup.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
export interface StorageOptions {
  host: HostContext;
  pins: LibraryPins;
  processIdentity(pid: number): Promise<ConsumerProcessIdentity | null>;
  treeExited(owner: ConsumerOwnedProcess): Promise<boolean>;
  activeRuntimeRoots?: () => Promise<ReadonlySet<string>>;
  pendingOriginalBytes?: () => Promise<number>;
  freeBytes?: () => Promise<number>;
  onChanged?: () => Promise<void>;
}
export class WindowsStorageController {
  private readonly settings: WindowsStorageSettings;
  private readonly inventory: WindowsStorageInventory;
  private readonly reservations: WindowsVoiceReservations;
  private readonly files: WindowsStorageFiles;
  readonly writes: WindowsStorageWriteJournal;
  private readonly scratch: WindowsScratchReservations;
  private value: StorageView = {
    state: "loading",
    errorCode: null,
    budgetBytes: OFFLINE_VOCALS_BUDGET_BYTES,
    voicesBytes: 0,
    reservedVoicesBytes: 0,
    freeBytes: null,
    overBudget: false,
    lowSpace: false,
    categories: [],
    lastCleanup: null,
  };
  private readonly listeners = new Set<(view: StorageView) => void>();
  constructor(private readonly options: StorageOptions) {
    this.scratch = new WindowsScratchReservations(
      options.host,
      options.processIdentity,
      options.treeExited,
    );
    this.settings = new WindowsStorageSettings(options.host);
    this.writes = new WindowsStorageWriteJournal(
      options.host,
      options.processIdentity,
    );
    this.inventory = new WindowsStorageInventory(
      options.host,
      options.treeExited,
      options.activeRuntimeRoots,
      this.writes,
      async () =>
        (await this.scratch.readOwned()).flatMap((row) =>
          row.nativeOwner
            ? [
                {
                  version: 1 as const,
                  relativePath: row.relativePath,
                  owner: row.nativeOwner,
                  purpose: "processing" as const,
                  createdAt: row.createdAt,
                },
              ]
            : [],
        ),
    );
    this.reservations = new WindowsVoiceReservations(
      options.host,
      options.processIdentity,
    );
    this.files = new WindowsStorageFiles(options.host);
  }
  view() {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: StorageView) => void) {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {
        /* Presentation isolation. */
      }
    }
  }
  private async free(): Promise<number> {
    if (this.options.freeBytes) {
      const bytes = await this.options.freeBytes();
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error("DISK_SPACE_UNAVAILABLE");
      return bytes;
    }
    await this.options.host.native.validatePath("personal", "", "directory");
    const result = await statfs(this.options.host.personalRoot, {
        bigint: true,
      }),
      bytes = result.bavail * result.bsize;
    if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("DISK_SPACE_UNAVAILABLE");
    return Number(bytes);
  }
  private async pendingOriginals(): Promise<number> {
    const bytes = (await this.options.pendingOriginalBytes?.()) ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("OUTBOX_STORAGE_INVALID");
    if (bytes > PENDING_ORIGINALS_LIMIT_BYTES) throw new Error("OUTBOX_FULL");
    return bytes;
  }
  async scan(signal = new AbortController().signal): Promise<void> {
    try {
      await this.options.pins.exclusiveUnpinned([], async (guard) => {
        const budget = await this.settings.read(),
          items = await this.inventory.scan(signal),
          reservations = await this.reservations.readOwned(),
          free = await this.free();
        await this.pendingOriginals();
        const pinned = (relative: string) => {
          try {
            guard(relative);
            return false;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "LIBRARY_MEDIA_PINNED"
            )
              return true;
            throw error;
          }
        };
        const categories = storageTotals(items, pinned),
          voices =
            categories.find((row) => row.category === "voices")?.bytes ?? 0,
          reserved = reservations.reduce((sum, row) => sum + row.bytes, 0);
        this.value = {
          ...this.value,
          state: "ready",
          errorCode: null,
          budgetBytes: budget,
          voicesBytes: voices,
          reservedVoicesBytes: reserved,
          freeBytes: free,
          overBudget: voices + reserved > budget,
          lowSpace: free < STORAGE_FREE_RESERVE_BYTES,
          categories,
        };
      });
      this.emit();
    } catch (error) {
      this.value.state = "error";
      this.value.errorCode = storageErrorCode(error);
      this.emit();
      throw error;
    }
  }
  async execute(
    value: unknown,
    signal = new AbortController().signal,
  ): Promise<void> {
    const command = parseStorageCommand(value);
    if (command.type === "SCAN") return this.scan(signal);
    if (command.type === "SET_BUDGET") {
      await this.options.pins.exclusiveUnpinned([], async () => {
        signal.throwIfAborted();
        await this.settings.writeOwned(command.budgetBytes);
      });
      return this.scan(signal);
    }
    await this.cleanup(command.target, signal);
  }
  private async evictOwned(
    items: StorageItem[],
    guard: (relative: string) => void,
    signal: AbortSignal,
  ): Promise<{
    removedBytes: number;
    removedItems: number;
    deferredItems: number;
  }> {
    let removedBytes = 0,
      removedItems = 0,
      deferredItems = 0;
    for (const item of items) {
      signal.throwIfAborted();
      guard(item.relativePath);
      const result = await this.files.removeOwned(item, signal);
      removedBytes += result.removedBytes;
      if (result.complete) removedItems++;
      else deferredItems++;
    }
    return { removedBytes, removedItems, deferredItems };
  }
  /** An uncertain reply can follow real byte effects. Re-read after releasing
   * mutation authority, including on failure/abort, without optimistic results. */
  private async reconcileMutation(
    failure: { error: unknown } | null,
  ): Promise<void> {
    try {
      await this.options.onChanged?.();
    } catch (error) {
      failure ??= { error };
    }
    try {
      await this.scan(new AbortController().signal);
    } catch (error) {
      failure ??= { error };
    }
    if (failure) {
      this.value.lastCleanup = null;
      this.value.state = "error";
      this.value.errorCode = storageErrorCode(failure.error);
      this.emit();
      throw failure.error;
    }
  }
  async cleanup(
    target: StorageCleanupTarget,
    signal: AbortSignal,
  ): Promise<void> {
    let failure: { error: unknown } | null = null;
    try {
      await this.recoverPartialWrites(undefined, signal);
      await this.options.pins.exclusiveUnpinned([], async (guard) => {
        const before = await this.free(),
          items = await this.inventory.scan(signal),
          reservations = await this.reservations.readOwned(),
          protectedByReservation = (relative: string) =>
            reservations.some(
              (row) =>
                relative === row.relativePath ||
                relative.startsWith(`${row.relativePath}\\`) ||
                row.relativePath.startsWith(`${relative}\\`),
            ),
          pinned = (relative: string) => {
            if (protectedByReservation(relative)) return true;
            try {
              guard(relative);
              return false;
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === "LIBRARY_MEDIA_PINNED"
              )
                return true;
              throw error;
            }
          };
        const selected = storageEvictionPlan(
            items,
            await this.settings.read(),
            0,
            0,
            pinned,
            target,
          ),
          result = await this.evictOwned(selected, guard, signal);
        await this.inventory.pruneWorkspaceMarkersOwned(signal);
        await this.writes.removeAbsentOwned();
        await this.scratch.pruneOwned();
        const after = await this.free();
        this.value.lastCleanup = {
          freedBytes: Math.min(
            result.removedBytes,
            Math.max(0, after - before),
          ),
          removedItems: result.removedItems,
          deferredItems: result.deferredItems,
        };
      });
    } catch (error) {
      failure = { error };
    }
    await this.reconcileMutation(failure);
  }
  async reserveVoice(
    bytes: number,
    relativePath: string,
  ): Promise<{ release(): Promise<void> }> {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 100000000 ||
      !/^(?:library\\media\\[a-f0-9]{64}\\[a-f0-9]{24}\\voice\\[a-f0-9]{64}|personal\\results\\[a-f0-9-]{36}(?:\.pending)?)$/u.test(
        relativePath,
      )
    )
      throw new Error("STORAGE_LIMIT_INVALID");
    let id: string | undefined;
    let failure: { error: unknown } | null = null;
    try {
      await this.options.pins.exclusiveUnpinned([], async (guard) => {
        if ((await this.free()) < STORAGE_FREE_RESERVE_BYTES + bytes)
          throw new Error("DISK_SPACE_LOW");
        await this.pendingOriginals();
        const items = await this.inventory.scan(
            new AbortController().signal,
            false,
          ),
          reservations = await this.reservations.readOwned(),
          pinned = (relative: string) => {
            if (
              relative === relativePath ||
              relative.startsWith(`${relativePath}\\`) ||
              reservations.some(
                (row) =>
                  relative === row.relativePath ||
                  relative.startsWith(`${row.relativePath}\\`),
              )
            )
              return true;
            try {
              guard(relative);
              return false;
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === "LIBRARY_MEDIA_PINNED"
              )
                return true;
              throw error;
            }
          };
        const selected = storageEvictionPlan(
          items,
          await this.settings.read(),
          bytes,
          reservations.reduce((sum, row) => sum + row.bytes, 0),
          pinned,
        );
        await this.evictOwned(selected, guard, new AbortController().signal);
        const remaining = await this.inventory.scan(
          new AbortController().signal,
          false,
        );
        const stillNeeded = storageEvictionPlan(
          remaining,
          await this.settings.read(),
          bytes,
          reservations.reduce((sum, row) => sum + row.bytes, 0),
          pinned,
        );
        if (stillNeeded.length) throw new Error("OFFLINE_CACHE_FULL");
        id = (
          await this.reservations.createOwned(bytes, relativePath, reservations)
        ).id;
      });
    } catch (error) {
      failure = { error };
    }
    let released = false;
    let retired = false;
    const lease = {
      release: async () => {
        if (released) return;
        if (!retired)
          await this.options.pins.exclusiveUnpinned([], async () => {
            const rows = await this.reservations.readOwned();
            await this.reservations.writeOwned(
              rows.filter((row) => row.id !== id),
            );
          });
        retired = true;
        // The reservation may be gone even if later presentation recovery
        // fails. Retry that read without writing/removing capacity again.
        await this.scan();
        released = true;
      },
    };
    try {
      await this.reconcileMutation(failure);
    } catch (error) {
      // No bytes can belong to this unissued reservation. Remove only its exact
      // private ID; a failed metadata rollback remains recorded/conservative.
      if (id) {
        try {
          await lease.release();
          await this.scan();
        } catch {
          /* Retain capacity on unknown cleanup. */
        }
      }
      this.value.lastCleanup = null;
      this.value.state = "error";
      this.value.errorCode = storageErrorCode(error);
      this.emit();
      throw error;
    }
    return lease;
  }
  async protectTree(
    relative: string,
    purpose: "processing" | "download" | "sync" | "update" | "share",
    planned = false,
  ) {
    return this.options.pins.pinTree(relative, purpose, planned);
  }
  async beginWrite(
    relative: string,
    kind: "file" | "tree",
    copyBytes?: number,
  ): Promise<StorageWriteLease> {
    const row = await this.options.pins.exclusiveUnpinned([], async () => {
      if (copyBytes !== undefined) {
        const reserved = (await this.writes.readOwned()).reduce(
          (sum, row) => sum + (row.copyBytes ?? 0),
          0,
        );
        if (
          (await this.free()) <
          STORAGE_FREE_RESERVE_BYTES + copyBytes + reserved
        )
          throw new Error("DISK_SPACE_LOW");
      }
      return this.writes.beginOwned(relative, kind, undefined, copyBytes);
    });
    return this.writeLease(row);
  }
  async shareWrites(): Promise<StorageWrite[]> {
    return this.options.pins.exclusiveUnpinned([], async () => {
      await this.writes.removeAbsentOwned();
      return (await this.writes.readOwned()).filter((row) => row.share);
    });
  }
  async resumeShareWrite(
    requestId: string,
  ): Promise<{ row: StorageWrite; lease: StorageWriteLease }> {
    const relative = `share\\requests\\${requestId}`;
    if (!SHARE_TREE.test(relative)) throw new Error("STORAGE_WRITE_INVALID");
    const row = await this.options.pins.exclusiveUnpinned([], async () =>
      (await this.writes.readOwned()).find(
        (row) => row.relativePath === relative && row.share,
      ),
    );
    if (!row) throw new Error("STORAGE_WRITE_CHANGED");
    if (!row.share!.nativePending && !(await this.writes.eligible(row)))
      throw new Error("STORAGE_RECOVERY_PENDING");
    return { row, lease: this.writeLease(row) };
  }
  private writeLease(row: StorageWrite): StorageWriteLease {
    let settled = false;
    return {
      id: row.id,
      sealShare: (relative, sha, bytes) =>
        this.options.pins.exclusiveUnpinned([], () =>
          this.writes.sealShareOwned(row, relative, sha, bytes),
        ),
      handoffShare: (helper) =>
        this.options.pins.exclusiveUnpinned([], () =>
          this.writes.handoffShareOwned(row, helper),
        ),
      confirmShareQuiesced: (receipt, inspect) =>
        this.options.pins.exclusiveUnpinned([], () =>
          this.writes.confirmShareQuiescedOwned(row, receipt, inspect),
        ),
      captureCreated: (birth, relative) =>
        this.options.pins.exclusiveUnpinned([], async () =>
          this.writes.captureCreatedOwned(row, birth, relative),
        ),
      preparePublish: async (path, metadata, temporary, sha) => {
        if (settled) throw new Error("STORAGE_WRITE_CHANGED");
        await this.options.pins.exclusiveUnpinned([], () =>
          this.writes.preparePublishOwned(row, path, metadata, temporary, sha),
        );
      },
      settle: async () => {
        if (settled) return;
        await this.options.pins.exclusiveUnpinned([], () =>
          this.writes.finishOwned(row),
        );
        settled = true;
      },
      handoff: async () => {
        if (settled) return;
        await this.options.pins.exclusiveUnpinned([], () =>
          this.writes.handoffOwned(row),
        );
        settled = true;
      },
    };
  }
  async beginPartialWrite(
    relative: string,
    bytes: number,
  ): Promise<StorageWriteLease> {
    const target = partialWriteTarget(relative);
    if (
      !target ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > target.maxBytes
    )
      throw new Error("STORAGE_WRITE_INVALID");
    await this.recoverPartialWrites(undefined, new AbortController().signal);
    return this.beginWrite(relative, "file", bytes);
  }
  recoverPartialWrites(
    canonical: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    return this.options.pins.exclusivePartialWrites(async (guard) => {
      // Production SDK always supplies this metadata-only positive-certificate
      // recovery. Byte retirement still uses its mandatory exact receiver.
      await this.options.host.native.recoverStorageCleanups?.();
      if (canonical !== undefined)
        return this.writes.reclaimPartialFilesOwned(canonical, signal, guard);
      for (const row of await this.writes.readOwned()) {
        const target = partialWriteTarget(row.relativePath);
        if (!target || !(await this.writes.eligible(row))) continue;
        try {
          await this.writes.reclaimPartialFilesOwned(
            target.canonical,
            signal,
            guard,
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "LIBRARY_MEDIA_PINNED"
          )
            throw error;
        }
      }
    });
  }
  async reserveScratch(
    bytes: number,
    relativePath: string,
  ): Promise<ScratchReservationLease> {
    const row = await this.options.pins.exclusiveUnpinned([], async () => {
      const reserved = (await this.scratch.readOwned()).reduce(
        (sum, row) => sum + row.bytes,
        0,
      );
      if ((await this.free()) < STORAGE_FREE_RESERVE_BYTES + bytes + reserved)
        throw new Error("DISK_SPACE_LOW");
      return this.scratch.createOwned(bytes, relativePath);
    });
    let released = false;
    const mutate = (
      action: "handoff" | "bind" | "release",
      owner?: ConsumerOwnedProcess | StoreCpuOwner,
    ) =>
      this.options.pins.exclusiveUnpinned([], () =>
        this.scratch.mutateOwned(row, action, owner),
      );
    return {
      handoff: () => mutate("handoff"),
      bind: (owner) => mutate("bind", owner),
      release: async () => {
        if (!released) {
          await this.options.pins.exclusiveUnpinned([], async () => {
            await this.scratch.mutateOwned(row, "release");
            released = true;
          });
        }
      },
    };
  }
  /** This role retains the workspace pin and GPU lease until native cache deletion completes. */
  async removeExitedSessionWorkspace(relative: string): Promise<void> {
    if (
      !this.options.host.native.inferenceIdle ||
      !(await this.options.host.native.inferenceIdle())
    )
      throw new Error("STORAGE_RECOVERY_PENDING");
    const signal = AbortSignal.timeout(30000);
    await this.options.pins.exclusiveUnpinned([], async () => {
      const item = await this.inventory.exitedSessionWorkspace(
        relative,
        signal,
      );
      const result = await this.files.removeOwned(item, signal);
      if (!result.complete) throw new Error("STORAGE_RECOVERY_PENDING");
    });
  }
  async trackWorkspace(
    relativePath: string,
    owner: ConsumerOwnedProcess | StoreCpuOwner,
    purpose: "processing" | "download" | "sync" | "update",
  ) {
    const storeOwner = isStoreCpuOwner(owner) ? owner : undefined;
    if (storeOwner) assertStoreCpuOwnerHost(storeOwner, this.options.host);
    const row = storeOwner
        ? parseStoreCpuWorkspace(
            {
              version: 2,
              relativePath,
              owner: storeCpuOwnerExpectation(storeOwner),
              purpose,
              createdAt: Date.now(),
            },
            this.options.host.identity.sid,
          )
        : parseWorkspace(
            { version: 1, relativePath, owner, purpose, createdAt: Date.now() },
            this.options.host.identity.sid,
          ),
      pin = await this.protectTree(relativePath, purpose),
      marker = `storage\\workspaces\\${createHash("sha256").update(relativePath).digest("hex")}.json`;
    try {
      await this.options.pins.exclusiveUnpinned([], async () => {
        await writePrivateAtomic(
          this.options.host,
          marker,
          Buffer.from(JSON.stringify(row)),
        );
      });
    } catch (error) {
      await pin.release();
      throw error;
    }
    let released = false,
      markerRemoved = false;
    return {
      pinId: pin.pinId,
      releaseExitedSessionProtection: async () => {
        if (
          !/^personal\\engine-session\\[a-f0-9-]{36}$/u.test(relativePath) ||
          !this.options.host.native.inferenceIdle ||
          !(await this.options.host.native.inferenceIdle())
        )
          throw new Error("STORAGE_RECOVERY_PENDING");
        await pin.release();
      },
      retireForRelaunch: async () => {
        if (released) throw new Error("STORAGE_WORKSPACE_CHANGED");
        await this.options.pins.exclusiveUnpinned([], async () => {
          if (markerRemoved) return;
          if (
            !(storeOwner
              ? await storeCpuOwnerRetired(storeOwner)
              : await workspaceExited(
                  this.options.host,
                  this.options.treeExited,
                  row,
                ))
          )
            throw new Error("STORAGE_RECOVERY_PENDING");
          await retireStorageWorkspaceMarker(
            this.options.host,
            relativePath,
            row.owner,
          );
          markerRemoved = true;
        });
        await pin.release();
        released = true;
      },
      release: async () => {
        if (released) return;
        await this.options.pins.exclusiveUnpinned([], async () => {
          if (markerRemoved) return;
          try {
            await lstat(
              win32.join(this.options.host.personalRoot, relativePath),
            );
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await retireStorageWorkspaceMarker(
            this.options.host,
            relativePath,
            row.owner,
          );
          markerRemoved = true;
        });
        await pin.release();
        released = true;
      },
    };
  }
  /** Restart recovery cannot use the new Node's empty child map as prior-tree exit proof. */
  async assertWorkspaceExited(relativePath: string): Promise<void> {
    const marker = `storage\\workspaces\\${createHash("sha256").update(relativePath).digest("hex")}.json`;
    const bytes = await readPrivateBytes(this.options.host, marker, 2048);
    const row = parseAnyWorkspace(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      this.options.host.identity.sid,
    );
    if (
      row.relativePath !== relativePath ||
      !(await workspaceExited(this.options.host, this.options.treeExited, row))
    )
      throw new Error("STORAGE_RECOVERY_PENDING");
  }
}
