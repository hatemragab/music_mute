import { randomUUID, createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { ConsumerFileBirth } from "../../../worker/src/platform/windows/consumer-native.js";
import type { LibraryExportDestination } from "./library/export.js";
import { desktopInputPathIsSafe } from "../../../chrome-extension/src/shared/local-platform.js";
import { PendingOperations, waitForDialog } from "./pending-operations.js";

type Destination = NonNullable<
  Awaited<ReturnType<LibraryExportDestination["choose"]>>
>;
export interface SaveOwner {
  id: string;
  current(): boolean;
}
export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}
interface Entry {
  kind: "archive" | "audio" | "report";
  owner: SaveOwner;
  expires: number;
  destination: Destination;
}
type Cleanup = () => Promise<void>;
interface OwnerState {
  retired: boolean;
  abort: AbortController;
  work: Set<Promise<unknown>>;
  resources: Set<Cleanup>;
  retirement: Promise<void> | undefined;
}
export type RetainSaveCleanup = (cleanup: Cleanup) => Cleanup;
/** Private, dialog-created file proof. The native receiver binds the actual
 * consuming Main process and approved app pin; no renderer path is accepted. */
export interface CreatedExportDiscardRequest {
  readonly requestId: string;
  readonly path: string;
  readonly birth: Readonly<ConsumerFileBirth>;
  readonly bytes: number;
  readonly writtenAt: string;
  readonly changedAt: string;
}
export type CreatedExportDiscardPort = (
  request: Readonly<CreatedExportDiscardRequest>,
) => Promise<
  { state: "completed"; acknowledge(): Promise<void> } | { state: "pending" }
