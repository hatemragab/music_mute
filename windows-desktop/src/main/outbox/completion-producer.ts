import { readdir } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type { LibraryStore } from "../library/store.js";
import type { LibraryArtifactCache } from "../library/artifacts.js";
import type { LibraryPins } from "../library/pins.js";
import { PERSONAL_UUID } from "../../shared/personal-contracts.js";
import { readPrivateBytes } from "../prepare/private-files.js";
import { parsePersonalPair, type VerifiedPersonalPair } from "../reuse/pair.js";
import type { OutboxController } from "./controller.js";
export interface CompletionSource {
  read(signal: AbortSignal): Promise<VerifiedPersonalPair[]>;
}
export class WindowsPersonalCompletionSource implements CompletionSource {
  constructor(
    private readonly host: HostContext,
    private readonly invalid: (code: string) => void = () => {},
  ) {}
  async read(signal: AbortSignal): Promise<VerifiedPersonalPair[]> {
    const root = "personal\\results";
    await this.host.directory(root);
    await this.host.native.validatePath("personal", root, "directory");
    const names = await readdir(win32.join(this.host.personalRoot, root));
    if (names.length > 8192) throw new Error("PERSONAL_COMPLETION_LIMIT");
    const result: VerifiedPersonalPair[] = [];
    for (const name of names) {
      signal.throwIfAborted();
      if (!PERSONAL_UUID.test(name)) continue;
      try {
        await this.host.native.validatePath(
          "personal",
          `${root}\\${name}`,
          "directory",
        );
        const value = JSON.parse(
          (
            await readPrivateBytes(
              this.host,
              `${root}\\${name}\\pair.json`,
              32768,
            )
          ).toString("utf8"),
        );
        result.push(
          parsePersonalPair(value, this.host.report.installationId, name),
        );
      } catch (error) {
        signal.throwIfAborted();
        this.invalid(
          error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message)
            ? error.message
            : "PERSONAL_COMPLETION_INVALID",
        );
      }
    }
    return result;
  }
}
/** Startup/directory events recover the original capture; a current account never supplies missing ownership. */
export class PersonalCompletionProducer {
  private active: Promise<void> | null = null;
  private again = false;
  private lifetime = new AbortController();
  private readonly activityListeners = new Set<() => void>();
  constructor(
    private readonly options: {
      source: CompletionSource;
      store: Pick<LibraryStore, "rememberPersonal">;
      cache: Pick<LibraryArtifactCache, "local" | "verify">;
      pins: Pick<LibraryPins, "pin">;
      outbox: Pick<OutboxController, "stageCaptured">;
      scope(): AccountSessionScope | null;
      assertScope(scope: AccountSessionScope): void;
      onVerifiedPair?(pair: VerifiedPersonalPair): Promise<void>;
      onError?(code: string): void;
      consumersAllowed?(): boolean;
    },
  ) {}
  activity(): {
    pending: 0 | 1;
    queued: 0 | 1;
    accepting: boolean;
    idle: boolean;
  } {
    return {
      pending: this.active ? 1 : 0,
      queued: this.again && !this.lifetime.signal.aborted ? 1 : 0,
      accepting: !this.lifetime.signal.aborted && this.intakeAllowed(),
      idle: this.active === null,
    };
  }
  subscribeActivity(listener: () => void): () => void {
    this.activityListeners.add(listener);
    try {
      listener();
    } catch {
      /* Observers do not own processing or disposal. */
    }
    return () => {
      this.activityListeners.delete(listener);
    };
  }
  private activityChanged(): void {
    for (const listener of this.activityListeners) {
      try {
        listener();
      } catch {
        /* Isolate lifecycle observers. */
      }
    }
  }
  reconcile(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.active) {
      this.again = true;
      this.activityChanged();
      return this.active;
    }
    if (!this.intakeAllowed()) {
      this.again = true;
      this.activityChanged();
      return Promise.resolve();
    }
    this.again = false;
    this.active = this.run()
      .catch((error) => {
        if (!this.lifetime.signal.aborted)
          this.options.onError?.(
            error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message)
              ? error.message
              : "PERSONAL_COMPLETION_FAILED",
          );
        throw error;
      })
      .finally(() => {
        this.active = null;
        if (
          this.again &&
          !this.lifetime.signal.aborted &&
          this.intakeAllowed()
        ) {
          this.again = false;
          void this.reconcile().catch(() => {});
        } else {
          if (this.lifetime.signal.aborted) this.again = false;
          this.activityChanged();
        }
      });
    this.activityChanged();
    return this.active;
  }
  private intakeAllowed(): boolean {
    return this.options.consumersAllowed?.() ?? true;
  }
  resume(): Promise<void> {
    return this.reconcile();
  }
  private async run(): Promise<void> {
    const signal = this.lifetime.signal;
    for (const pair of await this.options.source.read(signal)) {
      if (!this.intakeAllowed()) {
        this.again = true;
        return;
      }
      const pins: Awaited<ReturnType<LibraryPins["pin"]>>[] = [];
      try {
        for (const kind of ["original", "vocals"] as const) {
          const artifact = await this.options.cache.local(
            pair.entry.personalJobId,
            pair.entry[kind],
            kind === "vocals" ? "voice" : "original",
          );
          const pin = await this.options.pins.pin(artifact, "outbox");
          pins.push(pin);
          if (
            pin.artifactId !== artifact.artifactId ||
            pin.relativePath !== artifact.relativePath ||
            pin.sha256 !== artifact.sha256
          )
            throw new Error("OUTBOX_PIN_INVALID");
          await this.options.cache.verify(artifact, signal);
        }
        signal.throwIfAborted();
        // Guest catalog is the Windows user's local authority even if the app was closed at completion.
        await this.options.store.rememberPersonal(
          pair.view,
          null,
          pair.timeline,
        );
        if (!this.intakeAllowed()) {
          this.again = true;
          return;
        }
        // Optional public publication cannot prevent durable account capture.
        try {
          await this.options.onVerifiedPair?.(structuredClone(pair));
        } catch (error) {
          this.options.onError?.(
            error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message)
              ? error.message
              : "COMMUNITY_PUBLICATION_FAILED",
          );
        }
        // Publication/first-play may remain admitted through shutdown. Await
        // their actual settlement, then refuse a new account-capture operation.
        signal.throwIfAborted();
        const captured = pair.completion?.capturedAccountScope,
          current = this.options.scope();
        if (!this.intakeAllowed()) {
          this.again = true;
          return;
        }
        if (
          !pair.reuse ||
          !captured ||
          !current ||
          captured.firebaseUid !== current.firebaseUid
        )
          continue;
        this.options.assertScope(current);
        await this.options.outbox.stageCaptured(
          pair.entry,
          pair.completion!,
          current,
        );
        this.options.assertScope(current);
      } catch (error) {
        if (signal.aborted) throw error;
        const code =
          error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message)
            ? error.message
            : "PERSONAL_COMPLETION_FAILED";
        this.options.onError?.(code);
      } finally {
        await Promise.allSettled(pins.map((pin) => pin.release()));
      }
    }
  }
  async dispose(): Promise<void> {
    this.lifetime.abort();
    this.again = false;
    this.activityChanged();
    await this.active?.catch(() => {});
    this.activityListeners.clear();
  }
}
