import {
  assertConsumerNonce,
  processIdentityFromWire,
  sameConsumerProcess,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  assertShareRequestId,
  consumerShareArgs,
  parseConsumerShareReceipt,
  type ConsumerShareSource,
  type ConsumerShareReceipt,
} from "../../../../worker/src/platform/windows/consumer-native-share.js";
import type { ConsumerNativeEvent } from "../../../../worker/src/platform/windows/consumer-native-events.js";
import {
  StoreNativeAuthority,
  storeAuthorityForDataNative,
} from "../browser/store-native.js";
import type { StoreBootReceipt } from "../../shared/store-boot-receipt.js";
import type { HostContext } from "../host-context.js";

export type StoreShareOperation =
  | "store_share_start"
  | "store_share_inspect"
  | "store_share_cancel"
  | "store_share_cleanup_acknowledge"
  | "store_share_cleanup_completed";
const TOKEN = Symbol("genuine-store-share-helper");
function denied(): never {
  throw Error("STORE_SHARE_DENIED");
}
function exact(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const prototype = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    denied();
  const row: Record<string, unknown> = Object.create(null),
    descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of names) {
    const field = descriptors[name];
    if (!field?.enumerable || !("value" in field)) denied();
    row[name] = field.value;
  }
  return row;
}
/** Receiving data only. Window/namespace/code admission is actual native proof. */
export function parseStoreShareInput(
  operation: StoreShareOperation,
  value: unknown,
): Record<string, unknown> {
  if (operation === "store_share_start") {
    const row = exact(value, [
      "request_id",
      "window_handle",
      "window_owner",
      "relative_path",
      "sha256",
      "bytes",
      "title",
      "mime",
    ]);
    const source: ConsumerShareSource = {
      requestId: row.request_id as string,
      windowHandle: row.window_handle as string,
      windowOwner: processIdentityFromWire(row.window_owner),
      relativePath: row.relative_path as string,
      sha256: row.sha256 as string,
      bytes: row.bytes as number,
      title: row.title as string,
      mime: row.mime as string,
    };
    return consumerShareArgs(source);
  }
  if (operation === "store_share_cleanup_completed") return exact(value, []);
  if (
    ![
      "store_share_inspect",
      "store_share_cancel",
      "store_share_cleanup_acknowledge",
    ].includes(operation)
  )
    denied();
  const row = exact(
    value,
    operation === "store_share_inspect"
      ? ["request_id"]
      : ["request_id", "nonce"],
  );
  assertShareRequestId(row.request_id);
  if (operation !== "store_share_inspect") {
    if (typeof row.nonce !== "string") denied();
    assertConsumerNonce(row.nonce);
  }
  return row;
}
export function parseStoreShareResult(
  operation: StoreShareOperation,
  value: unknown,
  input: Record<string, unknown>,
  receipt: StoreBootReceipt,
) {
  if (operation === "store_share_cleanup_acknowledge") {
    const row = exact(value, ["removed"]);
    if (typeof row.removed !== "boolean") denied();
    return row.removed;
  }
  if (operation === "store_share_cleanup_completed") {
    const row = exact(value, ["removed", "retained"]);
    if (
      !Number.isSafeInteger(row.removed) ||
      (row.removed as number) < 0 ||
      (row.removed as number) > 16 ||
      !Number.isSafeInteger(row.retained) ||
      (row.retained as number) < 0 ||
      (row.retained as number) > 64
    )
      denied();
    return { removed: row.removed as number, retained: row.retained as number };
  }
  if (operation === "store_share_inspect" && value === null) return null;
  const found = parseConsumerShareReceipt(value);
  if (
    found.requestId !== input.request_id ||
    found.windowOwner.sid !== receipt.parent.sid ||
    found.windowOwner.sessionId !== receipt.parent.sessionId
  )
    denied();
  if (operation === "store_share_start") {
    if (
      !sameConsumerProcess(found.helper, receipt.helper) ||
      !sameConsumerProcess(found.windowOwner, receipt.parent) ||
      found.relativePath !== input.relative_path ||
      found.sha256 !== input.sha256 ||
      found.bytes !== input.bytes
    )
      denied();
  } else if (operation === "store_share_cancel" && found.nonce !== input.nonce)
    denied();
  return found;
}
/** Owns one actual independently bootstrapped GUI helper and its original
 * native STA/event/scratch lifecycle; it accepts no legacy publisher pin. */
