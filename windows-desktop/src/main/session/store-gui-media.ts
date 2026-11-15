import { createHash } from "node:crypto";
import type { HostContext } from "../host-context.js";
import { readPrivateBytes } from "../prepare/private-files.js";
import { StoreSessionClient } from "./store-session-client.js";
import {
  parseStoreMediaLaunch,
  parseStoreMediaRequest,
  storeMediaOutput,
  type StoreMediaLaunch,
  type StoreMediaRequest,
} from "../../shared/store-media-request.js";
import {
  parseStoreGuiCpuReadyEvent,
  parseStoreGuiCpuStartAck,
  parseStoreGuiCpuWaitEvent,
  parseStoreGuiCpuCleanup,
  parseStoreGuiCpuRecovery,
} from "../../shared/store-gui-cpu-contracts.js";
import {
  parseStoreCpuOperationExpectation,
  type StoreCpuOperationExpectation,
} from "../../../../worker/src/platform/windows/consumer-store-cpu.js";

const TOKEN = Symbol("store-gui-cpu-operation");
function deny(): never {
  throw new Error("STORE_GUI_CPU_OPERATION_DENIED");
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

/** A genuine GUI control client owns this distinct CPU capability. A reflected
 * Prepare owner or expectation cannot construct it or supply its transport. */
export class StoreGuiCpuOperation {
  #host: HostContext;
  #session: StoreSessionClient;
  #request: StoreMediaRequest;
  #launch: StoreMediaLaunch | undefined;
  #expectation: StoreCpuOperationExpectation | undefined;
  #attempted = false;
  #launchPending: Promise<StoreMediaLaunch> | undefined;
  #partialRetired = false;
  #preparing: Promise<void> | undefined;
  #running: Promise<void> | undefined;
  #result: { relativePath: string; bytes: number; sha256: string } | undefined;
  #ending = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #failures: Promise<void>[] = [];
  private constructor(
    token: symbol,
    host: HostContext,
    session: StoreSessionClient,
    request: StoreMediaRequest,
  ) {
    if (token !== TOKEN) deny();
    StoreSessionClient.prototype.assertMediaHost.call(session, host);
    this.#host = host;
    this.#session = session;
    this.#request = parseStoreMediaRequest(bytes(request));
    Object.freeze(this);
  }
  static create(
    host: HostContext,
    session: StoreSessionClient,
    request: StoreMediaRequest,
  ): StoreGuiCpuOperation {
    if (arguments.length !== 3) deny();
    return new StoreGuiCpuOperation(TOKEN, host, session, request);
  }
  assertHost(host: HostContext): void {
    if (arguments.length !== 1 || host !== this.#host) deny();
    StoreSessionClient.prototype.assertMediaHost.call(this.#session, host);
  }
  requestForSession(session: StoreSessionClient): StoreMediaRequest {
    if (arguments.length !== 1 || session !== this.#session) deny();
    return this.#request;
  }
  launchForSession(session: StoreSessionClient): StoreMediaLaunch | undefined {
    if (arguments.length !== 1 || session !== this.#session) deny();
    return this.#launch;
  }
  expectation(): StoreCpuOperationExpectation {
    if (arguments.length || !this.#expectation) deny();
    return parseStoreCpuOperationExpectation(this.#expectation);
  }
  prepare(signal: AbortSignal): Promise<void> {
    if (
      arguments.length !== 1 ||
      !(signal instanceof AbortSignal) ||
      this.#ending ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_GUI_CPU_OPERATION_DENIED"));
    this.#preparing ??= this.#prepare(signal);
    void this.#preparing.catch(() => {});
    return this.#preparing;
  }
  async #prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.assertHost(this.#host);
    this.#attempted = true;
    this.#launchPending = StoreSessionClient.prototype.mediaOperationCommand
      .call(this.#session, this, "cpu_launch")
      .then((raw) => parseStoreMediaLaunch(bytes(raw), this.#request));
    this.#launch = await this.#launchPending;
    for (;;) {
      signal.throwIfAborted();
      if (this.#ending) deny();
      const event = parseStoreGuiCpuReadyEvent(
        bytes(
          await StoreSessionClient.prototype.mediaOperationCommand.call(
            this.#session,
            this,
            "cpu_ready",
            this.#launch,
          ),
        ),
        this.#request,
        this.#launch,
      );
      if (event.state === "ready") {
        this.#expectation = event.expectation;
        break;
      }
      // Each bounded call waits the original kernel ready/process events.
    }
    signal.throwIfAborted();
    if (this.#ending) deny();
    this.assertHost(this.#host);
  }
  run(signal: AbortSignal): Promise<void> {
    if (
      arguments.length !== 1 ||
      !(signal instanceof AbortSignal) ||
      this.#ending ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_GUI_CPU_OPERATION_DENIED"));
    this.#running ??= this.#run(signal);
    void this.#running.catch(() => {});
    return this.#running;
  }
  async #run(signal: AbortSignal): Promise<void> {
    await this.prepare(signal);
    signal.throwIfAborted();
    if (this.#ending || !this.#launch) deny();
    const abort = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      parseStoreGuiCpuStartAck(
        bytes(
          await StoreSessionClient.prototype.mediaOperationCommand.call(
            this.#session,
            this,
            "cpu_start",
            this.#launch,
          ),
        ),
        this.#request,
        this.#launch,
      );
      for (;;) {
        signal.throwIfAborted();
        if (this.#ending) deny();
        const event = parseStoreGuiCpuWaitEvent(
          bytes(
            await StoreSessionClient.prototype.mediaOperationCommand.call(
              this.#session,
              this,
              "cpu_wait",
              this.#launch,
            ),
          ),
          this.#request,
          this.#launch,
        );
        if (event.state === "failed") throw new Error(event.errorCode);
        if (event.state === "completed") {
          this.#result = event.result;
          break;
        }
      }
      signal.throwIfAborted();
      this.assertHost(this.#host);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async readResult(): Promise<Buffer> {
    if (
      arguments.length ||
      this.#ending ||
      this.#closed ||
      !this.#result ||
      !this.#expectation
    )
      deny();
    this.assertHost(this.#host);
    const output = storeMediaOutput(this.#request.configuration);
    const value = await readPrivateBytes(
      this.#host,
      output.relativePath,
      output.maximumBytes,
    );
    if (
      value.length !== this.#result.bytes ||
      createHash("sha256").update(value).digest("hex") !== this.#result.sha256
    ) {
      value.fill(0);
      deny();
    }
    this.assertHost(this.#host);
    return value;
  }
  async inspectRetired(): Promise<boolean> {
    if (arguments.length || !this.#expectation) deny();
    if (this.#closed) return true;
    this.assertHost(this.#host);
    if (!this.#host.native.inspectStoreCpuOperation) deny();
    const retired = await this.#host.native.inspectStoreCpuOperation(
      this.#expectation,
    );
    if (typeof retired !== "boolean") deny();
    return retired;
  }
  close(): Promise<void> {
    if (arguments.length)
      return Promise.reject(new Error("STORE_GUI_CPU_OPERATION_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#ending = true;
    this.#closing ??= this.#close();
    void this.#closing.catch(() => {});
    return this.#closing;
  }
  recoverClose(): Promise<void> {
    if (arguments.length || !this.#closing || !this.#ending)
      return Promise.reject(new Error("STORE_GUI_CPU_OPERATION_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#recovering ??= (async () => {
      const original = this.#closing!;
      this.#failures.push(original);
      await original.catch(() => {});
      if (!this.#closed) {
        this.#closing = this.#close();
        await this.#closing;
      }
    })().finally(() => {
      this.#recovering = undefined;
    });
    void this.#recovering.catch(() => {});
    return this.#recovering;
  }
  async #close(): Promise<void> {
    if (this.#attempted && !this.#launch && !this.#partialRetired) {
      await this.#launchPending?.catch(() => {});
      const recovered = parseStoreGuiCpuRecovery(
        bytes(
          await StoreSessionClient.prototype.mediaOperationCommand.call(
            this.#session,
            this,
            "cpu_recover",
          ),
        ),
        this.#request,
      );
      if ("state" in recovered) this.#partialRetired = true;
      else this.#launch = recovered;
    }
    if (this.#launch)
      parseStoreGuiCpuCleanup(
        bytes(
          await StoreSessionClient.prototype.mediaOperationCommand.call(
            this.#session,
            this,
            "cpu_cancel",
            this.#launch,
          ),
        ),
        this.#request,
        this.#launch,
      );
    await Promise.allSettled([this.#preparing, this.#running]);
    await StoreSessionClient.prototype.retireMediaWaiter.call(
      this.#session,
      this,
    );
    this.#closed = true;
  }
  closedForSession(session: StoreSessionClient): boolean {
    if (arguments.length !== 1 || session !== this.#session) deny();
    return this.#closed;
  }
}

/** An actual GUI execution retains its real CPU proxy before the first Node
 * launch. Business result parsing stays with the unchanged five callers. */
export class StoreGuiMediaExecution {
  #operation: StoreGuiCpuOperation;
  private constructor(token: symbol, operation: StoreGuiCpuOperation) {
    if (token !== TOKEN) deny();
    this.#operation = operation;
    Object.freeze(this);
  }
  static create(
    host: HostContext,
    session: StoreSessionClient,
    request: StoreMediaRequest,
  ): StoreGuiMediaExecution {
    if (arguments.length !== 3) deny();
    return new StoreGuiMediaExecution(
      TOKEN,
      StoreGuiCpuOperation.create(host, session, request),
    );
  }
  operation(): StoreGuiCpuOperation {
    if (arguments.length) deny();
    return this.#operation;
  }
  async prepare(signal: AbortSignal): Promise<StoreGuiCpuOperation> {
    await StoreGuiCpuOperation.prototype.prepare.call(this.#operation, signal);
    return this.#operation;
  }
  run(signal: AbortSignal): Promise<void> {
    return StoreGuiCpuOperation.prototype.run.call(this.#operation, signal);
  }
  readResult(): Promise<Buffer> {
    if (arguments.length) deny();
    return StoreGuiCpuOperation.prototype.readResult.call(this.#operation);
  }
  close(): Promise<void> {
    if (arguments.length) deny();
    return StoreGuiCpuOperation.prototype.close.call(this.#operation);
  }
  recoverClose(): Promise<void> {
    if (arguments.length) deny();
    return StoreGuiCpuOperation.prototype.recoverClose.call(this.#operation);
  }
}
