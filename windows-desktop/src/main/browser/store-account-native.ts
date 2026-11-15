import { randomBytes } from "node:crypto";
import {
  decodeConsumerBase64,
  isLogonSid,
  processIdentityFromWire,
  processIdentityToWire,
  sameConsumerProcess,
  type ConsumerPipeConnection,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  STORE_PRODUCTS,
  parseStoreInstalledPackage,
} from "../../shared/store-contracts.js";
import type { StoreBootReceipt, StoreNativeAuthority } from "./store-native.js";

const AUTHORITY = Symbol("live-store-account-native");
const NONCE = /^[a-f0-9]{64}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const OPERATIONS = [
  "store_account_owner_bind",
  "store_account_ticket_publish",
  "store_account_ticket_read",
  "store_account_ticket_claim",
  "store_account_ticket_remove",
  "store_account_peer_verify",
  "store_account_same_gui",
  "store_account_launch",
  "store_account_pipe_accept",
  "store_account_pipe_connect",
  "store_account_pipe_reply",
  "store_account_pipe_close",
] as const;
export type StoreAccountOperation = (typeof OPERATIONS)[number];
export interface StoreAccountOwner {
  readonly version: 1;
  readonly bound: true;
  readonly owner: ConsumerProcessIdentity;
  readonly gui: ConsumerProcessIdentity;
  readonly leaseNonce: string;
  readonly packageFullName: string;
}
export interface StoreAccountTicket {
  readonly version: 2;
  readonly owner: ConsumerProcessIdentity;
  readonly server: ConsumerProcessIdentity;
  readonly gui: ConsumerProcessIdentity;
  readonly instance_id: string;
  readonly channel: string;
  readonly nonce: string;
  readonly expires_at: number;
  readonly leaseNonce: string;
  readonly packageFullName: string;
}
export interface StoreAccountActivation {
  readonly version: 1;
  readonly activation: "acknowledged";
  readonly pid: number;
  readonly aumid: string;
}
export interface StoreAccountResults {
  store_account_owner_bind: StoreAccountOwner;
  store_account_ticket_publish: {
    readonly version: 1;
    readonly published: true;
    readonly ticket: StoreAccountTicket;
  };
  store_account_ticket_read: {
    readonly version: 1;
    readonly ticket: StoreAccountTicket | null;
  };
  store_account_ticket_claim: {
    readonly version: 1;
    readonly claimed: boolean;
  };
  store_account_ticket_remove: {
    readonly version: 1;
    readonly removed: boolean;
  };
  store_account_peer_verify: {
    readonly version: 1;
    readonly verified: true;
    readonly peer: ConsumerProcessIdentity;
    readonly gui: ConsumerProcessIdentity;
    readonly packageFullName: string;
  };
  store_account_same_gui: { readonly version: 1; readonly sameGui: boolean };
  store_account_launch: StoreAccountActivation;
  store_account_pipe_accept: {
    readonly version: 1;
    readonly connection: ConsumerPipeConnection;
    readonly payload: Buffer;
  };
  store_account_pipe_connect: {
    readonly version: 1;
    readonly peer: ConsumerProcessIdentity;
    readonly payload: Buffer;
  };
  store_account_pipe_reply: { readonly version: 1; readonly replied: true };
  store_account_pipe_close: { readonly version: 1; readonly closed: true };
}
function denied(): never {
  throw new Error("STORE_ACCOUNT_DENIED");
}
function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const prototype = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    denied();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    row: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !("value" in descriptor)) denied();
    row[field] = descriptor.value;
  }
  return row;
}
function nonce(value: unknown): string {
  if (typeof value !== "string" || !NONCE.test(value)) denied();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) denied();
  return value;
}
function wireIdentity(value: unknown): ConsumerProcessIdentity {
  const row = exact(value, ["sid", "session_id", "pid", "creation_time"]);
  return Object.freeze(processIdentityFromWire(row));
}
function receiptIdentity(value: unknown): ConsumerProcessIdentity {
  const row = exact(value, ["sid", "sessionId", "pid", "creationTime"]);
  return wireIdentity({
    sid: row.sid,
    session_id: row.sessionId,
    pid: row.pid,
    creation_time: row.creationTime,
  });
}
function boot(value: StoreBootReceipt) {
  const row = exact(value, [
      "version",
      "package",
      "helper",
      "parent",
      "logonSid",
    ]),
    pkg = parseStoreInstalledPackage("gui", row.package),
    helper = receiptIdentity(row.helper),
    parent = receiptIdentity(row.parent);
  if (
    row.version !== 1 ||
    !isLogonSid(row.logonSid) ||
    helper.sid !== parent.sid ||
    helper.sessionId !== parent.sessionId ||
    helper.pid === parent.pid ||
    BigInt(helper.creationTime) < BigInt(parent.creationTime)
  )
    denied();
  return { pkg, helper, parent };
}
function sameUser(peer: ConsumerProcessIdentity, own: ConsumerProcessIdentity) {
  if (peer.sid !== own.sid || peer.sessionId !== own.sessionId) denied();
}
function timeout(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 100 ||
    (value as number) > 30_000
  )
    denied();
  return value as number;
}
function expires(value: unknown, now: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= now ||
    (value as number) > now + 35_000
  )
    denied();
  return value as number;
}
/** Receiving grammar only; parsing cannot open a Store port or confer rights. */
export function parseStoreAccountInput(
  operation: StoreAccountOperation,
  value: unknown,
): Record<string, unknown> {
  try {
    if (!OPERATIONS.includes(operation)) denied();
    let row: Record<string, unknown>;
    switch (operation) {
      case "store_account_ticket_read":
      case "store_account_launch":
        return exact(value, []);
      case "store_account_owner_bind":
      case "store_account_ticket_claim":
        row = exact(value, ["nonce"]);
        row.nonce = nonce(row.nonce);
        break;
      case "store_account_ticket_remove":
        row = exact(value, ["instance_id"]);
        row.instance_id = uuid(row.instance_id);
        break;
      case "store_account_ticket_publish":
        row = exact(value, [
          "owner",
          "instance_id",
          "channel",
          "nonce",
          "expires_at",
        ]);
        row.owner = processIdentityToWire(wireIdentity(row.owner));
        row.instance_id = uuid(row.instance_id);
        row.channel = nonce(row.channel);
        row.nonce = nonce(row.nonce);
        row.expires_at = expires(row.expires_at, Date.now());
        break;
      case "store_account_peer_verify":
        row = exact(value, ["peer", "role"]);
        row.peer = processIdentityToWire(wireIdentity(row.peer));
        if (row.role !== "authority" && row.role !== "browser") denied();
        break;
      case "store_account_same_gui":
        row = exact(value, ["left", "right"]);
        row.left = processIdentityToWire(wireIdentity(row.left));
        row.right = processIdentityToWire(wireIdentity(row.right));
        break;
      case "store_account_pipe_accept":
        row = exact(value, ["channel", "nonce", "timeout_ms"]);
        row.channel = nonce(row.channel);
        row.nonce = nonce(row.nonce);
        row.timeout_ms = timeout(row.timeout_ms);
        break;
      case "store_account_pipe_connect":
        row = exact(value, [
          "channel",
          "nonce",
          "peer",
          "payload_base64",
          "timeout_ms",
        ]);
        row.channel = nonce(row.channel);
        row.nonce = nonce(row.nonce);
        row.peer = processIdentityToWire(wireIdentity(row.peer));
        row.payload_base64 = decodeConsumerBase64(
          row.payload_base64,
          4096,
        ).toString("base64");
        row.timeout_ms = timeout(row.timeout_ms);
        break;
      case "store_account_pipe_reply":
      case "store_account_pipe_close":
        row = exact(value, [
          "token",
          "nonce",
          "peer",
          ...(operation === "store_account_pipe_reply"
            ? ["payload_base64"]
            : []),
        ]);
        row.token = nonce(row.token);
        row.nonce = nonce(row.nonce);
        row.peer = processIdentityToWire(wireIdentity(row.peer));
        if (operation === "store_account_pipe_reply")
          row.payload_base64 = decodeConsumerBase64(
            row.payload_base64,
            32768,
          ).toString("base64");
        break;
    }
    return row;
  } catch {
    return denied();
  }
}
export function parseStoreAccountTicket(
  value: unknown,
  receipt: StoreBootReceipt,
  now = Date.now(),
): StoreAccountTicket {
  try {
    const own = boot(receipt),
      row = exact(value, [
        "version",
        "owner",
        "server",
        "gui",
        "instance_id",
        "channel",
        "nonce",
        "expires_at",
        "lease_nonce",
        "package_full_name",
      ]),
      owner = wireIdentity(row.owner),
      server = wireIdentity(row.server),
      gui = wireIdentity(row.gui);
    for (const peer of [owner, server, gui]) sameUser(peer, own.helper);
    if (
      row.version !== 2 ||
      row.package_full_name !== own.pkg.fullName ||
      new Set([owner.pid, server.pid, gui.pid]).size !== 3 ||
      BigInt(owner.creationTime) < BigInt(gui.creationTime) ||
      BigInt(server.creationTime) < BigInt(gui.creationTime)
    )
      denied();
    return Object.freeze({
      version: 2,
      owner,
      server,
      gui,
      instance_id: uuid(row.instance_id),
      channel: nonce(row.channel),
      nonce: nonce(row.nonce),
      expires_at: expires(row.expires_at, now),
      leaseNonce: nonce(row.lease_nonce),
      packageFullName: own.pkg.fullName,
    });
  } catch {
    return denied();
  }
}
export function parseStoreAccountResult<K extends StoreAccountOperation>(
  operation: K,
  value: unknown,
  receipt: StoreBootReceipt,
): StoreAccountResults[K] {
  try {
    const own = boot(receipt);
    let result: StoreAccountResults[StoreAccountOperation];
    switch (operation) {
      case "store_account_owner_bind": {
        const row = exact(value, [
            "version",
            "bound",
            "owner",
            "gui",
            "lease_nonce",
            "package_full_name",
          ]),
          owner = wireIdentity(row.owner),
          gui = wireIdentity(row.gui);
        if (
          row.version !== 1 ||
          row.bound !== true ||
          !sameConsumerProcess(owner, own.helper) ||
          !sameConsumerProcess(gui, own.parent) ||
          row.package_full_name !== own.pkg.fullName
        )
          denied();
        result = Object.freeze({
          version: 1,
          bound: true,
          owner,
          gui,
          leaseNonce: nonce(row.lease_nonce),
          packageFullName: own.pkg.fullName,
        });
        break;
      }
      case "store_account_ticket_publish":
      case "store_account_ticket_read": {
        const row = exact(value, [
          "version",
          "ticket",
          ...(operation === "store_account_ticket_publish"
            ? ["published"]
            : []),
        ]);
        if (
          row.version !== 1 ||
          (operation === "store_account_ticket_publish" &&
            row.published !== true)
        )
          denied();
        const ticket =
          row.ticket === null && operation === "store_account_ticket_read"
            ? null
            : parseStoreAccountTicket(row.ticket, receipt);
        if (operation === "store_account_ticket_publish") {
          if (
            !ticket ||
            !sameConsumerProcess(ticket.server, own.helper) ||
            !sameConsumerProcess(ticket.gui, own.parent)
          )
            denied();
          result = Object.freeze({ version: 1, published: true, ticket });
        } else result = Object.freeze({ version: 1, ticket });
        break;
      }
      case "store_account_ticket_claim":
      case "store_account_ticket_remove":
      case "store_account_same_gui": {
        const flag =
            operation === "store_account_ticket_claim"
              ? "claimed"
              : operation === "store_account_ticket_remove"
                ? "removed"
                : "same_gui",
          row = exact(value, ["version", flag]);
        if (row.version !== 1 || typeof row[flag] !== "boolean") denied();
        result =
          flag === "claimed"
            ? Object.freeze({ version: 1, claimed: row[flag] })
            : flag === "removed"
              ? Object.freeze({ version: 1, removed: row[flag] })
              : Object.freeze({ version: 1, sameGui: row[flag] });
        break;
      }
      case "store_account_peer_verify": {
        const row = exact(value, [
            "version",
            "verified",
            "peer",
            "gui",
            "package_full_name",
          ]),
          peer = wireIdentity(row.peer),
          gui = wireIdentity(row.gui);
        sameUser(peer, own.helper);
        sameUser(gui, own.helper);
        if (
          row.version !== 1 ||
          row.verified !== true ||
          row.package_full_name !== own.pkg.fullName ||
          peer.pid === gui.pid ||
          BigInt(peer.creationTime) < BigInt(gui.creationTime)
        )
          denied();
        result = Object.freeze({
          version: 1,
          verified: true,
          peer,
          gui,
          packageFullName: own.pkg.fullName,
        });
        break;
      }
      case "store_account_launch": {
        const row = exact(value, ["version", "activation", "pid", "aumid"]),
          aumid =
            STORE_PRODUCTS.gui.familyName +
            "!" +
            STORE_PRODUCTS.gui.applicationId;
        if (
          row.version !== 1 ||
          row.activation !== "acknowledged" ||
          !Number.isSafeInteger(row.pid) ||
          (row.pid as number) < 1 ||
          (row.pid as number) > 2147483647 ||
          row.aumid !== aumid
        )
          denied();
        result = Object.freeze({
          version: 1,
          activation: "acknowledged",
          pid: row.pid as number,
          aumid,
        });
        break;
      }
      case "store_account_pipe_accept": {
        const row = exact(value, ["version", "connection", "payload_base64"]),
          connection = exact(row.connection, ["token", "nonce", "peer"]),
          peer = wireIdentity(connection.peer);
        sameUser(peer, own.helper);
        if (row.version !== 1 || peer.pid === own.helper.pid) denied();
        result = Object.freeze({
          version: 1,
          connection: Object.freeze({
            token: nonce(connection.token),
            nonce: nonce(connection.nonce),
            peer,
          }),
          payload: decodeConsumerBase64(row.payload_base64, 4096),
        });
        break;
      }
      case "store_account_pipe_connect": {
        const row = exact(value, ["version", "peer", "payload_base64"]),
          peer = wireIdentity(row.peer);
        sameUser(peer, own.helper);
        if (row.version !== 1 || peer.pid === own.helper.pid) denied();
        result = Object.freeze({
          version: 1,
          peer,
          payload: decodeConsumerBase64(row.payload_base64, 32768),
        });
        break;
      }
      case "store_account_pipe_reply":
      case "store_account_pipe_close": {
        const flag =
            operation === "store_account_pipe_reply" ? "replied" : "closed",
          row = exact(value, ["version", flag]);
        if (row.version !== 1 || row[flag] !== true) denied();
        result =
          flag === "replied"
            ? Object.freeze({ version: 1, replied: true })
            : Object.freeze({ version: 1, closed: true });
        break;
      }
      default:
        return denied();
    }
    return result as StoreAccountResults[K];
  } catch {
    return denied();
  }
}