export class StoreShareNative {
  #authority: StoreNativeAuthority;
  #closed = false;
  #closing: Promise<void> | undefined;
  private constructor(token: symbol, authority: StoreNativeAuthority) {
    if (token !== TOKEN) denied();
    StoreNativeAuthority.prototype.creatorProof.call(authority);
    this.#authority = authority;
    Object.freeze(this);
  }
  static async open(host: HostContext): Promise<StoreShareNative> {
    if (arguments.length !== 1) denied();
    const source = host.storeAuthority;
    if (!source || storeAuthorityForDataNative(host.native) !== source)
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(source);
    const peer = await StoreNativeAuthority.openSharePeer(source);
    try {
      return new StoreShareNative(TOKEN, peer);
    } catch (error) {
      await StoreNativeAuthority.prototype.close.call(peer);
      throw error;
    }
  }
  #live() {
    if (this.#closed) denied();
    return StoreNativeAuthority.prototype.creatorProof.call(this.#authority);
  }
  async identity() {
    if (arguments.length) denied();
    return structuredClone(this.#live().helper);
  }
  async #request(
    operation: StoreShareOperation,
    input: Record<string, unknown>,
  ) {
    this.#live();
    const wire = parseStoreShareInput(operation, input);
    const raw = await StoreNativeAuthority.prototype.shareOperation.call(
      this.#authority,
      operation,
      wire,
    );
    this.#live();
    return parseStoreShareResult(operation, raw, wire, this.#authority.receipt);
  }
  async startShare(source: ConsumerShareSource): Promise<ConsumerShareReceipt> {
    if (
      arguments.length !== 1 ||
      !sameConsumerProcess(source.windowOwner, this.#live().gui)
    )
      denied();
    const result = await this.#request(
      "store_share_start",
      consumerShareArgs(source),
    );
    if (!result || typeof result !== "object" || !("requestId" in result))
      denied();
    return result;
  }
  async inspectShare(requestId: string): Promise<ConsumerShareReceipt | null> {
    if (arguments.length !== 1) denied();
    const result = await this.#request("store_share_inspect", {
      request_id: requestId,
    });
    if (
      result !== null &&
      (!result || typeof result !== "object" || !("requestId" in result))
    )
      denied();
    return result;
  }
  async cancelShare(
    lease: Pick<ConsumerShareReceipt, "requestId" | "nonce">,
  ): Promise<ConsumerShareReceipt> {
    if (arguments.length !== 1) denied();
    const result = await this.#request("store_share_cancel", {
      request_id: lease.requestId,
      nonce: lease.nonce,
    });
    if (!result || typeof result !== "object" || !("requestId" in result))
      denied();
    return result;
  }
  async acknowledgeShareCleanup(
    lease: Pick<ConsumerShareReceipt, "requestId" | "nonce">,
  ): Promise<boolean> {
    if (arguments.length !== 1) denied();
    const result = await this.#request("store_share_cleanup_acknowledge", {
      request_id: lease.requestId,
      nonce: lease.nonce,
    });
    if (typeof result !== "boolean") denied();
    return result;
  }
  async pruneCompletedShareReceipts(): Promise<{
    removed: number;
    retained: number;
  }> {
    if (arguments.length) denied();
    const result = await this.#request("store_share_cleanup_completed", {});
    if (!result || typeof result !== "object" || !("removed" in result))
      denied();
    return result;
  }
  onEvent(listener: (event: ConsumerNativeEvent) => void): () => void {
    if (arguments.length !== 1) denied();
    this.#live();
    return StoreNativeAuthority.prototype.onShareEvent.call(
      this.#authority,
      listener,
    );
  }
  onClosed(listener: () => void): () => void {
    if (arguments.length !== 1) denied();
    this.#live();
    return StoreNativeAuthority.prototype.onShareClosed.call(
      this.#authority,
      listener,
    );
  }
  close(): Promise<void> {
    if (arguments.length) denied();
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return (this.#closing = StoreNativeAuthority.prototype.close.call(
      this.#authority,
    ));
  }
}
