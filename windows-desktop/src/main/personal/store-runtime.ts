import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { win32 } from "node:path";
import {
  resolveQualifiedGpuIdentity,
  type QualificationEvidence,
} from "../../../../worker/src/enrollment/report-builder.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import type { HostContext } from "../host-context.js";
import { privateFingerprint } from "../prepare/private-files.js";
import { readStoreRoleReadiness } from "../prepare/store-readiness.js";
import type { StorePreparationBinding } from "../prepare/store-model-ready.js";
import {
  StoreNodeIssuer,
  type StorePersonalEngineChild,
} from "../session/store-node-issuer.js";
import type { PersonalAgentConfiguration } from "./configuration.js";
import { PersonalFailure } from "./controller.js";
import { StoreMediaTools } from "../prepare/store-media-tools.js";
import type { StoreMediaConfiguration } from "../../shared/store-media-request.js";

export interface StorePersonalRunConfiguration extends Pick<
  PersonalAgentConfiguration,
  | "version"
  | "kind"
  | "installationProfile"
  | "release"
  | "releaseRoot"
  | "nativeSha256"
  | "personalRoot"
  | "sid"
  | "manifestSha256"
  | "qualification"
  | "bootIdentity"
  | "modelFingerprint"
> {
  readonly distribution: "microsoft-store";
  readonly ownerSessionId: number;
}
const TOKEN = Symbol("store-personal-runtime");
function deny(): never {
  throw new PersonalFailure("PREPARE_REQUIRED");
}
/** The same personal processing business logic uses live OS code without a
 * legacy archive/config receipt. This factory accepts only an actual personal
 * Node issuer and its own data helper. Public configuration remains data. */
