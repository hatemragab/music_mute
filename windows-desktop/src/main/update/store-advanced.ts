import { randomUUID } from "node:crypto";
import type { HostContext } from "../host-context.js";
import {
  StoreNativeAuthority,
  storeAuthorityForDataNative,
} from "../browser/store-native.js";
import type { ConsumerUpdateReview } from "./controller.js";
import type {
  ConsumerUpdateSource,
  ConsumerUpdateView,
} from "../../shared/update-contracts.js";
import {
  STORE_UPDATE_VIEW,
  storeUpdateDestination,
} from "./store-distribution.js";

const TOKEN = Symbol("genuine-store-advanced-updates");
function denied(): never {
  throw new Error("STORE_UPDATE_DENIED");
}
/** Advanced borrows the actual GUI authority and opens the fixed Worker Store
 * product. Windows manages deployment; this class reports no installed update. */
export class StoreFleetAdvancedUpdates {
  #host: HostContext;
  #authority: StoreNativeAuthority;
  private constructor(
    token: symbol,
    host: HostContext,
    authority: StoreNativeAuthority,
  ) {
    if (token !== TOKEN) denied();
    this.#host = host;
    this.#authority = authority;
    Object.freeze(this);
  }
  static open(host: HostContext): StoreFleetAdvancedUpdates {
    if (arguments.length !== 1) denied();
    const authority = host.storeAuthority;
    if (!authority || storeAuthorityForDataNative(host.native) !== authority)
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(authority);
    return new StoreFleetAdvancedUpdates(TOKEN, host, authority);
  }
  #live(): void {
    if (
      this.#host.storeAuthority !== this.#authority ||
      storeAuthorityForDataNative(this.#host.native) !== this.#authority
    )
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(this.#authority);
  }
  async #open(
    signal: AbortSignal,
    source: ConsumerUpdateSource = "app",
  ): Promise<ConsumerUpdateView> {
    if (
      !(signal instanceof AbortSignal) ||
      !["app", "catalog"].includes(source)
    )
      denied();
    if (process.versions.electron !== undefined) {
      signal.throwIfAborted();
      this.#live();
      const destination = await storeUpdateDestination(this.#authority, {
        version: 1,
        request_id: randomUUID(),
        action: "store_open",
        product: "worker",
      });
      signal.throwIfAborted();
      this.#live();
      const { shell } = await import("electron");
      await shell.openExternal(destination);
      this.#live();
      signal.throwIfAborted();
      return { ...STORE_UPDATE_VIEW };
    }
    return denied();
  }
  check(signal: AbortSignal, source: ConsumerUpdateSource = "app") {
    if (arguments.length < 1 || arguments.length > 2) denied();
    return this.#open(signal, source);
  }
  install(
    signal: AbortSignal,
    source: ConsumerUpdateSource = "app",
    review?: ConsumerUpdateReview,
  ) {
    if (arguments.length < 1 || arguments.length > 3) denied();
    if (review !== undefined) {
      if (!review || typeof review !== "object") denied();
      const fields = Object.getOwnPropertyDescriptors(review);
      if (
        Object.getPrototypeOf(review) !== Object.prototype ||
        Reflect.ownKeys(review).sort().join() !==
          "authority,machineId,transaction" ||
        Object.values(fields).some(
          (field) => !field.enumerable || !("value" in field),
        ) ||
        ![fields.transaction?.value, fields.machineId?.value].every(
          (value) =>
            typeof value === "string" &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
              value,
            ),
        ) ||
        typeof fields.authority?.value !== "string" ||
        !/^[a-f0-9]{64}$/u.test(fields.authority.value)
      )
        denied();
    }
    return this.#open(signal, source);
  }
  recover(signal: AbortSignal) {
    if (arguments.length !== 1) denied();
    return this.#open(signal);
  }
}