/** A live Store port has an unforgeable private constructor. Caller receipts,
 * old release AppPins, selected PIDs and overrides cannot open this port. */
export class StoreAccountNative {
  #authority: StoreNativeAuthority;
  #closed = false;
  #closing: Promise<void> | undefined;
  #connections = new Map<string, ConsumerPipeConnection>();
  #clientCapabilities = new Set<string>();
  #published: StoreAccountTicket | undefined;
  private constructor(token: symbol, authority: StoreNativeAuthority) {
    if (token !== AUTHORITY) denied();
    this.#authority = authority;
    Object.freeze(this);
  }
  static async open(
    authority: StoreNativeAuthority,
  ): Promise<StoreAccountNative> {
    if (arguments.length !== 1) denied();
    const { StoreNativeAuthority } = await import("./store-native.js");
    StoreNativeAuthority.prototype.creatorProof.call(authority);
    return new StoreAccountNative(AUTHORITY, authority);
  }
  async #request<K extends StoreAccountOperation>(
    operation: K,
    args: unknown,
  ): Promise<StoreAccountResults[K]> {
    if (this.#closed) denied();
    const { StoreNativeAuthority } = await import("./store-native.js");
    StoreNativeAuthority.prototype.creatorProof.call(this.#authority);
    const input = parseStoreAccountInput(operation, args);
    const raw = await StoreNativeAuthority.prototype.accountOperation.call(
      this.#authority,
      operation,
      input,
    );
    try {
      const result = parseStoreAccountResult(
        operation,
        raw,
        this.#authority.receipt,
      );
      if (
        operation === "store_account_owner_bind" &&
        (!("bound" in result) || result.leaseNonce !== input.nonce)
      )
        denied();
      if (
        operation === "store_account_ticket_publish" &&
        (!("published" in result) ||
          result.ticket.instance_id !== input.instance_id ||
          result.ticket.channel !== input.channel ||
          result.ticket.nonce !== input.nonce ||
          result.ticket.expires_at !== input.expires_at ||
          !sameConsumerProcess(result.ticket.owner, wireIdentity(input.owner)))
      )
        denied();
      if (
        (operation === "store_account_peer_verify" ||
          operation === "store_account_pipe_connect") &&
        (!("peer" in result) ||
          !sameConsumerProcess(result.peer, wireIdentity(input.peer)))
      )
        denied();
      if (
        operation === "store_account_pipe_accept" &&
        (!("connection" in result) || result.connection.nonce !== input.nonce)
      )
        denied();
      return result;
    } catch {
      await this.close();
      return denied();
    }
  }
  async identity(): Promise<ConsumerProcessIdentity> {
    if (arguments.length !== 0 || this.#closed) denied();
    const { StoreNativeAuthority } = await import("./store-native.js");
    return StoreNativeAuthority.prototype.creatorProof.call(this.#authority)
      .helper;
  }
  async bindOwner(leaseNonce: string): Promise<StoreAccountOwner> {
    const result = await this.#request("store_account_owner_bind", {
      nonce: leaseNonce,
    });
    if (result.leaseNonce !== leaseNonce) denied();
    return result;
  }
  async assertSingletonPublication(scope: "account"): Promise<void> {
    if (scope !== "account") denied();
    await this.verifyAccountPeer(await this.identity(), "authority");
  }
  async publishTicket(
    owner: ConsumerProcessIdentity,
    instanceId: string,
  ): Promise<StoreAccountTicket> {
    const result = await this.#request("store_account_ticket_publish", {
      owner: processIdentityToWire(owner),
      instance_id: instanceId,
      channel: randomBytes(32).toString("hex"),
      nonce: randomBytes(32).toString("hex"),
      expires_at: Date.now() + 30_000,
    });
    if (
      !sameConsumerProcess(result.ticket.owner, owner) ||
      result.ticket.instance_id !== instanceId
    )
      denied();
    this.#published = result.ticket;
    return result.ticket;
  }
  async readTicket(): Promise<StoreAccountTicket | null> {
    if (arguments.length !== 0) denied();
    return (await this.#request("store_account_ticket_read", {})).ticket;
  }
  async claimBrowserAccountTicket(value: string): Promise<boolean> {
    return (await this.#request("store_account_ticket_claim", { nonce: value }))
      .claimed;
  }
  async removeTicket(instanceId: string): Promise<boolean> {
    return (
      await this.#request("store_account_ticket_remove", {
        instance_id: instanceId,
      })
    ).removed;
  }
  async verifyAccountPeer(
    peer: ConsumerProcessIdentity,
    role: "authority" | "browser",
  ): Promise<boolean> {
    const result = await this.#request("store_account_peer_verify", {
      peer: processIdentityToWire(peer),
      role,
    });
    if (!sameConsumerProcess(peer, result.peer)) denied();
    return result.verified;
  }
  async sameParentProcess(
    left: ConsumerProcessIdentity,
    right: ConsumerProcessIdentity,
  ): Promise<boolean> {
    return (
      await this.#request("store_account_same_gui", {
        left: processIdentityToWire(left),
        right: processIdentityToWire(right),
      })
    ).sameGui;
  }
  async launchAccountAuthority(): Promise<StoreAccountActivation> {
    if (arguments.length !== 0) denied();
    return this.#request("store_account_launch", {});
  }
  async pipeAccept(options: {
    channel: string;
    nonce: string;
    peer: null;
    timeoutMs?: number;
  }): Promise<{ connection: ConsumerPipeConnection; payload: Buffer }> {
    if (
      options.peer !== null ||
      !this.#published ||
      this.#published.channel !== options.channel ||
      this.#published.nonce !== options.nonce ||
      this.#connections.size >= 16
    )
      denied();
    const result = await this.#request("store_account_pipe_accept", {
      channel: options.channel,
      nonce: options.nonce,
      timeout_ms: options.timeoutMs ?? 30_000,
    });
    if (
      result.connection.nonce !== options.nonce ||
      this.#connections.has(result.connection.token)
    )
      denied();
    this.#connections.set(result.connection.token, result.connection);
    return {
      connection: structuredClone(result.connection),
      payload: result.payload,
    };
  }
  async pipeConnect(options: {
    channel: string;
    nonce: string;
    peer: ConsumerProcessIdentity;
    payload: Uint8Array;
    timeoutMs?: number;
  }): Promise<Buffer> {
    const capability = nonce(options.channel) + ":" + nonce(options.nonce);
    if (
      this.#clientCapabilities.has(capability) ||
      this.#clientCapabilities.size >= 4096 ||
      !(options.payload instanceof Uint8Array) ||
      options.payload.byteLength > 4096
    )
      denied();
    this.#clientCapabilities.add(capability);
    const result = await this.#request("store_account_pipe_connect", {
      channel: options.channel,
      nonce: options.nonce,
      peer: processIdentityToWire(options.peer),
      payload_base64: Buffer.from(options.payload).toString("base64"),
      timeout_ms: options.timeoutMs ?? 30_000,
    });
    if (!sameConsumerProcess(result.peer, options.peer)) denied();
    return result.payload;
  }
  #consume(connection: ConsumerPipeConnection) {
    const known = this.#connections.get(connection.token);
    if (
      !known ||
      known.nonce !== connection.nonce ||
      !sameConsumerProcess(known.peer, connection.peer)
    )
      denied();
    this.#connections.delete(connection.token);
    return {
      token: known.token,
      nonce: known.nonce,
      peer: processIdentityToWire(known.peer),
    };
  }
  async pipeReply(
    connection: ConsumerPipeConnection,
    payload: Uint8Array,
  ): Promise<void> {
    if (!(payload instanceof Uint8Array) || payload.byteLength > 32768)
      denied();
    await this.#request("store_account_pipe_reply", {
      ...this.#consume(connection),
      payload_base64: Buffer.from(payload).toString("base64"),
    });
  }
  async pipeClose(connection: ConsumerPipeConnection): Promise<void> {
    await this.#request("store_account_pipe_close", this.#consume(connection));
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#connections.clear();
    return (this.#closing = (async () => {
      const { StoreNativeAuthority } = await import("./store-native.js");
      await StoreNativeAuthority.prototype.close.call(this.#authority);
    })());
  }
}
export async function openStoreAccountNative(
  authority: StoreNativeAuthority,
): Promise<StoreAccountNative> {
  if (arguments.length !== 1) denied();
  return StoreAccountNative.open(authority);
}