>;
export type ExportDestinationPreflight = (path: string) => Promise<void>;
/** Dialog consent creates one new file; an opaque grant never authorizes a path. */
export class TrustedSaveDestinations {
  private readonly entries = new Map<string, Entry>();
  private readonly operations = new PendingOperations();
  private readonly abort = new AbortController();
  private closed = false;
  private readonly owners = new Map<string, OwnerState>();
  private readonly ownerRefs = new WeakMap<SaveOwner, OwnerState>();
  private readonly destinationCleanup = new WeakMap<Destination, Cleanup>();
  private readonly claimed = new Set<{
    owner: string;
    release(): Promise<void>;
  }>();
  private readonly listeners = new Set<() => void>();
  private readonly revealers = new WeakMap<
    Destination,
    (
      sha256: string,
      bytes: number,
      signal: AbortSignal,
      retainCleanup: RetainSaveCleanup,
    ) => Promise<void>
  >();
  private readonly receipts = new Map<
    string,
    {
      owner: SaveOwner;
      reveal(
        signal: AbortSignal,
        retainCleanup: RetainSaveCleanup,
      ): Promise<void>;
    }
  >();
  activity(): {
    pending: number;
    grants: number;
    claimed: number;
    idle: boolean;
    retained: number;
    owners: number;
  } {
    const states = [...this.owners.values()];
    const pending = this.operations.activity().pending;
    const retained = states.reduce(
      (count, state) => count + state.resources.size,
      0,
    );
    return {
      pending,
      grants: this.entries.size,
      claimed: this.claimed.size,
      retained,
      owners: this.owners.size,
      idle:
        pending === 0 &&
        this.entries.size === 0 &&
        this.claimed.size === 0 &&
        retained === 0 &&
        !states.some((state) => state.retirement),
    };
  }
  subscribeActivity(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
  constructor(
    private readonly dialog: (
      name: string,
      title: string,
    ) => Promise<SaveDialogResult>,
    private readonly now: () => number = Date.now,
    private readonly reveal?: (path: string) => Promise<void>,
    private readonly discardCreatedExport?: CreatedExportDiscardPort,
    private readonly validateDestination?: ExportDestinationPreflight,
  ) {
    this.operations.subscribeActivity(() => this.changed());
  }

  private state(owner: string): OwnerState {
    let state = this.owners.get(owner);
    if (!state) {
      state = {
        retired: false,
        abort: new AbortController(),
        work: new Set(),
        resources: new Set(),
        retirement: undefined,
      };
      this.owners.set(owner, state);
    }
    return state;
  }
  private stateFor(owner: SaveOwner): OwnerState {
    let state = this.ownerRefs.get(owner);
    if (!state) {
      state = this.state(owner.id);
      this.ownerRefs.set(owner, state);
    }
    return state;
  }
  private collectOwner(owner: string, state: OwnerState): void {
    if (
      this.owners.get(owner) === state &&
      state.retired &&
      !state.retirement &&
      !state.work.size &&
      !state.resources.size &&
      ![...this.entries.values()].some((entry) => entry.owner.id === owner) &&
      ![...this.claimed].some((entry) => entry.owner === owner) &&
      ![...this.receipts.values()].some((entry) => entry.owner.id === owner)
    )
      this.owners.delete(owner);
  }
  private assertOwner(owner: SaveOwner, state: OwnerState): void {
    if (this.closed || state.retired || !owner.current())
      throw new Error("EXPORT_UNAVAILABLE");
  }
  private retain(state: OwnerState, cleanup: Cleanup): Cleanup {
    let complete = false;
    let attempt: Promise<void> | undefined;
    const release: Cleanup = () => {
      if (complete) return Promise.resolve();
      if (attempt) return attempt;
      attempt = Promise.resolve()
        .then(cleanup)
        .then(
          () => {
            complete = true;
            state.resources.delete(release);
            this.changed();
          },
          () => {
            throw new Error("EXPORT_UNAVAILABLE");
          },
        )
        .finally(() => {
          attempt = undefined;
        });
      return attempt;
    };
    state.resources.add(release);
    this.changed();
    return release;
  }
  /** The outer work includes its real source descriptor/pin finally. Never retire
   * this owner from inside that work; its registered cleanup callbacks are safe. */
  runOwned<T>(
    owner: SaveOwner,
    signal: AbortSignal,
    work: (signal: AbortSignal, retainCleanup: RetainSaveCleanup) => Promise<T>,
  ): Promise<T> {
    const state = this.stateFor(owner);
    try {
      this.assertOwner(owner, state);
      signal.throwIfAborted();
    } catch {
      return Promise.reject(new Error("EXPORT_UNAVAILABLE"));
    }
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<T>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    // Reserve before PendingOperations emits activity; retirement must see us.
    state.work.add(settled);
    const operation = this.operations.run(async () => {
      this.assertOwner(owner, state);
      const combined = AbortSignal.any([
        signal,
        state.abort.signal,
        this.abort.signal,
      ]);
      combined.throwIfAborted();
      return work(combined, (cleanup) => this.retain(state, cleanup));
    });
    void operation.then(resolve, reject);
    void settled.then(
      () => {
        state.work.delete(settled);
        this.collectOwner(owner.id, state);
        this.changed();
      },
      () => {
        state.work.delete(settled);
        this.collectOwner(owner.id, state);
        this.changed();
      },
    );
    return settled;
  }

  choose(
    name: string,
    title: string,
    owner: SaveOwner,
    signal: AbortSignal,
  ): Promise<Destination | null> {
    return this.runOwned(owner, signal, async (signal, retainCleanup) => {
      const state = this.stateFor(owner);
      const selected = await waitForDialog(this.dialog(name, title), signal);
      signal.throwIfAborted();
      if (selected.canceled || !selected.filePath) return null;
      this.assertOwner(owner, state);
      if (!desktopInputPathIsSafe(selected.filePath))
        throw new Error("EXPORT_UNAVAILABLE");
      const path = selected.filePath;
      if (process.platform === "win32" && !this.validateDestination)
        throw new Error("EXPORT_UNAVAILABLE");
      await this.validateDestination?.(path);
      signal.throwIfAborted();
      this.assertOwner(owner, state);
      const file = await open(path, "wx", 0o600);
      const requestId = randomUUID();
      let birth: BigIntStats | undefined;
      let discardProof: Readonly<CreatedExportDiscardRequest> | undefined;
      let discardCompleted: { acknowledge(): Promise<void> } | undefined;
      let closed = false;
      let closing: Promise<void> | undefined;
      let committed = false;
      let committing = false;
      let discardRequested = false;
      let saved:
        { size: bigint; modified: bigint; changed: bigint } | undefined;
      const exact = async () => {
        birth ??= await file.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (
          !birth.isFile() ||
          !named.isFile() ||
          named.isSymbolicLink() ||
          named.nlink !== 1n ||
          named.dev !== birth.dev ||
          named.ino !== birth.ino ||
          named.birthtimeNs !== birth.birthtimeNs
        )
          throw new Error("EXPORT_UNAVAILABLE");
      };
      const closeFile = async () => {
        if (closed) return;
        closing ??= file
          .close()
          .then(() => {
            closed = true;
          })
          .finally(() => {
            closing = undefined;
          });
        await closing;
      };
      const cleanup = retainCleanup(async () => {
        if (committed) return;
        discardRequested = true;
        if (!discardProof) {
          // Close the original descriptor even when the name has been replaced,
          // but never infer deletion permission from that close or path absence.
          try {
            await exact();
          } catch {
            if (birth) await closeFile();
            throw new Error("EXPORT_UNAVAILABLE");
          }
          await closeFile();
          await exact();
          const fingerprint = await lstat(path, { bigint: true });
          if (
            !birth ||
            !fingerprint.isFile() ||
            fingerprint.isSymbolicLink() ||
            fingerprint.nlink !== 1n ||
            fingerprint.dev !== birth.dev ||
            fingerprint.ino !== birth.ino ||
            fingerprint.birthtimeNs !== birth.birthtimeNs ||
            fingerprint.size < 0n ||
            fingerprint.size > BigInt(Number.MAX_SAFE_INTEGER)
          )
            throw new Error("EXPORT_UNAVAILABLE");
          discardProof = Object.freeze({
            requestId,
            path,
            birth: Object.freeze({
              device: birth.dev.toString(),
              fileId: birth.ino.toString(),
              bornAt: birth.birthtimeNs.toString(),
            }),
            bytes: Number(fingerprint.size),
            writtenAt: fingerprint.mtimeNs.toString(),
            changedAt: fingerprint.ctimeNs.toString(),
          });
        }
        // Only the native retained-handle/certificate authority can complete
        // deletion. Reuse the frozen request after ACK loss; never resample a
        // replacement or regard ENOENT as proof that our effect completed.
        if (!discardCompleted) {
          if (!this.discardCreatedExport) throw new Error("EXPORT_UNAVAILABLE");
          const result = await this.discardCreatedExport(discardProof);
          if (result.state !== "completed")
            throw new Error("EXPORT_UNAVAILABLE");
          discardCompleted = result;
        }
        // Completion has already proved this file's deletion. A failed protected
        // receipt ACK retains only that same callback; it must not re-delete,
        // infer success from absence, or forget an unacknowledged native receipt.
        await discardCompleted.acknowledge();
      });
      const discard = () => {
        if (!committed) discardRequested = true;
        return cleanup();
      };
      const destination: Destination = {
        file,
        commit: async () => {
          if (discardRequested || committed || committing)
            throw new Error("EXPORT_UNAVAILABLE");
          committing = true;
          this.assertOwner(owner, state);
          signal.throwIfAborted();
          await exact();
          if (discardRequested) throw new Error("EXPORT_UNAVAILABLE");
          this.assertOwner(owner, state);
          signal.throwIfAborted();
          await closeFile();
          await exact();
          const final = await lstat(path, { bigint: true });
          if (discardRequested) throw new Error("EXPORT_UNAVAILABLE");
          this.assertOwner(owner, state);
          signal.throwIfAborted();
          saved = {
            size: final.size,
            modified: final.mtimeNs,
            changed: final.ctimeNs,
          };
          committed = true;
          // Positive commit preserves the user's completed file; the cleanup
          // callback acknowledges its release without deleting it.
          await cleanup();
        },
        discard,
      };
      this.destinationCleanup.set(destination, cleanup);
      this.revealers.set(
        destination,
        async (sha256, bytes, signal, retainCleanup) => {
          if (!saved || !this.reveal) throw new Error("EXPORT_UNAVAILABLE");
          this.assertOwner(owner, state);
          await exact();
          const actual = await lstat(path, { bigint: true });
          if (
            actual.size !== saved.size ||
            actual.mtimeNs !== saved.modified ||
            actual.ctimeNs !== saved.changed
          )
            throw new Error("EXPORT_UNAVAILABLE");
          const proof = await open(path, "r");
          const closeProof = retainCleanup(() => proof.close());
          try {
            const fingerprint = await proof.stat({ bigint: true });
            if (
              !birth ||
              fingerprint.dev !== birth.dev ||
              fingerprint.ino !== birth.ino ||
              fingerprint.birthtimeNs !== birth.birthtimeNs ||
              fingerprint.nlink !== 1n ||
              fingerprint.size !== BigInt(bytes)
            )
              throw new Error("EXPORT_UNAVAILABLE");
            const hash = createHash("sha256"),
              buffer = Buffer.alloc(Math.min(bytes, 1024 ** 2));
            for (let offset = 0; offset < bytes;) {
              signal.throwIfAborted();
              this.assertOwner(owner, state);
              const { bytesRead } = await proof.read(
                buffer,
                0,
                Math.min(buffer.length, bytes - offset),
                offset,
              );
              if (bytesRead < 1) throw new Error("EXPORT_UNAVAILABLE");
              hash.update(buffer.subarray(0, bytesRead));
              offset += bytesRead;
            }
            const after = await proof.stat({ bigint: true });
            if (
              after.size !== fingerprint.size ||
              after.mtimeNs !== fingerprint.mtimeNs ||
              after.ctimeNs !== fingerprint.ctimeNs ||
              hash.digest("hex") !== sha256
            )
              throw new Error("EXPORT_UNAVAILABLE");
          } finally {
            await closeProof();
          }
          await exact();
          this.assertOwner(owner, state);
          signal.throwIfAborted();
          await this.reveal(path);
        },
      );
      try {
        birth = await file.stat({ bigint: true });
        this.assertOwner(owner, state);
        signal.throwIfAborted();
        return destination;
      } catch {
        await discard();
        throw new Error("EXPORT_UNAVAILABLE");
      }
    });
  }
  async writeReceipt(
    capability: string,
    owner: string,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<string> {
    const entry = this.entries.get(capability);
    if (!entry || entry.owner.id !== owner || !this.reveal)
      throw new Error("EXPORT_UNAVAILABLE");
    const reveal = this.revealers.get(entry.destination);
    if (!reveal) throw new Error("EXPORT_UNAVAILABLE");
    const expected = createHash("sha256").update(bytes).digest("hex"),
      count = bytes.length;
    await this.write(capability, owner, bytes, signal);
    signal.throwIfAborted();
    this.assertOwner(entry.owner, this.stateFor(entry.owner));
    const receipt = randomUUID();
    if (this.receipts.size >= 4)
      this.receipts.delete(this.receipts.keys().next().value!);
    this.receipts.set(receipt, {
      owner: entry.owner,
      reveal: (signal, retainCleanup) =>
        reveal(expected, count, signal, retainCleanup),
    });
    return receipt;
  }
  async showReceipt(receipt: string, owner: string): Promise<void> {
    const entry = this.receipts.get(receipt);
    if (
      !entry ||
      entry.owner.id !== owner ||
      !entry.owner.current() ||
      this.closed
    )
      throw new Error("EXPORT_UNAVAILABLE");
    await this.runOwned(
      entry.owner,
      new AbortController().signal,
      entry.reveal,
    );
  }

  async grant(
    name: string,
    title: string,
    owner: SaveOwner,
    signal: AbortSignal,
    kind: Entry["kind"] = "archive",
  ): Promise<string | null> {
    return this.runOwned(owner, signal, async (signal) => {
      await this.expire(owner.id);
      const activeGrants = () =>
        [...this.entries.values()].filter(
          (entry) =>
            !this.state(entry.owner.id).retired &&
            entry.expires > this.now() &&
            entry.owner.current(),
        ).length;
      if (activeGrants() >= 4) throw new Error("EXPORT_LIMIT_REACHED");
      const destination = await this.choose(name, title, owner, signal);
      if (!destination) return null;
      if (
        this.closed ||
        this.state(owner.id).retired ||
        signal.aborted ||
        !owner.current() ||
        activeGrants() >= 4
      ) {
        await destination.discard();
        throw new Error("EXPORT_UNAVAILABLE");
      }
      const capability = randomUUID();
      this.entries.set(capability, {
        kind,
        owner,
        expires: this.now() + 60_000,
        destination,
      });
      this.changed();
      return capability;
    });
  }

  write(
    capability: string,
    owner: string,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    const entry = this.entries.get(capability);
    if (!entry || entry.owner.id !== owner)
      return Promise.reject(new Error("EXPORT_UNAVAILABLE"));
    return this.runOwned(entry.owner, signal, async (signal) => {
      this.entries.delete(capability);
      this.changed();
      let committed = false;
      try {
        if (
          this.closed ||
          entry.expires <= this.now() ||
          !entry.owner.current() ||
          bytes.length < 1 ||
          bytes.length > 8 * 1024 ** 2
        )
          throw new Error("EXPORT_UNAVAILABLE");
        for (let offset = 0; offset < bytes.length; offset += 1024 ** 2) {
          signal.throwIfAborted();
          if (!entry.owner.current()) throw new Error("EXPORT_UNAVAILABLE");
          await entry.destination.file.writeFile(
            bytes.subarray(offset, offset + 1024 ** 2),
          );
        }
        await entry.destination.file.sync();
        signal.throwIfAborted();
        await entry.destination.commit();
        committed = true;
      } finally {
        if (!committed) await entry.destination.discard();
      }
    }).catch(async () => {
      await entry.destination.discard();
      if (this.entries.get(capability) === entry)
        this.entries.delete(capability);
      this.changed();
      throw new Error("EXPORT_UNAVAILABLE");
    });
  }
  /** Confirmation consumes the permission before waiting for a benchmark drain.
   * Once claimed, the descriptor stays valid beyond the unused-grant deadline. */
  async claim(
    capability: string,
    owner: string,
    kind: "audio" | "report",
    signal: AbortSignal,
  ): Promise<{
    write(
      writer: (
        file: FileHandle,
        signal: AbortSignal,
        current: () => void,
      ) => Promise<void>,
      signal: AbortSignal,
    ): Promise<void>;
    release(): Promise<void>;
  }> {
    const entry = this.entries.get(capability);
    signal.throwIfAborted();
    if (!entry || entry.owner.id !== owner || entry.kind !== kind)
      throw new Error("EXPORT_UNAVAILABLE");
    const state = this.stateFor(entry.owner);
    this.assertOwner(entry.owner, state);
    this.entries.delete(capability);
    this.changed();
    if (this.closed || entry.expires <= this.now() || !entry.owner.current()) {
      await entry.destination.discard();
      throw new Error("EXPORT_UNAVAILABLE");
    }
    const cancelled = new AbortController();
    let operation: Promise<void> | undefined,
      released = false,
      committed = false,
      releasePending: Promise<void> | undefined;
    const current = () => {
      if (this.closed || state.retired || released || !entry.owner.current())
        throw new Error("EXPORT_UNAVAILABLE");
    };
    const held = { owner, release: () => release() };
    const release = (): Promise<void> => {
      if (releasePending) return releasePending;
      releasePending = (async () => {
        released = true;
        cancelled.abort(new Error("EXPORT_UNAVAILABLE"));
        await operation?.catch(() => {});
        if (!committed) await entry.destination.discard();
        this.claimed.delete(held);
        this.changed();
      })().finally(() => {
        releasePending = undefined;
      });
      return releasePending;
    };
    this.claimed.add(held);
    this.changed();
    return {
      write: (writer, writeSignal) => {
        if (operation || released)
          return Promise.reject(new Error("EXPORT_UNAVAILABLE"));
        operation = this.runOwned(
          entry.owner,
          writeSignal,
          async (ownedSignal) => {
            const combined = AbortSignal.any([
              signal,
              ownedSignal,
              cancelled.signal,
              this.abort.signal,
            ]);
            try {
              current();
              combined.throwIfAborted();
              await writer(entry.destination.file, combined, current);
              current();
              combined.throwIfAborted();
              await entry.destination.file.sync();
              current();
              combined.throwIfAborted();
              await entry.destination.commit();
              committed = true;
            } catch (error) {
              await entry.destination.discard();
              throw error;
            }
          },
        );
        return operation;
      },
      release,
    };
  }

  private async expire(owner: string): Promise<void> {
    const expiring: Promise<unknown>[] = [];
    for (const [capability, entry] of this.entries) {
      if (entry.owner.id !== owner) continue;
      if (entry.expires > this.now() && entry.owner.current()) continue;
      expiring.push(
        entry.destination.discard().then(() => {
          if (this.entries.get(capability) === entry)
            this.entries.delete(capability);
          this.changed();
        }),
      );
    }
    // A foreign owner's retained failed cleanup cannot consume new consent.
    await Promise.allSettled(expiring);
  }
  revokeOwner(owner: string): Promise<void> {
    const state = this.state(owner);
    state.retired = true;
    state.abort.abort(new Error("EXPORT_UNAVAILABLE"));
    for (const [key, entry] of this.receipts)
      if (entry.owner.id === owner) this.receipts.delete(key);
    if (state.retirement) return state.retirement;
    state.retirement = (async () => {
      while (state.work.size) await Promise.allSettled(state.work);
      // Cleanup callbacks do not enter the owner work set, so finally cannot
      // await itself. Every exact resource remains until positive acknowledgement.
      const results = await Promise.allSettled(
        [...state.resources]
          .map((cleanup) => cleanup())
          .concat(
            [...this.claimed]
              .filter((entry) => entry.owner === owner)
              .map((entry) => entry.release()),
          ),
      );
      for (const [capability, entry] of this.entries)
        if (
          entry.owner.id === owner &&
          !state.resources.has(this.destinationCleanup.get(entry.destination)!)
        )
          this.entries.delete(capability);
      if (
        results.some((result) => result.status === "rejected") ||
        state.resources.size ||
        [...this.claimed].some((entry) => entry.owner === owner)
      )
        throw new Error("EXPORT_UNAVAILABLE");
    })().finally(() => {
      state.retirement = undefined;
      this.collectOwner(owner, state);
      this.changed();
    });
    this.changed();
    return state.retirement;
  }
  async revoke(capability: string, owner: string): Promise<void> {
    const entry = this.entries.get(capability);
    if (!entry || entry.owner.id !== owner) return;
    await entry.destination.discard();
    this.entries.delete(capability);
    this.changed();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort(new Error("EXPORT_UNAVAILABLE"));
    this.receipts.clear();
    await this.operations.close();
    const results = await Promise.allSettled(
      [...this.owners.keys()].map((owner) => this.revokeOwner(owner)),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("EXPORT_UNAVAILABLE");
    this.changed();
    this.listeners.clear();
  }
}
