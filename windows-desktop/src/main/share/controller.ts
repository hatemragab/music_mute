import { randomUUID } from "node:crypto";
import type {
  ConsumerAccountAppPin,
  ConsumerNativeEvent,
  ConsumerProcessIdentity,
  ConsumerShareReceipt,
  ConsumerShareSource,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  shareReceiptAllowsCleanup,
  sameConsumerProcess,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { LibraryPlaybackPort } from "../library/playback.js";
import {
  exportLibraryTrack,
  type LibraryExportDestination,
} from "../library/export.js";
import { StoreShareNative } from "./store-share-native.js";

export interface ShareWorkspace {
  directory: string;
  relativePath: string;
  createFile(
    extension: string,
  ): Promise<
    NonNullable<Awaited<ReturnType<LibraryExportDestination["choose"]>>>
  >;
  seal(): Promise<{ relativePath: string; sha256: string; bytes: number }>;
  handoff(helper: ConsumerProcessIdentity): Promise<void>;
  settle(receipt: ConsumerShareReceipt): Promise<void>;
  discardBeforeHandoff(): Promise<void>;
  retain(): Promise<void>;
  /** Explicit trusted journal state; absent is conservatively treated as native pending. */
  nativePending?(): boolean;
}
export interface ShareNativePort {
  identity(): Promise<ConsumerProcessIdentity>;
  startShare(
    source: ConsumerShareSource,
    pin: ConsumerAccountAppPin,
  ): Promise<ConsumerShareReceipt>;
  inspectShare(requestId: string): Promise<ConsumerShareReceipt | null>;
  cancelShare(
    lease: Pick<ConsumerShareReceipt, "requestId" | "nonce">,
  ): Promise<ConsumerShareReceipt>;
  acknowledgeShareCleanup(
    receipt: Pick<ConsumerShareReceipt, "requestId" | "nonce">,
  ): Promise<boolean>;
  pruneCompletedShareReceipts(): Promise<{ removed: number; retained: number }>;
  onEvent(listener: (event: ConsumerNativeEvent) => void): () => void;
  onClosed(listener: () => void): () => void;
  close(): Promise<void>;
}
interface LibraryShareCommon {
  playback: LibraryPlaybackPort;
  workspace(
    requestId: string,
    copyBytes: number,
    signal: AbortSignal,
  ): Promise<ShareWorkspace>;
  /** Main supplies the actual HWND bytes and consuming Electron PID/birth. */
  window(): {
    handle: string;
    owner: ConsumerProcessIdentity;
    assertCurrent(): void;
  };
  assertScopeCurrent(scope: SessionAccountScope | null): void;
  /** Account/window changes fence native delivery immediately; no renderer identities. */
  subscribeInvalidation(
    scope: SessionAccountScope | null,
    owner: ConsumerProcessIdentity,
    listener: () => void,
  ): () => void;
  consumersAllowed(): boolean;
  /** Production supplies the persistent storage journal, never directory-name guesses. */
  recovery?: {
    pending(): Promise<string[]>;
    restore(requestId: string, signal: AbortSignal): Promise<ShareWorkspace>;
  };
  /** Only injected code fixtures shorten the production five-minute wait. */
  waitMs?: number;
}
export type LibraryShareOptions = LibraryShareCommon &
  (
    | {
        distribution?: "legacy";
        openNative(): Promise<ShareNativePort>;
        appPin: ConsumerAccountAppPin;
      }
    | {
        distribution: "microsoft-store";
        openNative(): Promise<StoreShareNative>;
        appPin?: never;
      }
  );
type SharingNative = ShareNativePort | StoreShareNative;
interface ActiveShare {
  native: SharingNative;
  workspace: ShareWorkspace;
  receipt?: ConsumerShareReceipt;
  handedOff: boolean;
  done: Promise<void>;
  finish: () => void;
  stops: (() => void)[];
  settling: Promise<void> | undefined;
}
export interface LibraryShareResult {
  requestId: string;
  state: "completed" | "cancelled" | "pending";
}

/** Pinned cached media can be shared without a model, runtime, GPU or comparison map. */
export class LibraryShareController {
  private async openNative(): Promise<SharingNative> {
    const native = await this.options.openNative();
    if (
      (this.options.distribution === "microsoft-store") !==
      native instanceof StoreShareNative
    ) {
      await native.close();
      throw Error("SHARE_NATIVE_REQUIRED");
    }
    return native;
  }
  private readonly active = new Map<string, ActiveShare>();
  private accepting = true;
  private staging = 0;
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Set<Promise<LibraryShareResult>>();
  private readonly shutdown = new AbortController();
  private disposing: Promise<void> | undefined;
  constructor(private readonly options: LibraryShareOptions) {}
  activity(): { requests: number; staging: number; idle: boolean } {
    return {
      requests: this.active.size,
      staging: this.staging,
      idle: this.active.size === 0 && this.staging === 0,
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners)
      try {
        listener();
      } catch {
        /* observation is not cleanup authority */
      }
  }
  async recover(signal: AbortSignal): Promise<LibraryShareResult[]> {
    const results: LibraryShareResult[] = [];
    if (!this.options.recovery) return results;
    for (const requestId of await this.options.recovery.pending()) {
      signal.throwIfAborted();
      if (this.active.has(requestId)) continue;
      const workspace = await this.options.recovery.restore(requestId, signal);
      if (workspace.nativePending?.() === false) {
        await workspace.discardBeforeHandoff();
        continue;
      }
      const native = await this.openNative();
      let finished = false;
      try {
        const receipt = await native.inspectShare(requestId);
        if (receipt && shareReceiptAllowsCleanup(receipt)) {
          await workspace.settle(receipt);
          await native.acknowledgeShareCleanup(receipt).catch(() => false);
          results.push({
            requestId,
            state: receipt.state as "completed" | "cancelled",
          });
          finished = true;
        } else {
          await workspace.retain();
          let finish!: () => void;
          const done = new Promise<void>((resolve) => {
            finish = resolve;
          });
          this.active.set(requestId, {
            native,
            workspace,
            ...(receipt ? { receipt } : {}),
            handedOff: true,
            done,
            finish,
            stops: [],
            settling: undefined,
          });
          results.push({ requestId, state: "pending" });
          this.changed();
        }
      } catch (error) {
        await workspace.retain();
        await native.close();
        throw error;
      }
      if (finished) await native.close();
    }
    // The journal row may already be gone when a cleanup ACK was lost. This
    // fixed bounded native sweep removes only completed/quiesced absent copies.
    const cleanup = await this.openNative();
    try {
      await cleanup.pruneCompletedShareReceipts();
    } finally {
      await cleanup.close();
    }
    return results;
  }
  share(
    trackId: string,
    variant: "voice" | "original",
    scope: SessionAccountScope | null,
    signal: AbortSignal,
  ): Promise<LibraryShareResult> {
    const operation = this.performShare(
      trackId,
      variant,
      scope,
      AbortSignal.any([signal, this.shutdown.signal]),
    );
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }
  private async performShare(
    trackId: string,
    variant: "voice" | "original",
    scope: SessionAccountScope | null,
    signal: AbortSignal,
  ): Promise<LibraryShareResult> {
    if (
      !this.accepting ||
      !this.options.consumersAllowed() ||
      this.active.size + this.staging >= 16
    )
      throw new Error("SHARE_BUSY");
    if (!trackId || (variant !== "voice" && variant !== "original"))
      throw new Error("LIBRARY_RESULT_INVALID");
    ++this.staging;
    this.changed();
    const requestId = randomUUID();
    let native: SharingNative | undefined,
      workspace: ShareWorkspace | undefined,
      row: ActiveShare | undefined;
    let releasePin: (() => Promise<void>) | undefined;
    try {
      signal.throwIfAborted();
      this.options.assertScopeCurrent(scope);
      const window = this.options.window();
      window.assertCurrent();
      const pin = await this.options.playback.pin(trackId, variant, scope);
      releasePin = () => pin.release();
      const artifact = await this.options.playback.resolvePlayback(
        trackId,
        variant,
        scope,
        signal,
      );
      if (
        pin.artifactId !== artifact.artifactId ||
        pin.relativePath !== artifact.relativePath ||
        pin.sha256 !== artifact.sha256 ||
        artifact.bytes < 1 ||
        artifact.bytes > 256 * 1024 ** 2
      )
        throw new Error("LIBRARY_RESULT_CHANGED");
      workspace = await this.options.workspace(
        requestId,
        artifact.bytes,
        signal,
      );
      const copied = await exportLibraryTrack({
        playback: this.options.playback,
        trackId,
        variant,
        scope,
        signal,
        destination: {
          choose: async (name, mime) => {
            if (mime !== artifact.mime)
              throw new Error("LIBRARY_RESULT_CHANGED");
            return workspace!.createFile(name.split(".").at(-1)!);
          },
        },
      });
      if (!copied) throw new Error("CANCELLED");
      const sealed = await workspace.seal();
      if (sealed.sha256 !== artifact.sha256 || sealed.bytes !== artifact.bytes)
        throw new Error("LIBRARY_RESULT_CHANGED");
      await artifact.current();
      this.options.assertScopeCurrent(scope);
      window.assertCurrent();
      signal.throwIfAborted();
      if (!this.accepting || !this.options.consumersAllowed())
        throw new Error("SHARE_BUSY");
      if (!this.accepting || !this.options.consumersAllowed())
        throw new Error("SHARE_BUSY");
      native = await this.openNative();
      const helper = await native.identity();
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      row = {
        native,
        workspace,
        handedOff: false,
        done,
        finish,
        stops: [],
        settling: undefined,
      };
      this.active.set(requestId, row);
      const current = row;
      const inspect = async (receipt: ConsumerShareReceipt) => {
        if (
          receipt.requestId !== requestId ||
          receipt.relativePath !== sealed.relativePath ||
          receipt.sha256 !== sealed.sha256 ||
          receipt.bytes !== sealed.bytes ||
          !sameConsumerProcess(receipt.helper, helper) ||
          !sameConsumerProcess(receipt.windowOwner, window.owner)
        )
          throw new Error("SHARE_RECEIPT_INVALID");
        if (current.receipt && current.receipt.nonce !== receipt.nonce)
          throw new Error("SHARE_RECEIPT_INVALID");
        if (
          current.receipt &&
          ["completed", "cancelled"].includes(current.receipt.state) &&
          current.receipt.state !== receipt.state
        )
          return;
        if (
          current.receipt &&
          shareReceiptAllowsCleanup(current.receipt) &&
          !shareReceiptAllowsCleanup(receipt)
        )
          return;
        current.receipt = receipt;
        if (!shareReceiptAllowsCleanup(receipt) || current.settling) return;
        current.settling = (async () => {
          const verified = await current.native.inspectShare(requestId);
          if (
            !verified ||
            JSON.stringify(verified) !== JSON.stringify(receipt) ||
            !shareReceiptAllowsCleanup(verified)
          )
            throw new Error("SHARE_RECEIPT_INVALID");
          await current.workspace.settle(verified);
          await current.native
            .acknowledgeShareCleanup(verified)
            .catch(() => false);
          current.finish();
          this.active.delete(requestId);
          this.changed();
          for (const stop of current.stops) stop();
          await current.native.close();
        })();
        try {
          await current.settling;
        } catch {
          current.settling = undefined;
          await current.workspace.retain();
        }
      };
      row.stops.push(
        native.onEvent((event) => {
          if (event.kind === "share" && event.receipt.requestId === requestId)
            void inspect(event.receipt).catch(() => workspace!.retain());
        }),
      );
      row.stops.push(
        native.onClosed(() => {
          void workspace!.retain();
          current.finish();
        }),
      );
      let invalidated = false;
      const fence = () => {
        invalidated = true;
        if (current.receipt)
          void current.native
            .cancelShare(current.receipt)
            .catch(() => current.workspace.retain());
      };
      row.stops.push(
        this.options.subscribeInvalidation(scope, window.owner, fence),
      );
      signal.addEventListener("abort", fence, { once: true });
      row.stops.push(() => signal.removeEventListener("abort", fence));
      // Durable nativePending is written before any operation can expose the copy.
      await workspace.handoff(helper);
      row.handedOff = true;
      await artifact.current();
      this.options.assertScopeCurrent(scope);
      window.assertCurrent();
      signal.throwIfAborted();
      const title =
        [...artifact.title.replace(/[\p{Cc}\p{Cf}]/gu, " ")]
          .reduce(
            (value, c) =>
              Buffer.byteLength(value + c, "utf8") <= 180 ? value + c : value,
            "",
          )
          .trim() || "MusicMute audio";
      const shareSource: ConsumerShareSource = {
        requestId,
        windowHandle: window.handle,
        windowOwner: window.owner,
        ...sealed,
        title,
        mime: artifact.mime,
      };
      if (this.options.distribution === "microsoft-store") {
        if (!(native instanceof StoreShareNative))
          throw Error("SHARE_NATIVE_REQUIRED");
        await inspect(
          await StoreShareNative.prototype.startShare.call(native, shareSource),
        );
      } else {
        if (native instanceof StoreShareNative)
          throw Error("SHARE_NATIVE_REQUIRED");
        await inspect(
          await native.startShare(shareSource, this.options.appPin),
        );
      }
      if (invalidated || signal.aborted) fence();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          row.done,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, this.options.waitMs ?? 300000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (
        !this.active.has(requestId) &&
        row.receipt &&
        shareReceiptAllowsCleanup(row.receipt)
      )
        return {
          requestId,
          state: row.receipt.state as "completed" | "cancelled",
        };
      await workspace.retain();
      return { requestId, state: "pending" };
    } catch (error) {
      if (row?.handedOff) {
        await workspace?.retain();
        const known = await native?.inspectShare(requestId).catch(() => null);
        if (known) {
          row.receipt = known;
          await native?.cancelShare(known).catch(() => workspace?.retain());
        }
      } else {
        if (row) {
          for (const stop of row.stops) stop();
          this.active.delete(requestId);
        }
        await workspace?.discardBeforeHandoff();
        await native?.close();
      }
      throw error;
    } finally {
      try {
        await releasePin?.();
      } finally {
        --this.staging;
        this.changed();
      }
    }
  }
  /** Closing the app may retain uncertain requests; it never turns them into cancellation proof. */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.accepting = false;
    this.shutdown.abort();
    this.disposing = this.finishDisposal();
    return this.disposing;
  }
  private async finishDisposal(): Promise<void> {
    for (const row of this.active.values()) {
      for (const stop of row.stops) stop();
      if (row.receipt)
        await row.native.cancelShare(row.receipt).catch(() => {});
      await row.workspace.retain();
      await row.native.close();
      row.finish();
    }
    await Promise.allSettled(this.operations);
    this.listeners.clear();
  }
}
