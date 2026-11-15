import { createHash } from "node:crypto";
import { isStoreSessionCleanupCommand } from "../../shared/store-session-cleanup.js";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { PACKAGE_AUTHORITY_PROFILE } from "../../shared/package-build-profile.js";
import {
  createStoreConsumerNativeTransport,
  type ConsumerNativeTransport,
} from "../../../../worker/src/platform/windows/consumer-native-transport.js";
import type { ConsumerProcessIdentity } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  parseStoreBootReceipt,
  type StoreBootReceipt,
} from "../../shared/store-boot-receipt.js";
export {
  parseStoreBootReceipt,
  type StoreBootReceipt,
} from "../../shared/store-boot-receipt.js";
import {
  parseStoreResourceIndexBytes,
  type StoreResourceIndex,
} from "./store-resource-index.js";
import {
  ConsumerNativeError,
  WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { StoreGuiBootstrapIssuer } from "./store-gui-issuer.js";
import { StoreGuiBootstrapDiagnostics } from "./store-bootstrap-diagnostics.js";
import {
  parseStoreWorkerPackageObservation,
  type StoreWorkerPackageObservation,
} from "./store-worker-package.js";
import {
  parseStoreWorkerCodeObservation,
  parseStoreWorkerBenchmarkObservation,
  parseStoreWorkerRuntimeManifest,
  parseStoreWorkerSessionActivation,
  storeWorkerManifestPath,
  type StoreWorkerCodeObservation,
  type StoreWorkerBenchmarkObservation,
} from "./store-worker-code.js";
import {
  parseStoreBrowserAttachInput,
  parseStoreBrowserAttachment,
  parseStoreBrowserRegistration,
  type StoreBrowserAttachInput,
  type StoreBrowserAttachment,
  type StoreBrowserIntent,
  type StoreBrowserRegistration,
} from "./store-registration.js";
import {
  registerStoreGuiCreator,
  type StoreGuiCreatorLease,
} from "./store-gui-creator.js";
import {
  parseStoreAccountInput,
  parseStoreAccountResult,
  type StoreAccountOperation,
} from "./store-account-native.js";
import { PERSONAL_RECIPE_DIGESTS } from "../personal/timeline.js";
import type { StorePreparationBinding } from "../prepare/store-model-ready.js";
import {
  parseStoreShareInput,
  type StoreShareOperation,
} from "../share/store-share-native.js";
import type { ConsumerNativeEvent } from "../../../../worker/src/platform/windows/consumer-native-events.js";

const GUI_DATA_OPERATIONS = new Set([
  "identity",
  "boot_identity",
  "process_identity",
  "ensure_private_directory",
  "validate_path",
  "private_file_open",
  "store_fixture_file_open",
  "store_model_file_open",
  "store_model_publish",
  "store_model_recover",
  "private_file_info",
  "private_file_read",
  "private_file_write",
  "private_file_truncate",
  "private_file_sync",
  "private_file_close",
  "vault_put",
  "vault_get",
  "vault_delete",
  "vault_recover",
  "acquire_mutex",
  "release_mutex",
  "gpu_inventory",
  "singleton_inspect",
  "cache_delete_begin",
  "cache_delete_commit",
  "cache_delete_release",
  "cache_delete_recover",
  "share_workspace_discard",
  "diagnostic_report_remove",
  "personal_cleanup_recover",
  "storage_partial_discard",
  "library_artifact_discard",
  "library_tree_discard",
  "library_tree_cleanup_ack",
  "library_tree_cleanup_list",
  "library_local_move",
  "library_artifact_publish",
  "library_artifact_publication_inspect",
  "storage_workspace_marker_retire",
  "store_cpu_workspace_marker_retire",
  "store_cpu_operation_cleanup_inspect",
  "store_cpu_workspace_marker_acknowledge",
  "store_cpu_workspace_marker_release",
  "storage_cleanup_ack",
  "storage_cleanup_recover",
]);

export interface StoreFilePin {
  readonly bytes: number;
  readonly sha256: string;
}
export type StoreNativeParentRole =
  "gui-application" | "worker-node" | "worker-controls" | "worker-session";
export interface StoreGuiCreatorProof {
  readonly version: 1;
  readonly gui: ConsumerProcessIdentity;
  readonly helper: ConsumerProcessIdentity;
  readonly packageFullName: string;
}
export type StoreSessionOperation =
  | "store_session_presence"
  | "store_session_open"
  | "store_session_command"
  | "store_session_close";
const HASH = /^[a-f0-9]{64}$/u;
const AUTHORITY = Symbol("live-store-native-authority");
const dataNativeAuthorities = new WeakMap<
  WindowsConsumerNative,
  StoreNativeAuthority
>();
/** Lookup only; exclusively populated by successful fixed private bootstrap.
 * Constructing WindowsConsumerNative with a fixture/foreign transport cannot
 * create this association or executable/package authority. */
export function storeAuthorityForDataNative(
  native: object,
): StoreNativeAuthority | undefined {
  return dataNativeAuthorities.get(native as WindowsConsumerNative);
}
function denied(): never {
  throw new Error("STORE_AUTHORITY_DENIED");
}
function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    denied();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((name) => typeof name !== "string" || !names.includes(name))
  )
    denied();
  const row: Record<string, unknown> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !("value" in descriptor)) denied();
    row[name] = descriptor.value;
  }
  return row;
}
function pin(value: StoreFilePin): StoreFilePin {
  const row = exact(value, ["bytes", "sha256"]);
  if (
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > 4 * 1024 ** 3 ||
    typeof row.sha256 !== "string" ||
    !HASH.test(row.sha256)
  )
    denied();
  return Object.freeze({ bytes: row.bytes as number, sha256: row.sha256 });
}
function relativePath(value: string) {
  if (
    !value ||
    value.length > 1024 ||
    value.includes("\\") ||
    /[\p{Cc}\p{Cf}<>:"|?*]/u.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
      )
  )
    denied();
  return value;
}
/** A live transport is the authority. It never accepts an imported receipt,
 * injected success adapter, unsigned fixture, or environment-selected package. */
