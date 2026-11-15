import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { win32 } from "node:path";
import {
  attemptInputExtension,
  type AttemptWorkspace,
  type RuntimeWorkspace,
} from "../../../../worker/src/runtime/workspace.js";
import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import {
  StoreNodeIssuer,
  StoreFleetAttemptLease,
} from "../session/store-node-issuer.js";

const TOKEN = Symbol("store-fleet-workspace"),
  DENIED = "STORE_FLEET_WORKSPACE_DENIED",
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
interface CreationOwner {
  readonly attemptId: string;
  readonly extension: string;
  lease?: StoreFleetAttemptLease;
  paths?: AttemptWorkspace;
  opening?: Promise<AttemptWorkspace>;
  failure?: unknown;
  failed: boolean;
  readonly failures: Promise<AttemptWorkspace>[];
  retirement?: Promise<void>;
  retirementFailed: boolean;
  retireStarted: boolean;
  readonly retirementFailures: Promise<void>[];
}
function denied(): never {
  throw new Error(DENIED);
}
function association(
  host: HostContext,
  issuer: StoreNodeIssuer,
): WindowsConsumerNative {
  const role = Object.getOwnPropertyDescriptor(
    StoreNodeIssuer.prototype,
    "nodeRole",
  )!.get!.call(issuer);
  if (role !== "fleet") denied();
  const descriptor = Object.getOwnPropertyDescriptor(host, "native");
  if (!descriptor || !("value" in descriptor)) denied();
  const native = descriptor.value as WindowsConsumerNative;
  StoreNodeIssuer.prototype.assertNative.call(issuer, native);
  return native;
}
/** The actual private lease owns creation and guarded retirement. This adapter
 * never prunes a PID marker, reopens a replacement path or deletes a directory. */
