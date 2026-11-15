import { createHash, randomUUID } from "node:crypto";
import { StoreNodeIssuer } from "./store-node-issuer.js";
import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
import { HostContext } from "../host-context.js";
import {
  storeMediaOutput,
  type StoreMediaRequest,
} from "../../shared/store-media-request.js";
import {
  parseStoreCpuOperationExpectation,
  parseStoreCpuOperationState,
  storeCpuFields,
  type StoreCpuOperationExpectation,
} from "../../shared/store-cpu-operation.js";
const TOKEN = Symbol("store-cpu-operation");
function deny(): never {
  throw new Error("STORE_CPU_OPERATION_DENIED");
}
/** Original CPU children and their private metadata helper are separate from
 * the Personal Node/GPU owner. Serialized expectations cannot mint this class. */
export class StoreCpuOperation {
  static #owners = new Set<StoreCpuOperation>();
  #host: HostContext;
  #issuer: StoreNodeIssuer;
  #request: StoreMediaRequest;
  #bytes: Buffer;
  #digest: string;
  #incarnation = randomUUID();
  #control: WindowsConsumerNative | undefined;
  #metadata: WindowsConsumerNative | undefined;
  #dataHost: HostContext | undefined;
  #expectation: StoreCpuOperationExpectation | undefined;
  #preparing: Promise<void> | undefined;
  #attempted = false;
  #admitted = false;
  #closing: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #failures: Promise<void>[] = [];
  #ending = false;
  #closed = false;
  private constructor(
    token: symbol,
    host: HostContext,
    issuer: StoreNodeIssuer,
    request: StoreMediaRequest,
  ) {
    if (token !== TOKEN) deny();
    StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
    this.#host = host;
    this.#issuer = issuer;
    this.#request = request;
    this.#bytes = Buffer.from(JSON.stringify(request.configuration));
    this.#digest = createHash("sha256").update(this.#bytes).digest("hex");
    Object.freeze(this);
  }
  static create(
    host: HostContext,
    issuer: StoreNodeIssuer,
    request: StoreMediaRequest,
  ): StoreCpuOperation {
    if (arguments.length !== 3) deny();
    StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
    const role = Reflect.get(StoreNodeIssuer.prototype, "nodeRole", issuer);
    if (role !== "personal" && role !== "prepare") deny();
    const operation = new StoreCpuOperation(TOKEN, host, issuer, request);
    this.#owners.add(operation);
    return operation;
  }
  assertHost(host: HostContext): void {
    if (arguments.length !== 1 || host !== this.#host) deny();
    StoreNodeIssuer.prototype.assertNative.call(this.#issuer, host.native);
  }
  expectation(): StoreCpuOperationExpectation {
    if (arguments.length || !this.#expectation) deny();
    return parseStoreCpuOperationExpectation(
      this.#expectation,
      this.#host.identity.sid,
    );
  }
  tokenForIssuer(issuer: StoreNodeIssuer): string {
    if (
      arguments.length !== 1 ||
      issuer !== this.#issuer ||
      !this.#admitted ||
      this.#ending ||
      !this.#expectation
    )
      deny();
    return this.#expectation.token;
  }
  prepare(signal: AbortSignal): Promise<void> {
    if (
      arguments.length !== 1 ||
      !(signal instanceof AbortSignal) ||
      this.#ending ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_CPU_OPERATION_DENIED"));
    this.#preparing ??= this.#prepare(signal);
    void this.#preparing.catch(() => {});
    return this.#preparing;
  }
  #openArgs() {
    return {
      request_id: this.#request.requestId,
      incarnation: this.#incarnation,
      operation: this.#request.configuration.operation,
      configuration_sha256: this.#digest,
    };
  }
  #active(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#ending || this.#closed) deny();
    this.assertHost(this.#host);
  }
  #receive(value: unknown, requireAdmission: boolean): void {
    const row = storeCpuFields(value, ["expectation", "admitted", "retired"]),
      expected = parseStoreCpuOperationExpectation(
        row.expectation,
        this.#host.identity.sid,
      );
    if (
      typeof row.admitted !== "boolean" ||
      typeof row.retired !== "boolean" ||
      expected.requestId !== this.#request.requestId ||
      expected.incarnation !== this.#incarnation ||
      expected.operation !== this.#request.configuration.operation ||
      expected.configurationSha256 !== this.#digest ||
      expected.inventorySha256 !== this.#request.binding.inventorySha256 ||
      expected.runtimeManifestSha256 !==
        this.#request.binding.runtimeManifestSha256 ||
      JSON.stringify(expected.nodeOwner) !==
        JSON.stringify(this.#issuer.owner) ||
      (this.#expectation &&
        JSON.stringify(expected) !== JSON.stringify(this.#expectation))
    )
      deny();
    this.#expectation = expected;
    if (requireAdmission && (row.admitted !== true || row.retired !== false))
      deny();
  }
  async #prepare(signal: AbortSignal): Promise<void> {
    this.#active(signal);
    const relative = storeMediaOutput(this.#request.configuration).relativePath,
      work = relative.slice(0, relative.lastIndexOf("\\"));
    this.#metadata = await StoreNodeIssuer.prototype.openNative.call(
      this.#issuer,
    );
    this.#active(signal);
    this.#dataHost = await HostContext.initialize(this.#metadata, "0.1.0", 1);
    this.#active(signal);
    await this.#metadata.validatePath("personal", work, "directory");
    await this.#metadata.validatePath("personal", relative, "absent");
    this.#active(signal);
    await StoreNodeIssuer.prototype.writeNewPrivateFile.call(
      this.#issuer,
      this.#metadata,
      `${work}\\store-tool-config.json`,
      this.#bytes,
    );
    this.#active(signal);
    this.#control = await StoreNodeIssuer.prototype.openNative.call(
      this.#issuer,
    );
    this.#active(signal);
    this.#attempted = true;
    this.#receive(
      await StoreNodeIssuer.prototype.cpuOperationOpen.call(
        this.#issuer,
        this.#control,
        this.#openArgs(),
        false,
      ),
      true,
    );
    this.#active(signal);
    await StoreNodeIssuer.prototype.cpuOperationBindData.call(
      this.#issuer,
      this.#metadata,
      this.#expectation!.token,
    );
    this.#active(signal);
    this.#admitted = true;
  }
  metadataForIssuer(issuer: StoreNodeIssuer): WindowsConsumerNative {
    this.tokenForIssuer(issuer);
    if (!this.#metadata) deny();
    return this.#metadata;
  }
  dataHostForIssuer(issuer: StoreNodeIssuer): HostContext {
    this.tokenForIssuer(issuer);
    if (!this.#dataHost) deny();
    return this.#dataHost;
  }
  async inspectRetired(): Promise<boolean> {
    if (arguments.length || !this.#expectation) deny();
    if (this.#closed) return true;
    if (!this.#control) deny();
    return parseStoreCpuOperationState(
      await StoreNodeIssuer.prototype.cpuOperationInspect.call(
        this.#issuer,
        this.#control,
        this.#expectation,
      ),
    );
  }
  retire(): Promise<void> {
    if (arguments.length)
      return Promise.reject(new Error("STORE_CPU_OPERATION_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#ending = true;
    this.#closing ??= this.#retire();
    void this.#closing.catch(() => {});
    return this.#closing;
  }
  recoverRetire(): Promise<void> {
    if (arguments.length || !this.#ending || !this.#closing)
      return Promise.reject(new Error("STORE_CPU_OPERATION_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#recovering ??= (async () => {
      const original = this.#closing!;
      this.#failures.push(original);
      await original.catch(() => {});
      if (!this.#closed) {
        this.#closing = this.#retire();
        await this.#closing;
      }
    })().finally(() => {
      this.#recovering = undefined;
    });
    void this.#recovering.catch(() => {});
    return this.#recovering;
  }
  retireForIssuer(issuer: StoreNodeIssuer, recovery: boolean): Promise<void> {
    if (
      arguments.length !== 2 ||
      issuer !== this.#issuer ||
      typeof recovery !== "boolean"
    )
      return Promise.reject(new Error("STORE_CPU_OPERATION_DENIED"));
    return recovery && this.#closing ? this.recoverRetire() : this.retire();
  }
  async #retire(): Promise<void> {
    await this.#preparing?.catch(() => {});
    if (this.#attempted && !this.#expectation) {
      if (!this.#control) deny();
      this.#receive(
        await StoreNodeIssuer.prototype.cpuOperationOpen.call(
          this.#issuer,
          this.#control,
          this.#openArgs(),
          true,
        ),
        false,
      );
    }
    // Positive original transport retirement proves its noninherited private
    // file capabilities are gone. Never retire the warm Node's whole Job.
    await this.#metadata?.close();
    if (this.#expectation) {
      if (!this.#control) deny();
      const state = await StoreNodeIssuer.prototype.cpuOperationRetire.call(
        this.#issuer,
        this.#control,
        this.#expectation.token,
      );
      if (!parseStoreCpuOperationState(state)) deny();
    }
    await this.#control?.close();
    this.#bytes.fill(0);
    this.#closed = true;
    StoreCpuOperation.#owners.delete(this);
  }
}