export class StoreNativeAuthority {
  #closed = false;
  #dataStarted = false;
  #dataOpened = false;
  #browserAttachStarted = false;
  #browserAttachment: StoreBrowserAttachment | undefined;
  #browserSource: StoreNativeAuthority | undefined;
  #guiPeerSource: StoreNativeAuthority | undefined;
  #dataNative: WindowsConsumerNative | undefined;
  #browserPeers = new Set<StoreNativeAuthority>();
  #browserOpenings = new Set<Promise<StoreNativeAuthority>>();
  #creatorLease: StoreGuiCreatorLease | undefined;
  #workerCodeOpened = false;
  #workerCodeObservation: StoreWorkerCodeObservation | undefined;
  #workerCodeOwner: StoreWorkerCodeAuthority | undefined;
  #closing: Promise<void> | undefined;
  #developmentCloseDiagnostic: Promise<Error | undefined> | undefined;
  #transport: ConsumerNativeTransport;
  readonly receipt: StoreBootReceipt;
  readonly resourceIndex: StoreResourceIndex;
  readonly resourceInventorySha256: string;
  private constructor(
    token: symbol,
    transport: ConsumerNativeTransport,
    receipt: StoreBootReceipt,
    resourceIndex: StoreResourceIndex,
    resourceInventorySha256: string,
  ) {
    if (token !== AUTHORITY) denied();
    this.#transport = transport;
    this.receipt = receipt;
    this.resourceIndex = resourceIndex;
    this.resourceInventorySha256 = resourceInventorySha256;
    transport.onClosed?.(() => {
      // Fence the private proof synchronously, even if asynchronous endpoint
      // retirement/transport teardown subsequently needs error recovery.
      this.#closed = true;
      void this.close().catch(() => undefined);
    });
    Object.freeze(this);
  }
  /** Bootstrap only the running packaged Electron GUI. The helper pin is read
   * inside its integrity-sealed ASAR, never supplied by a caller or sidecar.
   * Electron's package-presence bit is only a routing prerequisite. The native
   * executable independently proves actual Store origin, generation and parent. */
  static async open(): Promise<StoreNativeAuthority> {
    if (arguments.length !== 0) denied();
    const diagnostics = new StoreGuiBootstrapDiagnostics();
    try {
      return await StoreNativeAuthority.#openPackaged(diagnostics);
    } catch {
      throw diagnostics.failure();
    }
  }
  static async #openPackaged(
    diagnostics: StoreGuiBootstrapDiagnostics,
  ): Promise<StoreNativeAuthority> {
    if (process.versions.electron !== undefined) {
      if (process.platform !== "win32" || process.arch !== "x64") denied();
      const { app } = await import("electron");
      const runtime = process as NodeJS.Process & {
        resourcesPath?: string;
        windowsStore?: boolean;
      };
      const resources = runtime.resourcesPath;
      if (
        !app.isPackaged ||
        runtime.windowsStore !== true ||
        typeof resources !== "string" ||
        !win32.isAbsolute(resources) ||
        win32.resolve(app.getAppPath()).toLowerCase() !==
          win32.join(resources, "app.asar").toLowerCase() ||
        win32.resolve(process.execPath).toLowerCase() !==
          win32
            .join(win32.dirname(resources), "MusicMute Local.exe")
            .toLowerCase()
      )
        denied();
      diagnostics.phase("resource-seal");
      const sealPath = win32.join(app.getAppPath(), "packaged-resources.json");
      const sealInfo = await lstat(sealPath);
      if (
        !sealInfo.isFile() ||
        sealInfo.isSymbolicLink() ||
        sealInfo.size < 1 ||
        sealInfo.size > 65536
      )
        denied();
      const sealBytes = await readFile(sealPath);
      const resourceIndex = parseStoreResourceIndexBytes(sealBytes);
      if (resourceIndex.authority.role !== "gui") denied();
      diagnostics.phase("helper-pin");
      const helperEntry = resourceIndex.entries.find(
        (entry) =>
          entry.placement === "resources" &&
          entry.path === "native/musicmute-native.exe",
      );
      if (!helperEntry) denied();
      const helper = pin({
        bytes: helperEntry.bytes,
        sha256: helperEntry.sha256,
      });
      const helperPath = win32.join(
        resources,
        "native",
        "musicmute-native.exe",
      );
      diagnostics.phase("issuer-open");
      const issuer = await StoreGuiBootstrapIssuer.open();
      let transport:
        | Awaited<ReturnType<typeof createStoreConsumerNativeTransport>>
        | undefined;
      try {
        diagnostics.phase("helper-spawn");
        transport = await createStoreConsumerNativeTransport(
          helperPath,
          helper.sha256,
        );
        diagnostics.transport(transport);
        const issuerNonce = issuer.bindSpawnedProcess(
          transport.spawnedProcessId ?? 0,
        );
        diagnostics.phase("native-boot");
        const receipt = parseStoreBootReceipt(
          "gui",
          await transport.request(
            "store_boot",
            {
              role: "gui",
              parent_role: "gui-application",
              issuer_nonce: issuerNonce,
            },
            35000,
          ),
          process.pid,
          transport.spawnedProcessId ?? 0,
        );
        if (
          win32.resolve(helperPath).toLowerCase() !==
            win32
              .join(
                receipt.package.installedLocation,
                "app",
                "resources",
                "native",
                "musicmute-native.exe",
              )
              .toLowerCase() ||
          receipt.package.packageVersion.split(".").slice(0, 3).join(".") !==
            resourceIndex.appVersion
        )
          denied();
        diagnostics.phase("issuer-confirm");
        await issuer.confirmBootHelper(
          receipt.helper.pid,
          receipt.helper.creationTime,
        );
        await issuer.close();
        const authority = new StoreNativeAuthority(
          AUTHORITY,
          transport,
          receipt,
          resourceIndex,
          createHash("sha256").update(sealBytes).digest("hex"),
        );
        // Do not publish partial authority before every ASAR-sealed resource was
        // read under actual native immutable-package leases.
        diagnostics.phase("sealed-resources");
        for (const entry of resourceIndex.entries)
          await authority.readResource(
            `app/${entry.placement === "resources" ? "resources/" : ""}${entry.path}`,
            { bytes: entry.bytes, sha256: entry.sha256 },
            entry.bytes,
          );
        return authority;
      } catch {
        await transport?.close();
        return denied();
      } finally {
        await issuer.close();
      }
    }
    return denied();
  }
  /** Native retains the immutable root, ancestors and file while Node reads;
   * revalidation on release detects servicing/generation changes. Private mutable
   * file rules are deliberately not used or relaxed here. */
  async readResource(
    path: string,
    expected: StoreFilePin,
    maximum: number,
  ): Promise<Buffer> {
    if (
      this.#closed ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 256 * 1024 ** 2
    )
      denied();
    const relative = relativePath(path),
      expectedPin = pin(expected);
    if (expectedPin.bytes > maximum) denied();
    try {
      const raw = await this.#transport.request("store_package_lock", {
        path: relative,
        sha256: expectedPin.sha256,
        bytes: expectedPin.bytes,
      });
      const lease = exact(raw, [
        "token",
        "path",
        "full_name",
        "sha256",
        "bytes",
      ]);
      const absolute = win32.join(
        this.receipt.package.installedLocation,
        ...relative.split("/"),
      );
      if (
        typeof lease.token !== "string" ||
        !HASH.test(lease.token) ||
        lease.path !== absolute ||
        lease.full_name !== this.receipt.package.fullName ||
        lease.sha256 !== expectedPin.sha256 ||
        lease.bytes !== expectedPin.bytes
      )
        denied();
      try {
        const info = await lstat(absolute);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink < 1 ||
          info.size !== expectedPin.bytes
        )
          denied();
        const bytes = await readFile(absolute);
        if (
          bytes.length !== expectedPin.bytes ||
          createHash("sha256").update(bytes).digest("hex") !==
            expectedPin.sha256
        )
          denied();
        return bytes;
      } finally {
        const released = exact(
          await this.#transport.request("store_package_release", {
            token: lease.token,
          }),
          ["released"],
        );
        if (released.released !== true) denied();
      }
    } catch {
      // A failed lease/revalidation can mean servicing replaced the generation.
      // Retire all held leases and the private data port before another read.
      await this.close();
      return denied();
    }
  }
  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const lease = this.#creatorLease;
    this.#creatorLease = undefined;
    return (this.#closing = (async () => {
      await Promise.allSettled(this.#browserOpenings);
      const peers = await Promise.allSettled(
        [...this.#browserPeers].map((peer) =>
          StoreNativeAuthority.prototype.close.call(peer),
        ),
      );
      try {
        await lease?.close();
      } finally {
        await this.#transport.close();
      }
      if (this.#guiPeerSource) this.#guiPeerSource.#browserPeers.delete(this);
      const failures = peers.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "STORE_BROWSER_PEER_CLEANUP_UNCONFIRMED",
        );
    })());
  }
  /** Development observation only. The existing close owns all retirement;
   * this cached diagnostic waits for its stream drain without starting work. */
  developmentClosedFailure(): Promise<Error | undefined> {
    if (PACKAGE_AUTHORITY_PROFILE !== "local-test-v1")
      return Promise.resolve(undefined);
    if (arguments.length !== 0 || !this.#closed || !this.#closing)
      return Promise.resolve(undefined);
    if (!this.#developmentCloseDiagnostic) {
      const diagnostic = new StoreGuiBootstrapDiagnostics();
      diagnostic.phase("account-owner");
      diagnostic.transport(this.#transport);
      this.#developmentCloseDiagnostic = diagnostic.closedFailure(
        this.#closing,
      );
    }
    return this.#developmentCloseDiagnostic;
  }
  /** Live private brand/state supplement for the GUI's read-only creator table.
   * This immutable observation makes no native RPC (listeners can be blocked
   * accepting a pipe). Native still proves actual peer/GUI code, birth, logon,
   * current package generation and kernel endpoint PID on every admission. */
  creatorProof(): StoreGuiCreatorProof {
    if (
      arguments.length !== 0 ||
      this.#closed ||
      !this.#dataOpened ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    return Object.freeze({
      version: 1,
      gui: this.receipt.parent,
      helper: this.receipt.helper,
      packageFullName: this.receipt.package.fullName,
    });
  }
  async accountOperation(
    operation: StoreAccountOperation,
    args: unknown,
  ): Promise<unknown> {
    if (
      arguments.length !== 2 ||
      this.#closed ||
      !this.#dataOpened ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    try {
      const request = parseStoreAccountInput(operation, args);
      const result = await this.#transport.request(
        operation,
        request,
        operation === "store_account_pipe_accept" ||
          operation === "store_account_pipe_connect"
          ? 35000
          : 12000,
      );
      // Receiving validation never supplies OS authority. Preserve validated
      // wire fields for the private Store account factory's typed conversion.
      parseStoreAccountResult(operation, result, this.receipt);
      return result;
    } catch (error) {
      await this.close();
      // An idle listener expires normally. Preserve only this authenticated
      // native timeout so the server can rotate that retired listener.
      if (
        operation === "store_account_pipe_accept" &&
        error instanceof ConsumerNativeError &&
        error.code === "TIMEOUT"
      )
        throw error;
      return denied();
    }
  }
  /** Read actual same-user installation state. Neither presence nor pair
   * compatibility grants processing readiness or executable launch authority. */
  async inspectWorker(): Promise<StoreWorkerPackageObservation> {
    if (
      arguments.length !== 0 ||
      this.#closed ||
      !this.#dataOpened ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    try {
      return parseStoreWorkerPackageObservation(
        await this.#transport.request("store_worker_discover", {}),
      );
    } catch {
      await this.close();
      return denied();
    }
  }
  /** Fixed GUI query backed by native's complete held Worker code census.
   * No caller-selected path, resource pin, imported observation or adapter. */
  async openWorkerCode(): Promise<StoreWorkerCodeAuthority> {
    if (
      arguments.length !== 0 ||
      this.#closed ||
      !this.#dataOpened ||
      this.#workerCodeOpened ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    this.#workerCodeOpened = true;
    try {
      const observation = parseStoreWorkerCodeObservation(
        await this.#transport.request("store_worker_code_open", {}, 35000),
        this.receipt.package,
      );
      if (this.#closed) denied();
      this.#workerCodeObservation = observation;
      const owner = new StoreWorkerCodeAuthority(AUTHORITY, this, observation);
      this.#workerCodeOwner = owner;
      return owner;
    } catch {
      await this.close();
      return denied();
    }
  }
  async checkWorkerCode(owner: StoreWorkerCodeAuthority): Promise<void> {
    if (
      arguments.length !== 1 ||
      owner !== this.#workerCodeOwner ||
      this.#closed ||
      !this.#workerCodeObservation
    )
      denied();
    try {
      const reply = exact(
        await this.#transport.request("store_worker_code_check", {}),
        ["valid"],
      );
      if (
        reply.valid !== true ||
        this.#closed ||
        owner !== this.#workerCodeOwner
      )
        denied();
    } catch {
      // Keep the original helper/code owner available for critical-code
      // cleanup. Ordinary checks still deny new work after watch invalidation.
      return denied();
    }
  }
  async checkWorkerCodeCleanup(owner: StoreWorkerCodeAuthority): Promise<void> {
    if (
      arguments.length !== 1 ||
      owner !== this.#workerCodeOwner ||
      this.#closed ||
      !this.#workerCodeObservation ||
      !this.#dataOpened ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    const reply = exact(
      await this.#transport.request("store_worker_code_cleanup_check", {}),
      ["valid"],
    );
    if (reply.valid !== true || this.#closed || owner !== this.#workerCodeOwner)
      denied();
  }
  async workerBenchmarkCodeView(
    owner: StoreWorkerCodeAuthority,
  ): Promise<StoreWorkerBenchmarkObservation> {
    if (
      arguments.length !== 1 ||
      owner !== this.#workerCodeOwner ||
      this.#closed ||
      !this.#workerCodeObservation ||
      !this.#dataOpened ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    const result = parseStoreWorkerBenchmarkObservation(
      await this.#transport.request("store_worker_code_benchmark", {}, 35000),
    );
    if (
      this.#closed ||
      owner !== this.#workerCodeOwner ||
      result.inventorySha256 !== this.#workerCodeObservation.inventorySha256 ||
      result.runtimeManifestSha256 !==
        this.#workerCodeObservation.manifest.sha256
    )
      denied();
    return result;
  }
  async readWorkerManifest(owner: StoreWorkerCodeAuthority) {
    if (
      arguments.length !== 1 ||
      owner !== this.#workerCodeOwner ||
      this.#closed ||
      !this.#workerCodeObservation
    )
      denied();
    try {
      await StoreNativeAuthority.prototype.checkWorkerCode.call(this, owner);
      const observation = this.#workerCodeObservation!,
        path = storeWorkerManifestPath(observation),
        info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink < 1 ||
        info.size !== observation.manifest.bytes
      )
        denied();
      const manifest = parseStoreWorkerRuntimeManifest(
        await readFile(path),
        observation,
      );
      await StoreNativeAuthority.prototype.checkWorkerCode.call(this, owner);
      return manifest;
    } catch {
      await this.close();
      return denied();
    }
  }
  async closeWorkerCode(owner: StoreWorkerCodeAuthority): Promise<void> {
    if (arguments.length !== 1 || owner !== this.#workerCodeOwner) denied();
    // A retired native helper has already released the same held code files;
    // join that exact transport retirement rather than minting another lease.
    if (this.#closed) return this.close();
    if (!this.#workerCodeObservation) denied();
    try {
      const reply = exact(
        await this.#transport.request("store_worker_code_close", {}),
        ["released"],
      );
      if (reply.released !== true || this.#closed) denied();
      this.#workerCodeObservation = undefined;
      this.#workerCodeOwner = undefined;
      this.#workerCodeOpened = false;
    } catch {
      await this.close();
      return denied();
    }
  }
  async activateWorkerSession(owner: StoreWorkerCodeAuthority) {
    if (
      arguments.length !== 1 ||
      owner !== this.#workerCodeOwner ||
      this.#closed ||
      !this.#dataOpened ||
      !this.#workerCodeObservation ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    try {
      const acknowledgement = parseStoreWorkerSessionActivation(
        await this.#transport.request(
          "store_worker_session_activate",
          {},
          35000,
        ),
        this.receipt.package,
      );
      if (
        this.#closed ||
        owner !== this.#workerCodeOwner ||
        acknowledgement.package.fullName !==
          this.#workerCodeObservation.package.fullName
      )
        denied();
      return acknowledgement;
    } catch {
      await this.close();
      return denied();
    }
  }
  async workerPreparationBinding(
    owner: StoreWorkerCodeAuthority,
  ): Promise<StorePreparationBinding> {
    if (
      arguments.length !== 1 ||
      owner !== this.#workerCodeOwner ||
      this.#closed ||
      !this.#workerCodeObservation
    )
      denied();
    try {
      await StoreNativeAuthority.prototype.readWorkerManifest.call(this, owner);
      const reply = exact(await this.#transport.request("boot_identity", {}), [
        "boot_id",
        "source",
      ]);
      if (
        reply.source !== "volatile-registry-witness-v1" ||
        typeof reply.boot_id !== "string" ||
        !HASH.test(reply.boot_id)
      )
        denied();
      await StoreNativeAuthority.prototype.checkWorkerCode.call(this, owner);
      const observation = this.#workerCodeObservation!;
      return Object.freeze({
        package: observation.package,
        inventorySha256: observation.inventorySha256,
        runtimeManifestSha256: observation.manifest.sha256,
        sid: this.receipt.helper.sid,
        bootIdentity: reply.boot_id,
        recipeDigests: Object.freeze({ ...PERSONAL_RECIPE_DIGESTS }),
      });
    } catch {
      await this.close();
      return denied();
    }
  }
  /** Actual same-helper code owner only. Native independently binds its fixed
   * Session creator/peer; command/result JSON is never that client authority.
   * Application errors leave the original owner available for exact cleanup. */
  async storeSessionOperation(
    owner: StoreWorkerCodeAuthority,
    operation: StoreSessionOperation,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (
      arguments.length !== 3 ||
      this.#closed ||
      owner !== this.#workerCodeOwner ||
      !this.#workerCodeObservation ||
      ![
        "store_session_open",
        "store_session_presence",
        "store_session_command",
        "store_session_close",
      ].includes(operation)
    )
      denied();
    const request = exact(
      input,
      operation === "store_session_command" ? ["command"] : [],
    );
    const check =
      operation === "store_session_close" ||
      (operation === "store_session_command" &&
        isStoreSessionCleanupCommand(request.command))
        ? StoreNativeAuthority.prototype.checkWorkerCodeCleanup
        : StoreNativeAuthority.prototype.checkWorkerCode;
    await check.call(this, owner);
    const result = await this.#transport.request(operation, request, 35000);
    await check.call(this, owner);
    return result;
  }
  async browserRegistration(
    intent: StoreBrowserIntent,
  ): Promise<StoreBrowserRegistration> {
    if (
      arguments.length !== 1 ||
      this.#closed ||
      !this.#dataOpened ||
      this.resourceIndex.authority.role !== "gui" ||
      !["inspect", "register", "remove"].includes(intent)
    )
      denied();
    try {
      return parseStoreBrowserRegistration(
        await this.#transport.request("store_browser_registration", {
          intent,
        }),
        this.receipt,
      );
    } catch {
      await this.close();
      return denied();
    }
  }
  async browserAttach(
    input: StoreBrowserAttachInput,
  ): Promise<StoreBrowserAttachment> {
    if (
      arguments.length !== 1 ||
      this.#closed ||
      !this.#dataOpened ||
      this.#browserAttachStarted ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    this.#browserAttachStarted = true;
    try {
      const request = parseStoreBrowserAttachInput(input);
      const result = parseStoreBrowserAttachment(
        await this.#transport.request("store_browser_attach", {
          host_pid: request.hostPid,
          nonce: request.nonce,
          origin: request.origin,
        }),
        this.receipt,
      );
      if (result.host.pid !== request.hostPid) denied();
      this.#browserAttachment = Object.freeze({
        ...result,
        host: Object.freeze({ ...result.host }),
        gui: Object.freeze({ ...result.gui }),
        chrome: Object.freeze({ ...result.chrome }),
      });
      if (!this.#creatorLease || this.#closed) denied();
      await this.#creatorLease.bindBrowserAttachment(this);
      if (this.#closed) denied();
      return result;
    } catch {
      await this.close();
      return denied();
    }
  }
  /** Only a successful native Chrome/host/GUI attachment creates this live
   * creator proof. Returned observations cannot bind another authority. */
  browserCreatorProof(): StoreBrowserAttachment {
    if (
      arguments.length !== 0 ||
      this.#closed ||
      !this.#dataOpened ||
      (!this.#browserAttachment && !this.#browserSource)
    )
      denied();
    if (this.#browserSource) {
      StoreNativeAuthority.prototype.browserSourceCreatorProof.call(this);
      return StoreNativeAuthority.prototype.browserCreatorProof.call(
        this.#browserSource,
      );
    }
    return this.#browserAttachment!;
  }
  /** Read-only lineage from the private original attached source. A returned
   * helper observation cannot register or mint another browser authority. */
  browserSourceCreatorProof(): StoreGuiCreatorProof {
    if (arguments.length !== 0 || this.#closed || !this.#dataOpened) denied();
    const source = this.#browserSource ?? this;
    if (
      source.#closed ||
      !source.#dataOpened ||
      !source.#browserAttachment ||
      source.#browserSource ||
      (source !== this && !source.#browserPeers.has(this))
    )
      denied();
    return StoreNativeAuthority.prototype.creatorProof.call(source);
  }
  /** Actual factory only: one newly bootstrapped helper derives from the exact
   * living original Chrome attachment, never from a caller PID/receipt. */
  static async openBrowserWaitingPeer(
    source: StoreNativeAuthority,
  ): Promise<StoreNativeAuthority> {
    if (arguments.length !== 1) denied();
    return StoreNativeAuthority.#openOwnedGuiPeer(source, true);
  }
  static async openSharePeer(
    source: StoreNativeAuthority,
  ): Promise<StoreNativeAuthority> {
    if (arguments.length !== 1) denied();
    return StoreNativeAuthority.#openOwnedGuiPeer(source, false);
  }
  static async #openOwnedGuiPeer(
    source: StoreNativeAuthority,
    browser: boolean,
  ): Promise<StoreNativeAuthority> {
    const sourceProof = () =>
      browser
        ? StoreNativeAuthority.prototype.browserSourceCreatorProof.call(source)
        : StoreNativeAuthority.prototype.creatorProof.call(source);
    const proof = sourceProof();
    if (
      source.#guiPeerSource ||
      source.#browserPeers.size + source.#browserOpenings.size >= 64
    )
      denied();
    const pending = (async () => {
      const peer = await StoreNativeAuthority.open();
      source.#browserPeers.add(peer);
      peer.#guiPeerSource = source;
      if (browser) peer.#browserSource = source;
      try {
        sourceProof();
        await StoreNativeAuthority.prototype.openGuiDataNative.call(peer);
        const current = sourceProof();
        const target = StoreNativeAuthority.prototype.creatorProof.call(peer);
        if (
          source.#closed ||
          peer.#closed ||
          !peer.#creatorLease ||
          current.helper.pid !== proof.helper.pid ||
          current.helper.creationTime !== proof.helper.creationTime ||
          target.packageFullName !== current.packageFullName ||
          target.gui.pid !== current.gui.pid ||
          target.gui.creationTime !== current.gui.creationTime ||
          target.gui.sid !== current.gui.sid ||
          target.gui.sessionId !== current.gui.sessionId
        )
          denied();
        if (browser) {
          await peer.#creatorLease.deriveBrowserSource(source);
          StoreNativeAuthority.prototype.browserSourceCreatorProof.call(peer);
        } else sourceProof();
        return peer;
      } catch (error) {
        // The source retains any partially opened child whose actual teardown
        // is uncertain. Its close joins the exact original owner.
        await StoreNativeAuthority.prototype.close.call(peer);
        throw error;
      }
    })();
    source.#browserOpenings.add(pending);
    try {
      return await pending;
    } finally {
      source.#browserOpenings.delete(pending);
    }
  }
  /** Borrow the exact already bootstrapped data object. Neither a receipt nor
   * a helper pathname can construct this capability. */
  borrowDataNative(): WindowsConsumerNative {
    if (arguments.length !== 0 || !this.#dataNative) denied();
    StoreNativeAuthority.prototype.creatorProof.call(this);
    return this.#dataNative;
  }
  async shareOperation(
    operation: StoreShareOperation,
    input: unknown,
  ): Promise<unknown> {
    if (arguments.length !== 2) denied();
    StoreNativeAuthority.prototype.creatorProof.call(this);
    const wire = parseStoreShareInput(operation, input),
      result = await this.#transport.request(operation, wire, 35000);
    StoreNativeAuthority.prototype.creatorProof.call(this);
    return result;
  }
  onShareEvent(listener: (event: ConsumerNativeEvent) => void): () => void {
    if (
      arguments.length !== 1 ||
      typeof listener !== "function" ||
      !this.#transport.onEvent
    )
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(this);
    return this.#transport.onEvent((event) => {
      if (event.kind !== "share" || this.#closed) return;
      try {
        StoreNativeAuthority.prototype.creatorProof.call(this);
      } catch {
        return;
      }
      if (
        event.receipt.windowOwner.sid !== this.receipt.parent.sid ||
        event.receipt.windowOwner.sessionId !== this.receipt.parent.sessionId
      )
        return;
      listener(structuredClone(event));
    });
  }
  onShareClosed(listener: () => void): () => void {
    if (
      arguments.length !== 1 ||
      typeof listener !== "function" ||
      !this.#transport.onClosed
    )
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(this);
    return this.#transport.onClosed(listener);
  }
  /** Admit the GUI's existing guarded data primitives through the actual Store
   * helper. Native independently requires the registered deployment manifest's
   * shared namespace and the directly attested GUI parent. Worker Node image
   * origin alone never gains script-role, session, fleet or GPU ownership. */
  async openGuiDataNative(): Promise<WindowsConsumerNative> {
    if (
      arguments.length !== 0 ||
      this.#closed ||
      this.#dataStarted ||
      this.resourceIndex.authority.role !== "gui"
    )
      denied();
    this.#dataStarted = true;
    const diagnostics = new StoreGuiBootstrapDiagnostics();
    diagnostics.phase("private-data");
    diagnostics.transport(this.#transport);
    try {
      const result = exact(
        await this.#transport.request("store_private_boot", {}),
        ["authorized", "namespace"],
      );
      if (result.authorized !== true || result.namespace !== "unvirtualized-v1")
        denied();
      const native = new WindowsConsumerNative({
        request: (operation, args, timeoutMs) => {
          if (this.#closed)
            return Promise.reject(
              new ConsumerNativeError("HELPER_UNAVAILABLE"),
            );
          if (!GUI_DATA_OPERATIONS.has(operation))
            return Promise.reject(
              new ConsumerNativeError("LAUNCH_VERIFICATION_REQUIRED"),
            );
          return this.#transport.request(operation, args, timeoutMs);
        },
        close: () => this.close(),
        ...(this.#transport.onEvent
          ? { onEvent: this.#transport.onEvent.bind(this.#transport) }
          : {}),
        ...(this.#transport.onClosed
          ? { onClosed: this.#transport.onClosed.bind(this.#transport) }
          : {}),
      });
      const identity = await native.identity();
      if (
        identity.sid !== this.receipt.helper.sid ||
        identity.sessionId !== this.receipt.helper.sessionId ||
        identity.pid !== this.receipt.helper.pid ||
        identity.creationTime !== this.receipt.helper.creationTime ||
        identity.logonSid !== this.receipt.logonSid
      )
        denied();
      this.#dataOpened = true;
      const creatorLease = await registerStoreGuiCreator(this);
      if (this.#closed) {
        await creatorLease.close();
        denied();
      }
      this.#creatorLease = creatorLease;
      dataNativeAuthorities.set(native, this);
      this.#dataNative = native;
      return native;
    } catch {
      await this.close();
      throw diagnostics.failure();
    }
  }
}

/** Only openWorkerCode's genuine GUI helper can mint this living code owner.
 * Its data observation describes a generation; it grants no role or GPU lease. */
export class StoreWorkerCodeAuthority {
  #closed = false;
  #closing: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #authority: StoreNativeAuthority;
  readonly observation: StoreWorkerCodeObservation;
  constructor(
    token: symbol,
    authority: StoreNativeAuthority,
    observation: StoreWorkerCodeObservation,
  ) {
    if (token !== AUTHORITY) denied();
    this.#authority = authority;
    this.observation = observation;
    Object.freeze(this);
  }
  async revalidate(): Promise<void> {
    if (arguments.length !== 0 || this.#closed) denied();
    await StoreNativeAuthority.prototype.checkWorkerCode.call(
      this.#authority,
      this,
    );
    if (this.#closed) denied();
  }
  /** Same original code owner, cleanup only; no resources, launch or Ready. */
  async revalidateCleanup(): Promise<void> {
    if (arguments.length !== 0 || this.#closed) denied();
    await StoreNativeAuthority.prototype.checkWorkerCodeCleanup.call(
      this.#authority,
      this,
    );
    if (this.#closed) denied();
  }
  assertDataNative(native: object): void {
    if (
      arguments.length !== 1 ||
      this.#closed ||
      dataNativeAuthorities.get(native as WindowsConsumerNative) !==
        this.#authority
    )
      denied();
    StoreNativeAuthority.prototype.creatorProof.call(this.#authority);
  }
  async readManifest() {
    if (arguments.length !== 0 || this.#closed) denied();
    const manifest =
      await StoreNativeAuthority.prototype.readWorkerManifest.call(
        this.#authority,
        this,
      );
    if (this.#closed) denied();
    return manifest;
  }
  async activateSession() {
    if (arguments.length !== 0 || this.#closed) denied();
    const acknowledgement =
      await StoreNativeAuthority.prototype.activateWorkerSession.call(
        this.#authority,
        this,
      );
    if (
      this.#closed ||
      acknowledgement.package.fullName !== this.observation.package.fullName
    )
      denied();
    return acknowledgement;
  }
  async preparationBinding(): Promise<StorePreparationBinding> {
    if (arguments.length !== 0 || this.#closed) denied();
    const binding =
      await StoreNativeAuthority.prototype.workerPreparationBinding.call(
        this.#authority,
        this,
      );
    if (this.#closed) denied();
    return binding;
  }
  async benchmarkCodeView(): Promise<StoreWorkerBenchmarkObservation> {
    if (arguments.length !== 0 || this.#closed) denied();
    const view =
      await StoreNativeAuthority.prototype.workerBenchmarkCodeView.call(
        this.#authority,
        this,
      );
    if (this.#closed) denied();
    return view;
  }
  close(): Promise<void> {
    if (arguments.length !== 0) denied();
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return (this.#closing = StoreNativeAuthority.prototype.closeWorkerCode.call(
      this.#authority,
      this,
    ));
  }
  /** Retry only the original owner. A lost code-close ACK may have retired its
   * helper; joining that same actual transport proves the held files released
   * without treating the failed ACK as success or opening a new generation. */
  recoverClose(): Promise<void> {
    if (arguments.length !== 0) denied();
    if (!this.#closing) return this.close();
    if (this.#recovering) return this.#recovering;
    const attempt = this.#closing.then(
      () => undefined,
      () =>
        StoreNativeAuthority.prototype.closeWorkerCode.call(
          this.#authority,
          this,
        ),
    );
    this.#recovering = attempt;
    void attempt.catch(() => {
      if (this.#recovering === attempt) this.#recovering = undefined;
    });
    return attempt;
  }
}
