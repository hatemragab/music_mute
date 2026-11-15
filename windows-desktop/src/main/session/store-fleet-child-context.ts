import { HostContext } from "../host-context.js";
import type { SessionChildContext } from "./context.js";
import { StoreNodeIssuer } from "./store-node-issuer.js";
import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";

const TOKEN = Symbol("store-fleet-child-context");
interface ConstructionOwner {
  issuer: StoreNodeIssuer;
  context?: StoreFleetChildContext;
}
/** The fixed protected Fleet entry constructs its own real issuer. It never
 * adopts a Session context or a caller-written consumer configuration. */
export class StoreFleetChildContext implements SessionChildContext {
  static #opening = new Set<ConstructionOwner>();
  readonly distribution = "microsoft-store" as const;
  readonly role = "fleet" as const;
  readonly storeIssuer: StoreNodeIssuer;
  readonly native: WindowsConsumerNative;
  readonly host: HostContext;
  readonly releaseRoot: string;
  readonly personalRoot: string;
  readonly fleetRoot: string;
  readonly ownershipNonce: string;
  readonly ownerIdentity: SessionChildContext["ownerIdentity"];
  #closed = false;
  #closing: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #failedClosures: Promise<void>[] = [];
  private constructor(
    token: symbol,
    issuer: StoreNodeIssuer,
    native: WindowsConsumerNative,
    host: HostContext,
    fleetRoot: string,
  ) {
    if (token !== TOKEN || issuer.nodeRole !== "fleet")
      throw new Error("FLEET_CONTEXT_INVALID");
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    this.storeIssuer = issuer;
    this.native = native;
    this.host = host;
    this.releaseRoot = issuer.workerRoot;
    this.personalRoot = host.personalRoot;
    this.fleetRoot = fleetRoot;
    this.ownershipNonce = issuer.owner.nonce;
    this.ownerIdentity = Object.freeze({ ...issuer.owner.identity });
    Object.freeze(this);
  }
  static async open(): Promise<StoreFleetChildContext> {
    if (arguments.length || this.#opening.size)
      throw new Error("FLEET_CONTEXT_INVALID");
    const issuer = await StoreNodeIssuer.open(),
      owner: ConstructionOwner = { issuer };
    this.#opening.add(owner);
    try {
      if (issuer.nodeRole !== "fleet") throw new Error("FLEET_CONTEXT_INVALID");
      const native = await issuer.openNative(),
        host = await HostContext.initialize(native, "0.1.0", 1),
        fleetRoot = await native.ensurePrivateDirectory("fleet");
      const context = new StoreFleetChildContext(
        TOKEN,
        issuer,
        native,
        host,
        fleetRoot,
      );
      owner.context = context;
      this.#opening.delete(owner);
      return context;
    } catch (error) {
      try {
        await issuer.close();
        this.#opening.delete(owner);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "CHILD_SHUTDOWN_PENDING");
      }
      throw error;
    }
  }
  async openNative(): Promise<WindowsConsumerNative> {
    if (this.#closed || this.#closing || this.#recovering)
      throw new Error("FLEET_CONTEXT_INVALID");
    return StoreNodeIssuer.prototype.openNative.call(this.storeIssuer);
  }
  assertAssociation(): void {
    if (arguments.length || this.#closed || this.#closing || this.#recovering)
      throw new Error("FLEET_CONTEXT_INVALID");
    StoreNodeIssuer.prototype.assertNative.call(this.storeIssuer, this.native);
  }
  async assertCurrent() {
    if (arguments.length) throw new Error("FLEET_CONTEXT_INVALID");
    StoreFleetChildContext.prototype.assertAssociation.call(this);
    return StoreNodeIssuer.prototype.codeView.call(this.storeIssuer);
  }
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return (this.#closing ??= (async () => {
      await StoreNodeIssuer.prototype.close.call(this.storeIssuer);
      this.#closed = true;
    })());
  }
  recoverClose(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (!this.#closing) throw new Error("FLEET_CONTEXT_INVALID");
    return (this.#recovering ??= (async () => {
      this.#failedClosures.push(this.#closing!);
      await this.#closing!.catch(() => {});
      const original = StoreNodeIssuer.prototype.recoverClose.call(
        this.storeIssuer,
      );
      this.#failedClosures.push(original);
      await original;
      this.#closed = true;
    })().finally(() => {
      this.#recovering = undefined;
    }));
  }
}
