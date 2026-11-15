import { createHash } from "node:crypto";
import type { HostContext } from "../host-context.js";
import { readPrivateBytes } from "../prepare/private-files.js";
import { StoreSessionClient } from "./store-session-client.js";
import {
  parseStoreBenchmarkRequest,
  parseStoreBenchmarkLaunch,
  parseStoreBenchmarkEvent,
  parseStoreBenchmarkCleanup,
  parseStoreBenchmarkRecovery,
  type StoreBenchmarkRequest,
  type StoreBenchmarkResult,
} from "../../shared/store-benchmark-contracts.js";
import type { StorePrepareLaunch } from "../../shared/store-prepare-contracts.js";

const TOKEN = Symbol("store-benchmark-execution");
const wire = (value: unknown) => Buffer.from(JSON.stringify(value));
function denied(): never {
  throw new Error("STORE_BENCHMARK_EXECUTION_DENIED");
}

/** Created and retained by the real GUI Session client before any launch IO.
 * Public receiving requests/owners cannot provide transport or GPU authority. */
export class StoreBenchmarkExecution {
  #session: StoreSessionClient;
  #host: HostContext;
  #request: StoreBenchmarkRequest;
  #launch: StorePrepareLaunch | undefined;
  #launching: Promise<StorePrepareLaunch> | undefined;
  #attempted = false;
  #running: Promise<void> | undefined;
  #result: StoreBenchmarkResult | undefined;
  #completed = false;
  #retired = false;
  #ending = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #failures: Promise<void>[] = [];
  private constructor(
    token: symbol,
    session: StoreSessionClient,
    host: HostContext,
    request: StoreBenchmarkRequest,
  ) {
    if (token !== TOKEN) denied();
    StoreSessionClient.prototype.assertBenchmarkHost.call(session, host);
    this.#session = session;
    this.#host = host;
    this.#request = parseStoreBenchmarkRequest(wire(request));
    Object.freeze(this);
  }
  static create(
    session: StoreSessionClient,
    host: HostContext,
    request: StoreBenchmarkRequest,
  ): StoreBenchmarkExecution {
    if (arguments.length !== 3) denied();
    return new StoreBenchmarkExecution(TOKEN, session, host, request);
  }
  assertHost(host: HostContext) {
    if (arguments.length !== 1 || host !== this.#host) denied();
    StoreSessionClient.prototype.assertBenchmarkHost.call(this.#session, host);
  }
  requestForSession(session: StoreSessionClient): StoreBenchmarkRequest {
    if (arguments.length !== 1 || session !== this.#session) denied();
    return this.#request;
  }
  launchForSession(
    session: StoreSessionClient,
  ): StorePrepareLaunch | undefined {
    if (arguments.length !== 1 || session !== this.#session) denied();
    return this.#launch;
  }
  closedForSession(session: StoreSessionClient): boolean {
    if (arguments.length !== 1 || session !== this.#session) denied();
    return this.#closed;
  }
  launch(signal: AbortSignal): Promise<StorePrepareLaunch> {
    if (
      arguments.length !== 1 ||
      !(signal instanceof AbortSignal) ||
      this.#ending ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_BENCHMARK_EXECUTION_DENIED"));
    this.#launching ??= Promise.resolve().then(() => this.#start(signal));
    void this.#launching.catch(() => {});
    return this.#launching;
  }
  async #start(signal: AbortSignal): Promise<StorePrepareLaunch> {
    signal.throwIfAborted();
    if (this.#ending || this.#closed) denied();
    this.assertHost(this.#host);
    this.#attempted = true;
    const abort = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      this.#launch = parseStoreBenchmarkLaunch(
        wire(
          await StoreSessionClient.prototype.benchmarkOperationCommand.call(
            this.#session,
            this,
            "benchmark_launch",
          ),
        ),
        this.#request,
      );
      // Adopt the real issued owner even when cancellation raced its ACK.
      signal.throwIfAborted();
      if (this.#ending) denied();
      this.assertHost(this.#host);
      return this.#launch;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  run(signal: AbortSignal): Promise<void> {
    if (
      arguments.length !== 1 ||
      !(signal instanceof AbortSignal) ||
      this.#ending ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_BENCHMARK_EXECUTION_DENIED"));
    this.#running ??= Promise.resolve().then(() => this.#run(signal));
    void this.#running.catch(() => {});
    return this.#running;
  }
  async #run(signal: AbortSignal) {
    await this.launch(signal);
    signal.throwIfAborted();
    const abort = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        if (this.#ending || !this.#launch) denied();
        const event = parseStoreBenchmarkEvent(
          wire(
            await StoreSessionClient.prototype.benchmarkOperationCommand.call(
              this.#session,
              this,
              "benchmark_wait",
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
        // Each call waits the original completion/process events in native.
      }
      signal.throwIfAborted();
      if (this.#ending) denied();
      this.assertHost(this.#host);
      this.#completed = true;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  resultObservation(): StoreBenchmarkResult {
    if (
      arguments.length ||
      this.#ending ||
      this.#closed ||
      !this.#completed ||
      !this.#result
    )
      denied();
    this.assertHost(this.#host);
    return Object.freeze({ ...this.#result });
  }
  async readResult(): Promise<Buffer> {
    if (
      arguments.length ||
      this.#ending ||
      this.#closed ||
      !this.#result ||
      !this.#completed
    )
      denied();
    this.assertHost(this.#host);
    const result = this.#result,
      bytes = await readPrivateBytes(
        this.#host,
        `prepare\\results\\${this.#request.requestId}.benchmark.raw.json`,
        8 * 1024 ** 2,
      );
    try {
      if (
        bytes.length !== result.rawBytes ||
        createHash("sha256").update(bytes).digest("hex") !== result.rawSha256 ||
        this.#ending ||
        this.#closed
      )
        denied();
      this.assertHost(this.#host);
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  }
  close(): Promise<void> {
    if (arguments.length)
      return Promise.reject(new Error("STORE_BENCHMARK_EXECUTION_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#ending = true;
    this.#closing ??= this.#close();
    void this.#closing.catch(() => {});
    return this.#closing;
  }
  recoverClose(): Promise<void> {
    if (arguments.length || !this.#closing || !this.#ending)
      return Promise.reject(new Error("STORE_BENCHMARK_EXECUTION_DENIED"));
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
  async #close() {
    await this.#launching?.catch(() => {});
    if (this.#attempted && !this.#launch && !this.#retired) {
      const recovered = parseStoreBenchmarkRecovery(
        wire(
          await StoreSessionClient.prototype.benchmarkOperationCommand.call(
            this.#session,
            this,
            "benchmark_recover",
          ),
        ),
        this.#request,
      );
      if ("state" in recovered) this.#retired = true;
      else this.#launch = recovered;
    }
    if (this.#launch && !this.#retired) {
      parseStoreBenchmarkCleanup(
        wire(
          await StoreSessionClient.prototype.benchmarkOperationCommand.call(
            this.#session,
            this,
            "benchmark_cancel",
          ),
        ),
        this.#request,
        this.#launch,
      );
      this.#retired = true;
    }
    await Promise.allSettled([this.#launching, this.#running]);
    await StoreSessionClient.prototype.retireBenchmarkWaiter.call(
      this.#session,
      this,
    );
    this.#closed = true;
  }
}
