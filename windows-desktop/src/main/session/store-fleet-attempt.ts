import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import { StoreNodeIssuer } from "./store-node-issuer.js";
import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
import { sameConsumerProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import { storeCpuFields } from "../../shared/store-cpu-operation.js";
import {
  parseStoreFleetAttemptExpectation,
  parseStoreFleetAttemptState,
  type StoreFleetAttemptExpectation,
} from "../../shared/store-fleet-workspace.js";
const TOKEN = Symbol("store-fleet-attempt");
function deny(): never {
  throw new Error("STORE_FLEET_WORKSPACE_DENIED");
}

/** A real original Creator attempt. Its public expectation remains data;
 * only this retained issuer/native association may inspect or retire it. */
export class StoreFleetAttemptLease {
  #issuer: StoreNodeIssuer;
  #native: WindowsConsumerNative;
  #id: string;
  #extension: string;
  #expectation: StoreFleetAttemptExpectation | undefined;
  #paths: Readonly<{ root: string; input: string; output: string }> | undefined;
  #opening: Promise<void> | undefined;
  #openingRecovery: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #recovery: Promise<void> | undefined;
  #failures: Promise<void>[] = [];
  #retired = false;
  private constructor(
    token: symbol,
    issuer: StoreNodeIssuer,
    native: WindowsConsumerNative,
    id: string,
    extension: string,
  ) {
    if (token !== TOKEN || issuer.nodeRole !== "fleet") deny();
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    this.#issuer = issuer;
    this.#native = native;
    this.#id = id;
    this.#extension = extension;
    Object.freeze(this);
  }
  static create(
    issuer: StoreNodeIssuer,
    native: WindowsConsumerNative,
    id: string,
    extension: string,
  ): StoreFleetAttemptLease {
    if (
      arguments.length !== 4 ||
      typeof id !== "string" ||
      typeof extension !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        id,
      ) ||
      ![
        "aac",
        "flac",
        "m4a",
        "mp3",
        "ogg",
        "wav",
        "webm",
        "mp4",
        "bin",
      ].includes(extension)
    )
      deny();
    return new StoreFleetAttemptLease(TOKEN, issuer, native, id, extension);
  }
  matches(
    issuer: StoreNodeIssuer,
    native: object,
    id: string,
    extension: string,
  ): boolean {
    if (arguments.length !== 4 || issuer !== this.#issuer) deny();
    return (
      native === this.#native &&
      id === this.#id &&
      extension === this.#extension
    );
  }
  assertHost(host: HostContext): void {
    if (
      arguments.length !== 1 ||
      host.native !== this.#native ||
      host.identity.sid !== this.#issuer.owner.identity.sid ||
      host.identity.sessionId !== this.#issuer.owner.identity.sessionId
    )
      deny();
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, host.native);
  }
  prepare(): Promise<void> {
    if (arguments.length || this.#retired || this.#closing)
      return Promise.reject(new Error("STORE_FLEET_WORKSPACE_DENIED"));
    return (this.#opening ??= this.#open());
  }
  async #open(): Promise<void> {
    const value = await StoreNodeIssuer.prototype.fleetWorkspaceCommand.call(
        this.#issuer,
        this,
        "open",
      ),
      row = storeCpuFields(value, ["expectation", "root", "input", "output"]),
      expectation = parseStoreFleetAttemptExpectation(row.expectation),
      actual = this.#issuer.owner;
    if (
      expectation.attemptId !== this.#id ||
      expectation.inventorySha256 !== this.#issuer.inventorySha256 ||
      expectation.nodeOwner.nonce !== actual.nonce ||
      !sameConsumerProcess(expectation.nodeOwner.identity, actual.identity) ||
      (this.#expectation &&
        JSON.stringify(expectation) !== JSON.stringify(this.#expectation)) ||
      typeof row.root !== "string" ||
      typeof row.input !== "string" ||
      typeof row.output !== "string"
    )
      deny();
    this.#expectation = expectation;
    // Adopt the original native expectation before further IO. A later
    // identity/watch failure must still leave that exact owner reachable.
    const identity = await this.#native.identity(),
      root = win32.join(
        identity.localAppData,
        PACKAGE_DATA_ROOT_NAMES.fleet,
        "work",
        this.#id,
      );
    if (
      row.root !== root ||
      row.input !== win32.join(root, `input.${this.#extension}`) ||
      row.output !== win32.join(root, "output", "vocals.mp3")
    )
      deny();
    this.#paths = Object.freeze({
      root,
      input: row.input as string,
      output: row.output as string,
    });
  }
  recoverOpen(): Promise<void> {
    if (arguments.length || !this.#opening || this.#retired || this.#closing)
      return Promise.reject(new Error("STORE_FLEET_WORKSPACE_DENIED"));
    this.#openingRecovery ??= (async () => {
      this.#failures.push(this.#opening!);
      await this.#opening!.catch(() => {});
      await this.#recoverOriginal();
    })().finally(() => {
      this.#openingRecovery = undefined;
    });
    return this.#openingRecovery;
  }
  requestForIssuer(
    issuer: StoreNodeIssuer,
  ): Readonly<{ attempt_id: string; extension: string }> {
    if (arguments.length !== 1 || issuer !== this.#issuer) deny();
    return Object.freeze({ attempt_id: this.#id, extension: this.#extension });
  }
  nativeForIssuer(issuer: StoreNodeIssuer): WindowsConsumerNative {
    if (arguments.length !== 1 || issuer !== this.#issuer) deny();
    return this.#native;
  }
  expectationForIssuer(issuer: StoreNodeIssuer): StoreFleetAttemptExpectation {
    if (arguments.length !== 1 || issuer !== this.#issuer || !this.#expectation)
      deny();
    return this.#expectation;
  }
  paths(): Readonly<{ root: string; input: string; output: string }> {
    if (arguments.length || !this.#paths || this.#retired) deny();
    return this.#paths;
  }
  async inspect(): Promise<Readonly<{ quiescent: boolean; retired: boolean }>> {
    if (arguments.length) deny();
    if (this.#retired) return Object.freeze({ quiescent: true, retired: true });
    if (!this.#expectation) deny();
    return parseStoreFleetAttemptState(
      await StoreNodeIssuer.prototype.fleetWorkspaceCommand.call(
        this.#issuer,
        this,
        "inspect",
      ),
    );
  }
  retire(): Promise<void> {
    if (arguments.length)
      return Promise.reject(new Error("STORE_FLEET_WORKSPACE_DENIED"));
    if (this.#retired) return Promise.resolve();
    this.#closing ??= this.#retire();
    void this.#closing.catch(() => {});
    return this.#closing;
  }
  async #retire(): Promise<void> {
    await this.#opening?.catch(() => {});
    if (!this.#expectation) {
      await this.#recoverOriginal();
      if (this.#retired) return;
    }
    const state = parseStoreFleetAttemptState(
      await StoreNodeIssuer.prototype.fleetWorkspaceCommand.call(
        this.#issuer,
        this,
        "retire",
      ),
    );
    if (!state.retired || !state.quiescent) deny();
    this.#retired = true;
  }
  async #recoverOriginal(): Promise<void> {
    const state = parseStoreFleetAttemptState(
      await StoreNodeIssuer.prototype.fleetWorkspaceCommand.call(
        this.#issuer,
        this,
        "recover",
      ),
    );
    if (!state.retired || !state.quiescent) deny();
    this.#retired = true;
    this.#paths = undefined;
  }
  recoverRetire(): Promise<void> {
    if (arguments.length || !this.#closing)
      return Promise.reject(new Error("STORE_FLEET_WORKSPACE_DENIED"));
    if (this.#retired) return Promise.resolve();
    return (this.#recovery ??= (async () => {
      this.#failures.push(this.#closing!);
      await this.#closing!.catch(() => {});
      this.#closing = this.#retire();
      await this.#closing;
    })().finally(() => {
      this.#recovery = undefined;
    }));
  }
  retiredForIssuer(issuer: StoreNodeIssuer): boolean {
    if (arguments.length !== 1 || issuer !== this.#issuer) deny();
    return this.#retired;
  }
}
