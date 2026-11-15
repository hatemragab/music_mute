import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { win32 } from "node:path";
import {
  sameConsumerProcess,
  type ConsumerMutexLease,
  type ConsumerOwnedProcess,
  type ConsumerProcessIdentity,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { WindowsReleaseManifest } from "../../../../worker/src/platform/windows/release-manifest.js";
import type { StorePreparationBinding } from "../prepare/store-model-ready.js";
import type { SessionRole } from "../../shared/session-contracts.js";
import type {
  SessionAgentConfiguration,
  SessionRuntimeContext,
} from "./context.js";
import type { SessionNativePort } from "./supervisor.js";
import { SessionPreparationGate } from "./preparation-gate.js";
import { StoreNodeIssuer } from "./store-node-issuer.js";

const TOKEN = Symbol("store-runtime-context"),
  DENIED = "STORE_SESSION_CONTEXT_DENIED";
const FIXED = [
  "runtime/node/node.exe",
  "runtime/native/musicmute-native.exe",
  "agent/session-agent.cjs",
  "agent/personal.cjs",
  "agent/fleet.cjs",
] as const;
interface ConstructionOwner {
  issuer: StoreNodeIssuer;
  native?: WindowsConsumerNative;
  context?: StoreRuntimeContext;
  failure?: Promise<void>;
}
export interface StoreSessionConfiguration extends SessionAgentConfiguration {
  readonly distribution: "microsoft-store";
  readonly generation: string;
  readonly packageFullName: string;
  readonly runtimeManifestSha256: string;
}
function deny(): never {
  throw new Error(DENIED);
}
/** Only the actual Store Session Node can construct this context. Shared
 * business field `release` identifies its inventory generation, and
 * `releaseRoot` is the actual OS Worker package/worker. Neither is a legacy
 * archive, private executable tree, config receipt or Ready authority. */
export class StoreRuntimeContext implements SessionRuntimeContext {
  static #constructionOwners = new Set<ConstructionOwner>();
  readonly distribution = "microsoft-store" as const;
  readonly storeIssuer: StoreNodeIssuer;
  readonly configuration: StoreSessionConfiguration;
  readonly binding: StorePreparationBinding;
  readonly manifest: WindowsReleaseManifest;
  readonly generation: string;
  readonly native: WindowsConsumerNative;
  readonly sessionNative: SessionNativePort;
  #gate: SessionPreparationGate;
  #singleton: ConsumerMutexLease | null = null;
  #guardians = new Map<SessionRole, WindowsConsumerNative>();
  #ending = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #closeFailures: Promise<void>[] = [];
  #issuerCloseStarted = false;
  private constructor(
    token: symbol,
    issuer: StoreNodeIssuer,
    native: WindowsConsumerNative,
    binding: StorePreparationBinding,
    manifest: WindowsReleaseManifest,
    configuration: StoreSessionConfiguration,
  ) {
    if (token !== TOKEN || issuer.nodeRole !== "session-agent") deny();
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    this.storeIssuer = issuer;
    this.native = native;
    this.binding = binding;
    this.manifest = manifest;
    this.configuration = configuration;
    this.generation = issuer.inventorySha256;
    this.#gate = new SessionPreparationGate(native);
    this.sessionNative = Object.freeze({
      identity: () => native.identity(),
      acquireSessionLock: async () => {
        if (this.#ending || !this.#singleton) deny();
        await native.identity();
        return this.#singleton;
      },
      releaseSessionLock: async (nonce: string) => {
        if (!this.#singleton || this.#singleton.nonce !== nonce) deny();
        await StoreNodeIssuer.prototype.retireSessionChildren.call(
          issuer,
          native,
        );
        await native.releaseMutex(this.#singleton);
        this.#singleton = null;
      },
      processIdentity: (pid: number) => native.processIdentity(pid),
      launchOwned: async (role: SessionRole, generation: string) => {
        if (this.#ending || generation !== this.generation) deny();
        return this.#gate.launch(async () =>
          (await this.guardian(role)).launchOwned(role, generation),
        );
      },
      stopOwned: async (owner: ConsumerOwnedProcess) => {
        if (owner.role !== "personal" && owner.role !== "fleet") deny();
        await (await this.guardian(owner.role)).stopOwned(owner);
      },
      ownedTreeExited: (owner: ConsumerOwnedProcess) =>
        native.ownedTreeExited(owner),
      inspectStartup: () => native.inspectStartup(),
      legacyWorkerConflict: () => native.legacyWorkerConflict(),
      processingAdmissionReady: async () => {
        if (this.#ending || !this.#singleton) return false;
        const lease = await native.acquireMutex("prepare");
        if (!lease) return false;
        try {
          const wal = await native.vaultRead("account", "prepare_maintenance");
          try {
            return wal === null;
          } finally {
            wal?.fill(0);
          }
        } finally {
          await native.releaseMutex(lease);
        }
      },
      close: () => this.close(),
    });
    Object.freeze(this);
  }
  static async open(): Promise<StoreRuntimeContext> {
    if (arguments.length !== 0) deny();
    const issuer = await StoreNodeIssuer.open();
    const owner: ConstructionOwner = { issuer };
    this.#constructionOwners.add(owner);
    let native: WindowsConsumerNative | undefined,
      context: StoreRuntimeContext | undefined;
    try {
      if (issuer.nodeRole !== "session-agent") deny();
      const view = await issuer.codeView();
      native = await issuer.openNative();
      owner.native = native;
      const host = await native.identity();
      if (
        !sameConsumerProcess(issuer.owner.identity, issuer.receipt.parent) ||
        host.sid !== view.binding.sid ||
        host.sessionId !== issuer.owner.identity.sessionId
      )
        deny();
      const launchFiles: Record<string, string> = Object.create(null);
      for (const path of FIXED) {
        const entry = view.manifest.entries.find(
          (row) => row.path === path && row.kind === "file",
        );
        if (!entry || entry.kind !== "file" || entry.bytes < 1) deny();
        launchFiles[path] = entry.sha256;
      }
      const configuration: StoreSessionConfiguration = Object.freeze({
        version: 1,
        kind: "session-agent",
        installationProfile: "windows-user",
        distribution: "microsoft-store",
        generation: issuer.inventorySha256,
        release: issuer.inventorySha256,
        releaseRoot: issuer.workerRoot,
        nativeSha256: launchFiles["runtime/native/musicmute-native.exe"]!,
        personalRoot: win32.join(
          host.localAppData,
          PACKAGE_DATA_ROOT_NAMES.personal,
        ),
        fleetRoot: win32.join(host.localAppData, PACKAGE_DATA_ROOT_NAMES.fleet),
        launchFiles: Object.freeze(launchFiles),
        packageFullName: view.binding.package.fullName,
        runtimeManifestSha256: view.binding.runtimeManifestSha256,
      });
      context = new StoreRuntimeContext(
        TOKEN,
        issuer,
        native,
        view.binding,
        view.manifest,
        configuration,
      );
      owner.context = context;
      context.#singleton = await native.acquireMutex("session");
      if (!context.#singleton) deny();
      // The independent control Session must be reachable while a genuine
      // GUI Prepare owner holds the prepare mutex/WAL. Processing launches
      // still take Gate.launch; publication grants no mutation or idle claim.
      await native.ensurePrivateDirectory("personal", "");
      await native.ensurePrivateDirectory("fleet", "");
      this.#constructionOwners.delete(owner);
      return context;
    } catch (error) {
      owner.failure = this.#retireConstruction(owner);
      try {
        await owner.failure;
        this.#constructionOwners.delete(owner);
      } catch {
        // Keep the actual partial owner and original failed promise reachable
        // for explicit recovery; an unknown tree is never marked closed.
      }
      throw error;
    }
  }
  static async #retireConstruction(owner: ConstructionOwner): Promise<void> {
    if (owner.context) {
      if (owner.failure) await owner.context.recoverClose();
      else await owner.context.close();
    } else {
      await owner.native?.close();
      if (owner.failure)
        await StoreNodeIssuer.prototype.recoverClose.call(owner.issuer);
      else await StoreNodeIssuer.prototype.close.call(owner.issuer);
    }
  }
  static async recoverFailedOpen(): Promise<void> {
    if (arguments.length !== 0) deny();
    for (const owner of this.#constructionOwners) {
      if (!owner.failure) deny();
      await owner.failure.catch(() => {});
      await this.#retireConstruction(owner);
      this.#constructionOwners.delete(owner);
    }
  }
  assertNative(native: WindowsConsumerNative): void {
    if (arguments.length !== 1 || this.#closed) deny();
    StoreNodeIssuer.prototype.assertNative.call(this.storeIssuer, native);
  }
  async openNative(): Promise<WindowsConsumerNative> {
    if (arguments.length !== 0 || this.#ending || this.#closed) deny();
    return StoreNodeIssuer.prototype.openNative.call(this.storeIssuer);
  }
  async guardian(role: SessionRole): Promise<WindowsConsumerNative> {
    if (
      arguments.length !== 1 ||
      (role !== "personal" && role !== "fleet") ||
      this.#closed
    )
      deny();
    let native = this.#guardians.get(role);
    if (!native) {
      native = await this.openNative();
      this.#guardians.set(role, native);
    }
    this.assertNative(native);
    return native;
  }
  async verifyOwnedPeer(
    owner: ConsumerOwnedProcess,
    peer: ConsumerProcessIdentity,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      this.#closed ||
      (owner.role !== "personal" && owner.role !== "fleet") ||
      !(await (await this.guardian(owner.role)).isOwnedProcess(owner, peer))
    )
      deny();
  }
  async verifyGuiPeer(peer: ConsumerProcessIdentity): Promise<boolean> {
    if (arguments.length !== 1 || this.#closed || this.#ending) deny();
    return StoreNodeIssuer.prototype.verifyControlPeer.call(
      this.storeIssuer,
      peer,
      "gui",
    );
  }
  async completeStartup(): Promise<void> {
    if (arguments.length !== 0 || this.#ending || !this.#singleton) deny();
    await this.#gate.completeStartup();
    await StoreNodeIssuer.prototype.publishSession.call(
      this.storeIssuer,
      this.native,
    );
  }
  close(): Promise<void> {
    if (arguments.length !== 0) return Promise.reject(new Error(DENIED));
    if (this.#closed) return Promise.resolve();
    this.#ending = true;
    return (this.#closing ??= this.#close());
  }
  async recoverClose(): Promise<void> {
    if (arguments.length !== 0 || !this.#ending || this.#closed) deny();
    if (this.#closing) {
      this.#closeFailures.push(this.#closing);
      await this.#closing.catch(() => {});
    }
    this.#closing = this.#close();
    return this.#closing;
  }
  async #close(): Promise<void> {
    if (this.#singleton) {
      await StoreNodeIssuer.prototype.retireSessionChildren.call(
        this.storeIssuer,
        this.native,
      );
      await this.#gate.completeStartup();
      await this.native.releaseMutex(this.#singleton);
      this.#singleton = null;
    }
    if (this.#issuerCloseStarted)
      await StoreNodeIssuer.prototype.recoverClose.call(this.storeIssuer);
    else {
      this.#issuerCloseStarted = true;
      await StoreNodeIssuer.prototype.close.call(this.storeIssuer);
    }
    this.#closed = true;
  }
}