export class StoreFleetWorkspace implements RuntimeWorkspace {
  #host: HostContext;
  #issuer: StoreNodeIssuer;
  #native: WindowsConsumerNative;
  #workRoot: string;
  #initialized = false;
  #owners = new Map<string, CreationOwner>();
  #workspaces = new WeakMap<AttemptWorkspace, CreationOwner>();
  private constructor(
    token: symbol,
    host: HostContext,
    issuer: StoreNodeIssuer,
    native: WindowsConsumerNative,
    root: string,
  ) {
    if (token !== TOKEN || association(host, issuer) !== native) denied();
    this.#host = host;
    this.#issuer = issuer;
    this.#native = native;
    this.#workRoot = root;
    Object.freeze(this);
  }
  static async open(
    host: HostContext,
    issuer: StoreNodeIssuer,
  ): Promise<StoreFleetWorkspace> {
    if (arguments.length !== 2) denied();
    const native = association(host, issuer),
      identity = await native.identity(),
      view = await StoreNodeIssuer.prototype.codeView.call(issuer),
      fleetRoot = win32.join(
        identity.localAppData,
        PACKAGE_DATA_ROOT_NAMES.fleet,
      );
    if (
      view.binding.sid !== identity.sid ||
      host.identity.sid !== identity.sid ||
      win32.normalize(host.personalRoot).toLowerCase() !==
        win32
          .join(identity.localAppData, PACKAGE_DATA_ROOT_NAMES.personal)
          .toLowerCase()
    )
      denied();
    association(host, issuer);
    return new StoreFleetWorkspace(
      TOKEN,
      host,
      issuer,
      native,
      win32.join(fleetRoot, "work"),
    );
  }
  assertIssuer(issuer: StoreNodeIssuer): void {
    if (
      arguments.length !== 1 ||
      issuer !== this.#issuer ||
      association(this.#host, this.#issuer) !== this.#native
    )
      denied();
  }
  async #current(): Promise<void> {
    this.assertIssuer(this.#issuer);
    const view = await StoreNodeIssuer.prototype.codeView.call(this.#issuer);
    if (
      view.binding.inventorySha256 !== this.#issuer.inventorySha256 ||
      view.binding.sid !== this.#host.identity.sid
    )
      denied();
    this.assertIssuer(this.#issuer);
  }
  async initialize(): Promise<void> {
    if (arguments.length !== 0) denied();
    await this.#current();
    await this.#native.ensurePrivateDirectory("fleet", "work");
    await this.#current();
    // Preserve unknown old attempts. Only a retained actual lease can retire
    // its original directory; a missing process or marker supplies no proof.
    this.#initialized = true;
  }
  async create(
    attemptId: string,
    contentType: string,
  ): Promise<AttemptWorkspace> {
    if (
      arguments.length !== 2 ||
      !this.#initialized ||
      typeof attemptId !== "string" ||
      !UUID.test(attemptId)
    )
      denied();
    this.assertIssuer(this.#issuer);
    const extension = attemptInputExtension(contentType).slice(1);
    let owner = this.#owners.get(attemptId);
    if (owner && (owner.extension !== extension || owner.paths)) denied();
    if (!owner) {
      owner = {
        attemptId,
        extension,
        failed: false,
        failures: [],
        retirementFailed: false,
        retireStarted: false,
        retirementFailures: [],
      };
      // Retain the original creation before opening a helper/directory.
      this.#owners.set(attemptId, owner);
    }
    if (owner.opening && !owner.failed) return owner.opening;
    if (owner.opening) owner.failures.push(owner.opening);
    owner.failure = undefined;
    owner.failed = false;
    owner.opening = this.#open(owner);
    void owner.opening.catch(() => {});
    return owner.opening;
  }
  async #open(owner: CreationOwner): Promise<AttemptWorkspace> {
    try {
      await this.#current();
      const lease = await StoreNodeIssuer.prototype.openFleetAttempt.call(
        this.#issuer,
        this.#native,
        owner.attemptId,
        owner.extension,
      );
      if (owner.lease && lease !== owner.lease) denied();
      owner.lease = lease;
      StoreFleetAttemptLease.prototype.assertHost.call(lease, this.#host);
      const state = await StoreFleetAttemptLease.prototype.inspect.call(lease);
      if (!state.quiescent) throw new Error("STORE_FLEET_WORKSPACE_PENDING");
      if (state.retired) {
        // A failed original creation can settle without ever owning a
        // directory birth. Its private lease supplies the positive retirement;
        // no paths or replacement directory are manufactured here.
        if (this.#owners.get(owner.attemptId) === owner)
          this.#owners.delete(owner.attemptId);
        denied();
      }
      const observed = StoreFleetAttemptLease.prototype.paths.call(lease),
        root = win32.join(this.#workRoot, owner.attemptId);
      if (
        observed.root !== root ||
        observed.input !== win32.join(root, `input.${owner.extension}`) ||
        observed.output !== win32.join(root, "output", "vocals.mp3")
      )
        denied();
      await this.#current();
      const paths = Object.freeze({
        root: observed.root,
        input: observed.input,
        output: observed.output,
      });
      owner.paths = paths;
      this.#workspaces.set(paths, owner);
      return paths;
    } catch (error) {
      owner.failure = error;
      owner.failed = true;
      throw error;
    }
  }
  async cleanup(workspace: AttemptWorkspace): Promise<void> {
    if (arguments.length !== 1 || !workspace || typeof workspace !== "object")
      denied();
    const owner = this.#workspaces.get(workspace);
    if (
      !owner?.lease ||
      owner.paths !== workspace ||
      this.#owners.get(owner.attemptId) !== owner
    )
      denied();
    if (owner.retirement && !owner.retirementFailed) return owner.retirement;
    if (owner.retirement) owner.retirementFailures.push(owner.retirement);
    owner.retirementFailed = false;
    owner.retirement = this.#retire(owner, workspace);
    void owner.retirement.catch(() => {});
    return owner.retirement;
  }
  async #retire(
    owner: CreationOwner,
    workspace: AttemptWorkspace,
  ): Promise<void> {
    try {
      this.assertIssuer(this.#issuer);
      const lease = owner.lease!;
      StoreFleetAttemptLease.prototype.assertHost.call(lease, this.#host);
      const state = await StoreFleetAttemptLease.prototype.inspect.call(lease);
      if (!state.quiescent) throw new Error("STORE_FLEET_WORKSPACE_PENDING");
      // The private native owner checks the original Job/EOF/engine witness and
      // closes all original handles before deleting its directory/receipt.
      if (owner.retireStarted)
        await StoreFleetAttemptLease.prototype.recoverRetire.call(lease);
      else {
        owner.retireStarted = true;
        await StoreFleetAttemptLease.prototype.retire.call(lease);
      }
      this.#workspaces.delete(workspace);
      this.#owners.delete(owner.attemptId);
    } catch (error) {
      owner.retirementFailed = true;
      throw error;
    }
  }
}
