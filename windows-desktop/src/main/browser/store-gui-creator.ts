import { createServer, type Server, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { arch, pid as guiPid, platform } from "node:process";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  STORE_PRODUCTS,
  parseStorePackageVersion,
} from "../../shared/store-contracts.js";
import type {
  StoreGuiCreatorProof,
  StoreNativeAuthority,
} from "./store-native.js";
import { parseStoreBrowserAttachment } from "./store-registration.js";

export const STORE_GUI_CREATOR_MAX_FRAME = 2_048;
export const STORE_GUI_CREATOR_TIMEOUT_MS = 3_000;
const CHALLENGE = /^[a-f0-9]{64}$/u;
const MAX_HELPERS = 256;
const MAX_CONNECTIONS = 32;
const MAX_CHALLENGES = 512;
const CHALLENGE_LIFETIME_MS = 30_000;
const DENIED = "STORE_GUI_CREATOR_DENIED";
export interface StoreGuiCreatorQuery {
  readonly version: 1;
  readonly challenge: string;
  readonly helper_pid: number;
  readonly helper_creation_time: string;
}
export interface StoreGuiCreatorLease {
  bindBrowserAttachment(authority: StoreNativeAuthority): Promise<void>;
  deriveBrowserSource(source: StoreNativeAuthority): Promise<void>;
  close(): Promise<void>;
}
function denied(): never {
  throw new Error(DENIED);
}
function validPid(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 2_147_483_647
  );
}
function validBirth(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{1,19}$/u.test(value) &&
    BigInt(value) <= 0xffffffffffffffffn
  );
}
/** Receiving grammar only. A query or reflected reply never grants authority. */
export function parseStoreGuiCreatorQuery(
  bytes: Uint8Array,
): StoreGuiCreatorQuery {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length < 2 ||
      bytes.length > STORE_GUI_CREATOR_MAX_FRAME
    )
      denied();
    const frame = Buffer.from(bytes);
    if (frame.indexOf(10) !== frame.length - 1 || frame.includes(13)) denied();
    const value = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        frame.subarray(0, -1),
      ),
      STORE_GUI_CREATOR_MAX_FRAME,
      16,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) denied();
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row);
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          ![
            "version",
            "challenge",
            "helper_pid",
            "helper_creation_time",
          ].includes(key),
      ) ||
      row.version !== 1 ||
      typeof row.challenge !== "string" ||
      !CHALLENGE.test(row.challenge) ||
      !validPid(row.helper_pid) ||
      !validBirth(row.helper_creation_time)
    )
      denied();
    return Object.freeze({
      version: 1,
      challenge: row.challenge,
      helper_pid: row.helper_pid,
      helper_creation_time: row.helper_creation_time,
    });
  } catch {
    return denied();
  }
}

