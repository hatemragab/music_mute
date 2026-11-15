import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import {
  StoreNativeAuthority,
  storeAuthorityForDataNative,
} from "../browser/store-native.js";
import { StorePreparationOperations } from "./store-operations.js";
import { StorePersonalRuntime } from "../personal/store-runtime.js";
import { StoreMediaExecution } from "../session/store-media-runner.js";
import { StoreGuiMediaExecution } from "../session/store-gui-media.js";
import { StoreSessionClient } from "../session/store-session-client.js";
import {
  parseStoreMediaRequest,
  type StoreMediaConfiguration,
} from "../../shared/store-media-request.js";

const TOKEN = Symbol("store-media-tools");
function denied(): never {
  throw new Error("MEDIA_TOOLS_REQUIRED");
}
/** Protected-code observations and actual runtime delegation. Paths/pins in
 * this view confer no execution grant; genuine fixed factories own children. */
export class StoreMediaTools {
  #host: HostContext;
  #operations: StorePreparationOperations | undefined;
  #personal: StorePersonalRuntime | undefined;
  #authority: StoreNativeAuthority | undefined;
  private constructor(
    token: symbol,
    host: HostContext,
    source:
      | {
          operations: StorePreparationOperations;
          authority: StoreNativeAuthority;
        }
      | { personal: StorePersonalRuntime },
  ) {
    if (token !== TOKEN) denied();
    this.#host = host;
    if ("operations" in source) {
      this.#operations = source.operations;
      this.#authority = source.authority;
    } else this.#personal = source.personal;
    Object.freeze(this);
  }
  static open(host: HostContext, operations: StorePreparationOperations) {
    if (arguments.length !== 2) denied();
    const authority = host.storeAuthority;
    if (!authority || storeAuthorityForDataNative(host.native) !== authority)
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(authority);
    StorePreparationOperations.prototype.assertHost.call(operations, host);
    // Worker acquisition remains lazy, so account/Library initialization does
    // not depend on installing or activating the processing package.
    return new StoreMediaTools(TOKEN, host, { operations, authority });
  }
  static forPersonal(host: HostContext, runtime: StorePersonalRuntime) {
    if (arguments.length !== 2) denied();
    StorePersonalRuntime.prototype.assertConfiguration.call(
      runtime,
      host,
      runtime.configuration,
    );
    return new StoreMediaTools(TOKEN, host, { personal: runtime });
  }
  assertHost(host: HostContext): void {
    if (arguments.length !== 1 || host !== this.#host) denied();
    if (this.#personal) {
      StorePersonalRuntime.prototype.assertConfiguration.call(
        this.#personal,
        host,
        this.#personal.configuration,
      );
    } else {
      if (
        !this.#authority ||
        host.storeAuthority !== this.#authority ||
        storeAuthorityForDataNative(host.native) !== this.#authority
      )
        denied();
      StoreNativeAuthority.prototype.creatorProof.call(this.#authority);
      StorePreparationOperations.prototype.assertHost.call(
        this.#operations!,
        host,
      );
    }
  }
  async snapshotMediaTools(signal: AbortSignal) {
    if (arguments.length !== 1 || !(signal instanceof AbortSignal)) denied();
    this.assertHost(this.#host);
    signal.throwIfAborted();
    const view = this.#personal
      ? await StorePersonalRuntime.prototype.mediaCodeView.call(
          this.#personal,
          signal,
        )
      : await StorePreparationOperations.prototype.mediaCodeView.call(
          this.#operations!,
          signal,
        );
    this.assertHost(this.#host);
    const helper = view.manifest.entries.find(
      (entry) => entry.path === "runtime/native/musicmute-native.exe",
    );
    if (
      view.binding.sid !== this.#host.identity.sid ||
      !helper ||
      helper.kind !== "file" ||
      helper.bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(helper.sha256) ||
      !/^[a-f0-9]{64}$/u.test(view.binding.inventorySha256) ||
      !/^[a-f0-9]{64}$/u.test(view.binding.runtimeManifestSha256) ||
      view.workerRoot.toLowerCase() !==
        win32
          .join(view.binding.package.installedLocation, "worker")
          .toLowerCase()
    )
      denied();
    signal.throwIfAborted();
    return Object.freeze({
      distribution: "microsoft-store" as const,
      releaseIdentity: view.binding.inventorySha256,
      releaseRoot: view.workerRoot,
      manifestSha256: view.binding.runtimeManifestSha256,
      nativeSha256: helper.sha256,
      ffmpegPath: win32.join(view.workerRoot, "runtime", "bin", "ffmpeg.exe"),
      ffprobePath: win32.join(view.workerRoot, "runtime", "bin", "ffprobe.exe"),
    });
  }
  async session(signal: AbortSignal) {
    if (arguments.length !== 1 || !(signal instanceof AbortSignal)) denied();
    this.assertHost(this.#host);
    if (!this.#operations || this.#personal) denied();
    const session =
      await StorePreparationOperations.prototype.maintenanceSession.call(
        this.#operations,
        signal,
      );
    this.assertHost(this.#host);
    return session;
  }
  async runMedia(
    configuration: StoreMediaConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    if (arguments.length !== 2 || !(signal instanceof AbortSignal)) denied();
    this.assertHost(this.#host);
    signal.throwIfAborted();
    if (!this.#personal) denied();
    await StorePersonalRuntime.prototype.runMedia.call(
      this.#personal,
      configuration,
      signal,
    );
    this.assertHost(this.#host);
    signal.throwIfAborted();
  }
  /** The original CPU owner is returned before its preparation or tool IO so
   * workspace callbacks can retain that exact capability through uncertainty. */
  async openMedia(
    configuration: unknown,
  ): Promise<StoreMediaExecution | StoreGuiMediaExecution> {
    if (arguments.length !== 1) denied();
    this.assertHost(this.#host);
    if (
      !configuration ||
      typeof configuration !== "object" ||
      Object.getPrototypeOf(configuration) !== Object.prototype ||
      Object.values(Object.getOwnPropertyDescriptors(configuration)).some(
        (descriptor) => !descriptor.enumerable || !("value" in descriptor),
      )
    )
      denied();
    const requestId = Object.getOwnPropertyDescriptor(
        configuration,
        "requestId",
      )?.value,
      view = this.#personal
        ? await StorePersonalRuntime.prototype.mediaCodeView.call(
            this.#personal,
            new AbortController().signal,
          )
        : await StorePreparationOperations.prototype.mediaCodeView.call(
            this.#operations!,
            new AbortController().signal,
          ),
      request = parseStoreMediaRequest(
        Buffer.from(
          JSON.stringify({
            version: 1,
            requestId,
            binding: view.binding,
            configuration,
          }),
        ),
      );
    this.assertHost(this.#host);
    const execution = this.#personal
      ? await StorePersonalRuntime.prototype.openMedia.call(
          this.#personal,
          request.configuration,
        )
      : await StoreSessionClient.prototype.openMedia.call(
          await this.session(new AbortController().signal),
          request.configuration,
        );
    try {
      this.assertHost(this.#host);
    } catch (error) {
      try {
        if (execution instanceof StoreMediaExecution)
          await StoreMediaExecution.prototype.close.call(execution);
        else if (execution instanceof StoreGuiMediaExecution)
          await StoreGuiMediaExecution.prototype.close.call(execution);
        else denied();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "STORE_MEDIA_CLEANUP_UNCONFIRMED",
        );
      }
      throw error;
    }
    return execution;
  }
}