export class StorePersonalRuntime {
  readonly configuration: StorePersonalRunConfiguration;
  #host: HostContext;
  #issuer: StoreNodeIssuer;
  #binding: StorePreparationBinding;
  #evidence: QualificationEvidence;
  #configurationBytes: string;
  private constructor(
    token: symbol,
    host: HostContext,
    issuer: StoreNodeIssuer,
    binding: StorePreparationBinding,
    configuration: StorePersonalRunConfiguration,
    evidence: QualificationEvidence,
  ) {
    if (token !== TOKEN) deny();
    this.#host = host;
    this.#issuer = issuer;
    this.#binding = binding;
    this.configuration = Object.freeze(configuration);
    this.#configurationBytes = JSON.stringify(configuration);
    this.#evidence = structuredClone(evidence);
    Object.freeze(this);
  }
  static async open(
    host: HostContext,
    issuer: StoreNodeIssuer,
  ): Promise<StorePersonalRuntime> {
    if (arguments.length !== 2) deny();
    StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
    if (issuer.nodeRole !== "personal") deny();
    const identity = await host.native.identity();
    if (
      identity.sid !== host.identity.sid ||
      identity.sessionId !== host.identity.sessionId ||
      host.personalRoot.toLowerCase() !==
        win32
          .join(identity.localAppData, PACKAGE_DATA_ROOT_NAMES.personal)
          .toLowerCase()
    )
      deny();
    const signal = new AbortController().signal,
      ready = await readStoreRoleReadiness(host, issuer, signal);
    if (!ready) deny();
    const view = await StoreNodeIssuer.prototype.codeView.call(issuer);
    if (JSON.stringify(view.binding) !== JSON.stringify(ready.binding)) deny();
    const helper = view.manifest.entries.find(
      (entry) => entry.path === "runtime/native/musicmute-native.exe",
    );
    if (!helper || helper.kind !== "file" || helper.bytes < 1) deny();
    StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
    const configuration: StorePersonalRunConfiguration = {
      version: 1,
      kind: "personal",
      installationProfile: "windows-user",
      distribution: "microsoft-store",
      release: issuer.inventorySha256,
      releaseRoot: issuer.workerRoot,
      nativeSha256: helper.sha256,
      personalRoot: host.personalRoot,
      sid: identity.sid,
      ownerSessionId: identity.sessionId,
      manifestSha256: ready.binding.runtimeManifestSha256,
      qualification: structuredClone(ready.receipt.qualification),
      bootIdentity: ready.binding.bootIdentity,
      modelFingerprint: Object.freeze({ ...ready.receipt.modelFingerprint }),
    };
    return new StorePersonalRuntime(
      TOKEN,
      host,
      issuer,
      ready.binding,
      configuration,
      ready.evidence,
    );
  }
  /** Configuration identity alone grants nothing; retain the exact host and
   * genuine issuer association when reusing the shared runner. */
  assertConfiguration(
    host: HostContext,
    configuration: StorePersonalRunConfiguration,
  ): void {
    if (
      arguments.length !== 2 ||
      host !== this.#host ||
      configuration !== this.configuration ||
      JSON.stringify(configuration) !== this.#configurationBytes
    )
      deny();
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, host.native);
    if (this.#issuer.nodeRole !== "personal") deny();
  }
  async assertCurrent(signal: AbortSignal): Promise<QualificationEvidence> {
    if (arguments.length !== 1) deny();
    signal.throwIfAborted();
    StorePersonalRuntime.prototype.assertConfiguration.call(
      this,
      this.#host,
      this.configuration,
    );
    const view = await StoreNodeIssuer.prototype.codeView.call(this.#issuer),
      native = this.#host.native,
      identity = await native.identity();
    if (
      JSON.stringify(view.binding) !== JSON.stringify(this.#binding) ||
      identity.sid !== this.configuration.sid ||
      identity.sessionId !== this.configuration.ownerSessionId ||
      (await native.bootIdentity()) !== this.configuration.bootIdentity ||
      JSON.stringify(
        await privateFingerprint(this.#host, `models\\${MODEL.filename}`),
      ) !== JSON.stringify(this.configuration.modelFingerprint)
    )
      deny();
    if (!this.#evidence.gpuIdentity) deny();
    resolveQualifiedGpuIdentity(
      this.#evidence.gpuIdentity,
      await native.enumerateGpus(),
    );
    // Keep the warm-model path's existing fingerprint check between songs.
    // The factory hashes the model; each operation revalidates live code, boot,
    // full GPU identity and that exact model file without reloading the model.
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, native);
    if ((await native.bootIdentity()) !== this.configuration.bootIdentity)
      deny();
    signal.throwIfAborted();
    return structuredClone(this.#evidence);
  }
  /** The actual Creator validates/holds the private config, fixed code and
   * physical GPU owner when this child's start runs. No command/cwd/env or
   * caller child implementation crosses the Store factory boundary. */
  async createEngine(relative: string): Promise<StorePersonalEngineChild> {
    if (arguments.length !== 1) deny();
    StorePersonalRuntime.prototype.assertConfiguration.call(
      this,
      this.#host,
      this.configuration,
    );
    return StoreNodeIssuer.prototype.createPersonalEngine.call(
      this.#issuer,
      relative,
    );
  }
  /** Passive actual protected media inventory; the Store media factory retains
   * this same private runtime for its separate fixed child execution. */
  async mediaCodeView(signal: AbortSignal) {
    if (arguments.length !== 1) deny();
    signal.throwIfAborted();
    StorePersonalRuntime.prototype.assertConfiguration.call(
      this,
      this.#host,
      this.configuration,
    );
    const view = await StoreNodeIssuer.prototype.codeView.call(this.#issuer);
    if (JSON.stringify(view.binding) !== JSON.stringify(this.#binding)) deny();
    StorePersonalRuntime.prototype.assertConfiguration.call(
      this,
      this.#host,
      this.configuration,
    );
    signal.throwIfAborted();
    return Object.freeze({ ...view, workerRoot: this.#issuer.workerRoot });
  }
  mediaTools(): StoreMediaTools {
    if (arguments.length !== 0) deny();
    StorePersonalRuntime.prototype.assertConfiguration.call(
      this,
      this.#host,
      this.configuration,
    );
    return StoreMediaTools.forPersonal(this.#host, this);
  }
  /** Keep the actual CPU operation object reachable for workspace handoff.
   * Opening it does not stop or replace this Node's retained GPU engine. */
  async openMedia(configuration: StoreMediaConfiguration) {
    if (arguments.length !== 1) deny();
    const signal = new AbortController().signal;
    await StorePersonalRuntime.prototype.mediaCodeView.call(this, signal);
    const execution = await StoreNodeIssuer.prototype.openMedia.call(
      this.#issuer,
      this.#host,
      configuration,
    );
    await StorePersonalRuntime.prototype.mediaCodeView.call(this, signal);
    return execution;
  }
  /** Fixed CPU media work retains the same real personal owner. The issuer
   * joins its original tools/helpers before returning and keeps uncertainty
   * reachable; it does not replace or unload the warm GPU model. */
  async runMedia(
    configuration: StoreMediaConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    if (arguments.length !== 2) deny();
    await StorePersonalRuntime.prototype.mediaCodeView.call(this, signal);
    await StoreNodeIssuer.prototype.runMedia.call(
      this.#issuer,
      this.#host,
      configuration,
      signal,
    );
    await StorePersonalRuntime.prototype.mediaCodeView.call(this, signal);
  }
}