// Import the real class rather than accepting a verifier, supplied proof, or an
// overridable method on the passed object. Its private fields reject lookalikes.
async function liveProof(
  authority: StoreNativeAuthority,
): Promise<StoreGuiCreatorProof> {
  const { StoreNativeAuthority } = await import("./store-native.js");
  return validateProof(
    StoreNativeAuthority.prototype.creatorProof.call(authority),
  );
}
function validateProof(proof: StoreGuiCreatorProof): StoreGuiCreatorProof {
  const identity = (value: StoreGuiCreatorProof["helper"]) =>
    processIdentityFromWire({
      sid: value.sid,
      session_id: value.sessionId,
      pid: value.pid,
      creation_time: value.creationTime,
    });
  const gui = identity(proof.gui),
    helper = identity(proof.helper);
  const product = STORE_PRODUCTS.gui;
  const prefix = product.identityName + "_",
    suffix = "_x64__" + product.publisherId;
  if (
    proof.version !== 1 ||
    gui.pid !== guiPid ||
    helper.pid === guiPid ||
    helper.sid !== gui.sid ||
    helper.sessionId !== gui.sessionId ||
    BigInt(helper.creationTime) < BigInt(gui.creationTime) ||
    typeof proof.packageFullName !== "string" ||
    !proof.packageFullName.startsWith(prefix) ||
    !proof.packageFullName.endsWith(suffix)
  )
    denied();
  parseStorePackageVersion(
    proof.packageFullName.slice(prefix.length, -suffix.length),
  );
  return Object.freeze({
    version: 1,
    gui,
    helper,
    packageFullName: proof.packageFullName,
  });
}
function key(proof: StoreGuiCreatorProof) {
  return `${proof.helper.pid}:${proof.helper.creationTime}`;
}
interface Entry {
  readonly authority: StoreNativeAuthority;
  readonly proof: StoreGuiCreatorProof;
  readonly token: symbol;
  browserBound: boolean;
  derivedBrowserSource?: Entry;
}
function browserProofNow(
  authority: StoreNativeAuthority,
  prototype: Pick<StoreNativeAuthority, "browserCreatorProof">,
) {
  const proof = prototype.browserCreatorProof.call(authority);
  const wire = {
    version: proof.version,
    accepted: proof.accepted,
    host: processIdentityToWire(proof.host),
    gui: processIdentityToWire(proof.gui),
    chrome: processIdentityToWire(proof.chrome),
    origin: proof.origin,
    package_full_name: proof.packageFullName,
  };
  parseStoreBrowserAttachment(wire, authority.receipt);
  return wire;
}
async function browserProof(authority: StoreNativeAuthority) {
  const { StoreNativeAuthority } = await import("./store-native.js");
  return browserProofNow(authority, StoreNativeAuthority.prototype);
}
class Endpoint {
  readonly entries = new Map<string, Entry>();
  #server: Server;
  #sockets = new Set<Socket>();
  #challenges = new Map<string, number>();
  #closed = false;
  #cleanup: Promise<void> | undefined;
  constructor() {
    this.#server = createServer({ allowHalfOpen: true }, (socket) =>
      this.#accept(socket),
    );
    this.#server.maxConnections = MAX_CONNECTIONS;
    this.#server.on("error", () => {
      void this.close();
    });
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error(DENIED));
      this.#server.once("error", fail);
      this.#server.listen(
        `\\\\.\\pipe\\MusicMuteStoreGuiCreator-${guiPid}`,
        () => {
          this.#server.removeListener("error", fail);
          if (this.#closed) reject(new Error(DENIED));
          else resolve();
        },
      );
    });
    this.#server.unref();
  }
  get closed() {
    return this.#closed;
  }
  #accept(socket: Socket) {
    if (this.#closed || this.#sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    let bytes = Buffer.alloc(0),
      received = false;
    const timer = setTimeout(
      () => socket.destroy(),
      STORE_GUI_CREATOR_TIMEOUT_MS,
    );
    timer.unref();
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      this.#sockets.delete(socket);
    });
    socket.once("end", () => {
      if (!received) socket.destroy();
    });
    socket.on("data", (chunk: Buffer) => {
      if (
        received ||
        bytes.length + chunk.length > STORE_GUI_CREATOR_MAX_FRAME
      ) {
        socket.destroy();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) return;
      received = true;
      void this.#answer(socket, bytes).catch(() => socket.destroy());
    });
  }
  async #answer(socket: Socket, bytes: Buffer) {
    const query = parseStoreGuiCreatorQuery(bytes),
      now = performance.now();
    for (const [challenge, at] of this.#challenges)
      if (now - at >= CHALLENGE_LIFETIME_MS) this.#challenges.delete(challenge);
    if (
      this.#closed ||
      this.#challenges.has(query.challenge) ||
      this.#challenges.size >= MAX_CHALLENGES
    )
      denied();
    this.#challenges.set(query.challenge, now);
    const entryKey = `${query.helper_pid}:${query.helper_creation_time}`,
      entry = this.entries.get(entryKey);
    let confirmed = false,
      packageFullName = "",
      browserSource: Entry | undefined,
      browserAttachment: Awaited<ReturnType<typeof browserProof>> | null = null;
    if (entry) {
      try {
        const proof = await liveProof(entry.authority);
        confirmed =
          !this.#closed &&
          !socket.destroyed &&
          this.entries.get(entryKey) === entry &&
          key(proof) === entryKey &&
          proof.gui.creationTime === entry.proof.gui.creationTime &&
          proof.gui.sid === entry.proof.gui.sid &&
          proof.gui.sessionId === entry.proof.gui.sessionId &&
          proof.packageFullName === entry.proof.packageFullName;
        if (confirmed) {
          packageFullName = proof.packageFullName;
          const candidate = entry.browserBound
            ? entry
            : entry.derivedBrowserSource;
          if (candidate?.browserBound) {
            try {
              const source = await liveProof(candidate.authority);
              if (
                source.gui.pid !== proof.gui.pid ||
                source.gui.creationTime !== proof.gui.creationTime ||
                source.gui.sid !== proof.gui.sid ||
                source.gui.sessionId !== proof.gui.sessionId ||
                source.packageFullName !== proof.packageFullName
              )
                denied();
              const attachment = await browserProof(candidate.authority);
              await liveProof(candidate.authority);
              if (
                this.entries.get(key(source)) === candidate &&
                candidate.browserBound &&
                (candidate === entry ||
                  entry.derivedBrowserSource === candidate)
              ) {
                browserAttachment = attachment;
                browserSource = candidate;
              }
            } catch {
              // A retired original source grants no browser scope, even while
              // its privately derived helper remains independently alive.
            }
          }
          await liveProof(entry.authority);
          if (this.#closed || this.entries.get(entryKey) !== entry) {
            confirmed = false;
            packageFullName = "";
            browserAttachment = null;
          }
        }
      } catch {
        confirmed = false;
        packageFullName = "";
        browserAttachment = null;
      }
    }
    if (confirmed && entry) {
      // The reads above may await module loading. Recheck both genuine private
      // brands synchronously after the last await and before writing a reply;
      // a target that remains live cannot carry a just-retired source's rights.
      const { StoreNativeAuthority } = await import("./store-native.js");
      const prototype = StoreNativeAuthority.prototype;
      try {
        const proof = validateProof(
          prototype.creatorProof.call(entry.authority),
        );
        if (
          this.#closed ||
          this.entries.get(entryKey) !== entry ||
          key(proof) !== entryKey ||
          proof.gui.creationTime !== entry.proof.gui.creationTime ||
          proof.gui.sid !== entry.proof.gui.sid ||
          proof.gui.sessionId !== entry.proof.gui.sessionId ||
          proof.packageFullName !== entry.proof.packageFullName
        )
          denied();
        if (browserSource) {
          try {
            const source = validateProof(
              prototype.creatorProof.call(browserSource.authority),
            );
            if (
              this.entries.get(key(source)) !== browserSource ||
              !browserSource.browserBound ||
              (browserSource !== entry &&
                entry.derivedBrowserSource !== browserSource) ||
              source.gui.pid !== proof.gui.pid ||
              source.gui.creationTime !== proof.gui.creationTime ||
              source.gui.sid !== proof.gui.sid ||
              source.gui.sessionId !== proof.gui.sessionId ||
              source.packageFullName !== proof.packageFullName
            )
              denied();
            browserAttachment = browserProofNow(
              browserSource.authority,
              prototype,
            );
          } catch {
            browserAttachment = null;
          }
        }
      } catch {
        confirmed = false;
        packageFullName = "";
        browserAttachment = null;
      }
    }
    if (this.#closed || socket.destroyed) denied();
    socket.end(
      JSON.stringify({
        version: 1,
        confirmed,
        challenge: query.challenge,
        helper_pid: query.helper_pid,
        helper_creation_time: query.helper_creation_time,
        package_full_name: packageFullName,
        browser_attachment: browserAttachment,
        source_helper:
          browserAttachment && browserSource
            ? {
                pid: browserSource.proof.helper.pid,
                creation_time: browserSource.proof.helper.creationTime,
              }
            : null,
      }) + "\n",
    );
  }
  close(): Promise<void> {
    if (this.#cleanup) return this.#cleanup;
    this.#closed = true;
    this.entries.clear();
    for (const socket of this.#sockets) socket.destroy();
    return (this.#cleanup = new Promise<void>((resolve) => {
      if (!this.#server.listening) resolve();
      else this.#server.close(() => resolve());
    }));
  }
}
let endpoint: Endpoint | undefined;
let serialized: Promise<unknown> = Promise.resolve();
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = serialized.then(operation, operation);
  serialized = result.catch(() => undefined);
  return result;
}
/** Fixed process-owned endpoint. Native readers must independently prove its
 * actual server PID/code/generation and held helper peer; membership does not
 * confer account mutex ownership, publication rights, or launch authority. */
