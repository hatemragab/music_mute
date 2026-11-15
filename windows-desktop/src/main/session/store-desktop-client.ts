import type { HostContext, HostNativePort } from "../host-context.js";
import { StorePreparationOperations } from "../prepare/store-operations.js";
import {
  StoreNativeAuthority,
  storeAuthorityForDataNative,
} from "../browser/store-native.js";
import {
  StoreSessionClient,
  StoreDesktopControlLifetime,
} from "./store-session-client.js";

const TOKEN = Symbol("actual-store-desktop-connection");
function denied(): never {
  throw new Error("STORE_DESKTOP_CONNECTION_DENIED");
}
/** The GUI owns its scoped requests/watches only. Prepare keeps the original
 * code/client, and the independent Worker retains its Session/roles/GPU. */
export class StoreDesktopConnection {
  readonly client: StoreDesktopControlLifetime;
  readonly native: HostNativePort;
  #closing: Promise<void> | undefined;
  #closeFailed = false;
  #recovered = false;
  #host: HostContext;
  #operations: StorePreparationOperations;
  #authority: StoreNativeAuthority;
  private constructor(
    token: symbol,
    client: StoreDesktopControlLifetime,
    host: HostContext,
    operations: StorePreparationOperations,
    authority: StoreNativeAuthority,
  ) {
    if (token !== TOKEN) denied();
    StoreDesktopControlLifetime.prototype.currentAuthority.call(client);
    this.client = client;
    this.native = host.native;
    this.#host = host;
    this.#operations = operations;
    this.#authority = authority;
    Object.freeze(this);
  }
  static async open(
    host: HostContext,
    operations: StorePreparationOperations,
    launchIfAbsent: boolean,
    signal: AbortSignal,
  ): Promise<StoreDesktopConnection | undefined> {
    if (
      arguments.length !== 4 ||
      typeof launchIfAbsent !== "boolean" ||
      !(signal instanceof AbortSignal)
    )
      denied();
    const authority = host.storeAuthority;
    if (!authority || storeAuthorityForDataNative(host.native) !== authority)
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(authority);
    StorePreparationOperations.prototype.assertHost.call(operations, host);
    const original =
      await StorePreparationOperations.prototype.controlSession.call(
        operations,
        signal,
        { launchIfAbsent },
      );
    signal.throwIfAborted();
    StorePreparationOperations.prototype.assertHost.call(operations, host);
    StoreNativeAuthority.prototype.creatorProof.call(authority);
    if (!original) return undefined; // Actual passive absence only.
    const scope =
      StoreSessionClient.prototype.openDesktopLifetime.call(original);
    try {
      const peer =
          StoreDesktopControlLifetime.prototype.personalPeer.call(scope),
        gui = StoreNativeAuthority.prototype.creatorProof.call(authority).gui;
      if (
        peer.pid !== gui.pid ||
        peer.creationTime !== gui.creationTime ||
        peer.sid !== gui.sid ||
        peer.sessionId !== gui.sessionId
      )
        denied();
      return new StoreDesktopConnection(
        TOKEN,
        scope,
        host,
        operations,
        authority,
      );
    } catch (error) {
      await StoreDesktopControlLifetime.prototype.close.call(scope);
      throw error;
    }
  }
  cleanupPending(): boolean {
    return this.#closeFailed;
  }
  assertHost(host: HostContext, operations: StorePreparationOperations): void {
    if (
      arguments.length !== 2 ||
      host !== this.#host ||
      operations !== this.#operations ||
      this.#closing ||
      this.#recovered ||
      host.storeAuthority !== this.#authority ||
      storeAuthorityForDataNative(host.native) !== this.#authority
    )
      denied();
    StorePreparationOperations.prototype.assertHost.call(operations, host);
    StoreNativeAuthority.prototype.creatorProof.call(this.#authority);
    StoreDesktopControlLifetime.prototype.currentAuthority.call(this.client);
  }
  close(): Promise<void> {
    if (arguments.length !== 0) denied();
    if (this.#recovered) return Promise.resolve();
    if (this.#closing) return this.#closing;
    return (this.#closing = StoreDesktopControlLifetime.prototype.close
      .call(this.client)
      .catch((error) => {
        this.#closeFailed = true;
        throw error;
      }));
  }
  async recoverClose(): Promise<void> {
    if (arguments.length !== 0 || !this.#closeFailed) denied();
    await StoreDesktopControlLifetime.prototype.recoverClose.call(this.client);
    this.#closeFailed = false;
    this.#recovered = true;
  }
}