export async function registerStoreGuiCreator(
  authority: StoreNativeAuthority,
): Promise<StoreGuiCreatorLease> {
  if (
    arguments.length !== 1 ||
    platform !== "win32" ||
    arch !== "x64" ||
    !validPid(guiPid)
  )
    denied();
  return exclusive(async () => {
    const proof = await liveProof(authority);
    if (!endpoint || endpoint.closed) {
      const next = new Endpoint();
      try {
        await next.listen();
      } catch {
        await next.close();
        return denied();
      }
      endpoint = next;
    }
    const owner = endpoint,
      entryKey = key(proof);
    if (owner.entries.size >= MAX_HELPERS || owner.entries.has(entryKey))
      denied();
    let current: StoreGuiCreatorProof;
    try {
      current = await liveProof(authority);
      if (
        key(current) !== entryKey ||
        current.gui.creationTime !== proof.gui.creationTime ||
        current.packageFullName !== proof.packageFullName ||
        owner.closed
      )
        denied();
    } catch {
      if (owner.entries.size === 0) {
        await owner.close();
        if (endpoint === owner) endpoint = undefined;
      }
      return denied();
    }
    const token = Symbol("registered-live-store-helper");
    owner.entries.set(entryKey, {
      authority,
      proof: current,
      token,
      browserBound: false,
    });
    let closing: Promise<void> | undefined;
    return Object.freeze({
      bindBrowserAttachment(value: StoreNativeAuthority): Promise<void> {
        if (arguments.length !== 1 || value !== authority || closing)
          return Promise.reject(new Error(DENIED));
        return exclusive(async () => {
          const entry = owner.entries.get(entryKey);
          if (
            owner.closed ||
            !entry ||
            entry.token !== token ||
            entry.browserBound ||
            entry.derivedBrowserSource
          )
            denied();
          const proof = await liveProof(authority);
          await browserProof(authority);
          await liveProof(authority);
          if (
            owner.closed ||
            owner.entries.get(entryKey) !== entry ||
            key(proof) !== entryKey ||
            closing
          )
            denied();
          entry.browserBound = true;
        });
      },
      deriveBrowserSource(source: StoreNativeAuthority): Promise<void> {
        if (arguments.length !== 1 || source === authority || closing)
          return Promise.reject(new Error(DENIED));
        return exclusive(async () => {
          const entry = owner.entries.get(entryKey);
          const sourceProof = await liveProof(source);
          const original = owner.entries.get(key(sourceProof));
          if (
            owner.closed ||
            !entry ||
            entry.token !== token ||
            entry.browserBound ||
            entry.derivedBrowserSource ||
            !original ||
            original.authority !== source ||
            !original.browserBound ||
            original.derivedBrowserSource
          )
            denied();
          await browserProof(source);
          const targetProof = await liveProof(authority);
          await liveProof(source);
          if (
            closing ||
            owner.closed ||
            owner.entries.get(entryKey) !== entry ||
            owner.entries.get(key(sourceProof)) !== original ||
            key(targetProof) !== entryKey ||
            targetProof.gui.pid !== sourceProof.gui.pid ||
            targetProof.gui.creationTime !== sourceProof.gui.creationTime ||
            targetProof.gui.sid !== sourceProof.gui.sid ||
            targetProof.gui.sessionId !== sourceProof.gui.sessionId ||
            targetProof.packageFullName !== sourceProof.packageFullName
          )
            denied();
          // This relationship is an actual pair of privately branded live
          // instances. Query fields, receipts and unrelated browser rows cannot
          // construct it, and a derived helper cannot act as another source.
          entry.derivedBrowserSource = original;
        });
      },
      close(): Promise<void> {
        if (closing) return closing;
        return (closing = exclusive(async () => {
          if (owner.entries.get(entryKey)?.token === token)
            owner.entries.delete(entryKey);
          if (owner.entries.size === 0) {
            await owner.close();
            if (endpoint === owner) endpoint = undefined;
          }
        }));
      },
    });
  });
}
