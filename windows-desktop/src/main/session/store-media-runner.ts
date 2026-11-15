import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { WINDOWS_CONSUMER_PINS } from "../../../../worker/src/platform/windows/consumer-pins.js";
import {
  parseStoreMediaRequest,
  storeMediaOutput,
  type StoreMediaConfiguration,
  type StoreMediaRequest,
} from "../../shared/store-media-request.js";
import type { StoreFixedToolKind } from "../../shared/store-tool-contracts.js";
import { StoreCpuOperation } from "./store-cpu-operation.js";
import { StoreNodeIssuer, StoreFixedToolChild } from "./store-node-issuer.js";
import type { HostContext } from "../host-context.js";
import { hashPrivateFile, readPrivateBytes } from "../prepare/private-files.js";
import {
  parseCloudProbe,
  type CloudMediaChildConfig,
} from "../cloud/media-child.js";
import {
  parseSilenceProbe,
  parseSilenceChildResult,
  type SilenceChildConfig,
} from "../player/silence-child.js";
import {
  analyzeFloatPcm,
  SILENCE_ANALYSIS_VERSION,
} from "../player/silence-analysis.js";
import {
  parseDiagnosticDoctorResult,
  type DiagnosticDoctorConfiguration,
} from "../diagnostics/doctor-child.js";
import {
  parseBrowserYoutubeCheckResult,
  type BrowserYoutubeCheckConfiguration,
} from "../browser/youtube-check-child.js";
import { isInstallationCheckCode } from "../browser/check-errors.js";

const TOKEN = Symbol("store-media-execution");
function denied(): never {
  throw new Error("STORE_MEDIA_EXECUTION_DENIED");
}
class ToolFailure extends Error {
  constructor() {
    super("STORE_MEDIA_TOOL_FAILED");
  }
}
/** Bounded byte collection only. This function grants no tool/process authority. */
export async function readStoreToolOutput(
  stream: Readable,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (
    !(stream instanceof Readable) ||
    !(signal instanceof AbortSignal) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 131072
  )
    denied();
  signal.throwIfAborted();
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => stream.destroy(new Error("STORE_MEDIA_INTERRUPTED"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const value of stream) {
      signal.throwIfAborted();
      if (!(value instanceof Uint8Array)) denied();
      size += value.byteLength;
      if (size > maximum) denied();
      chunks.push(Buffer.from(value));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function json(bytes: Uint8Array, maximum: number): unknown {
  return parseStrictJson(
    new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes),
    maximum,
    512,
  );
}
function plain(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    denied();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    denied();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) denied();
    output[key] = d.value;
  }
  return output;
}
/** The genuine original Node issuer owns every fixed CPU child. This class
 * never accepts an executable, argv, environment, injected launcher or Ready
 * record and never retires the personal Node's retained GPU engine. */
export class StoreMediaExecution {
  static #owners = new Set<StoreMediaExecution>();
  #host: HostContext;
  #issuer: StoreNodeIssuer;
  #request: StoreMediaRequest;
  #configurationBytes: Buffer;
  #configurationSha256: string;
  #operation: StoreCpuOperation;
  #prepared: Promise<StoreCpuOperation> | undefined;
  #dataHost: HostContext | undefined;
  #children = new Set<StoreFixedToolChild>();
  #constructing = new Set<Promise<StoreFixedToolChild>>();
  #running: Promise<void> | undefined;
  #completed = false;
  #ending = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #closeFailures: Promise<void>[] = [];
  #abort = new AbortController();
  private constructor(
    token: symbol,
    host: HostContext,
    issuer: StoreNodeIssuer,
    request: StoreMediaRequest,
  ) {
    if (token !== TOKEN) denied();
    StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
    this.#host = host;
    this.#issuer = issuer;
    this.#request = request;
    this.#configurationBytes = Buffer.from(
      JSON.stringify(request.configuration),
    );
    this.#configurationSha256 = createHash("sha256")
      .update(this.#configurationBytes)
      .digest("hex");
    this.#operation = StoreCpuOperation.create(host, issuer, request);
    Object.freeze(this);
  }
  static async open(
    host: HostContext,
    issuer: StoreNodeIssuer,
    configuration: StoreMediaConfiguration,
  ): Promise<StoreMediaExecution> {
    if (arguments.length !== 3) denied();
    // Calling the prototype accesses real private state before caller data or IO.
    StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
    const role = Reflect.get(StoreNodeIssuer.prototype, "nodeRole", issuer);
    if (role !== "personal" && role !== "prepare") denied();
    const view = await StoreNodeIssuer.prototype.codeView.call(issuer);
    const request = parseStoreMediaRequest(
      Buffer.from(
        JSON.stringify({
          version: 1,
          requestId: configuration.requestId,
          binding: view.binding,
          configuration,
        }),
      ),
    );
    const helper = view.manifest.entries.find(
      (entry) => entry.path === "runtime/native/musicmute-native.exe",
    );
    if (
      !helper ||
      helper.kind !== "file" ||
      helper.sha256 !== request.configuration.helperSha256 ||
      host.identity.sid !== view.binding.sid ||
      (await host.native.bootIdentity()) !== view.binding.bootIdentity
    )
      denied();
    StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
    const owner = new StoreMediaExecution(TOKEN, host, issuer, request);
    this.#owners.add(owner); // retained before the first private write or child launch
    return owner;
  }
  #assert(): void {
    if (this.#ending || this.#closed) denied();
    StoreNodeIssuer.prototype.assertNative.call(
      this.#issuer,
      this.#host.native,
    );
  }
  prepare(signal: AbortSignal): Promise<StoreCpuOperation> {
    if (
      arguments.length !== 1 ||
      !(signal instanceof AbortSignal) ||
      this.#ending ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_MEDIA_EXECUTION_DENIED"));
    this.#prepared ??= (async () => {
      await StoreCpuOperation.prototype.prepare.call(this.#operation, signal);
      this.#dataHost = StoreCpuOperation.prototype.dataHostForIssuer.call(
        this.#operation,
        this.#issuer,
      );
      return this.#operation;
    })();
    void this.#prepared.catch(() => {});
    return this.#prepared;
  }
  operation(): StoreCpuOperation {
    if (arguments.length || this.#closed) denied();
    return this.#operation;
  }
  closedForIssuer(issuer: StoreNodeIssuer): boolean {
    if (arguments.length !== 1 || issuer !== this.#issuer) denied();
    return this.#closed;
  }
  #files(): HostContext {
    if (!this.#dataHost) denied();
    return this.#dataHost;
  }
  run(signal: AbortSignal): Promise<void> {
    if (
      arguments.length !== 1 ||
      !(signal instanceof AbortSignal) ||
      this.#running ||
      this.#ending ||
      this.#closed
    )
      return Promise.reject(new Error("STORE_MEDIA_EXECUTION_DENIED"));
    this.#running = this.#run(AbortSignal.any([signal, this.#abort.signal]));
    void this.#running.catch(() => {});
    return this.#running;
  }
  async #run(signal: AbortSignal): Promise<void> {
    this.#assert();
    signal.throwIfAborted();
    await this.prepare(signal);
    switch (this.#request.configuration.operation) {
      case "cloud_prepare":
      case "cloud_probe":
        await this.#cloud(this.#request.configuration, signal);
        break;
      case "silence_analyze":
        await this.#silence(this.#request.configuration, signal);
        break;
      case "diagnostics_doctor":
        await this.#doctor(this.#request.configuration, signal);
        break;
      case "browser_check_youtube":
        await this.#youtube(this.#request.configuration, signal);
        break;
      default:
        denied();
    }
    signal.throwIfAborted();
    this.#assert();
    // Independently revalidate current native code/namespace after the result.
    await this.#files().native.identity();
    this.#completed = true;
  }
  async readResult(): Promise<Buffer> {
    if (arguments.length || !this.#running || !this.#completed) denied();
    this.#assert();
    await this.#running;
    const output = storeMediaOutput(this.#request.configuration);
    const bytes = await readPrivateBytes(
      this.#files(),
      output.relativePath,
      output.maximumBytes,
    );
    this.#assert();
    await this.#files().native.identity();
    return bytes;
  }
  async #create(
    kind: StoreFixedToolKind,
    signal: AbortSignal,
  ): Promise<StoreFixedToolChild> {
    this.#assert();
    signal.throwIfAborted();
    const original = StoreNodeIssuer.prototype.createFixedTool.call(
      this.#issuer,
      kind,
      this.#request.requestId,
      this.#configurationSha256,
      this.#operation,
    );
    this.#constructing.add(original);
    void original.catch(() => {});
    let child: StoreFixedToolChild;
    try {
      child = await original;
    } catch (error) {
      // The genuine issuer factory is synchronous and performs no IO before
      // publishing this private child. Rejection here precedes helper/OS child
      // admission; it is a business failure, not an unretired child owner.
      this.#constructing.delete(original);
      throw error;
    }
    this.#children.add(child);
    this.#constructing.delete(original);
    if (this.#ending || signal.aborted) {
      await child.stop();
      this.#children.delete(child);
      signal.throwIfAborted();
      denied();
    }
    return child;
  }
  async #retire(child: StoreFixedToolChild): Promise<void> {
    try {
      await StoreFixedToolChild.prototype.stop.call(child);
    } catch {
      throw new Error("STORE_MEDIA_CLEANUP_PENDING");
    }
    this.#children.delete(child);
  }
  async #tool(
    kind: StoreFixedToolKind,
    maximum: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const child = await this.#create(kind, signal);
    const abort = () => {
      void child.stop().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await StoreFixedToolChild.prototype.start.call(child);
      const bytes = await readStoreToolOutput(child.stdout, maximum, signal);
      const exitCode =
        await StoreFixedToolChild.prototype.waitForExit.call(child);
      signal.throwIfAborted();
      this.#assert();
      if (exitCode !== 0) throw new ToolFailure();
      return bytes;
    } finally {
      signal.removeEventListener("abort", abort);
      await this.#retire(child);
    }
  }
  async #publish(value: unknown): Promise<void> {
    this.#assert();
    const output = storeMediaOutput(this.#request.configuration),
      bytes = Buffer.from(JSON.stringify(value));
    if (!bytes.length || bytes.length > output.maximumBytes) denied();
    await StoreNodeIssuer.prototype.writeNewPrivateFile.call(
      this.#issuer,
      this.#files().native,
      output.relativePath,
      bytes,
    );
    if (
      !(
        await readPrivateBytes(
          this.#files(),
          output.relativePath,
          output.maximumBytes,
        )
      ).equals(bytes)
    )
      denied();
  }
  async #cloud(c: CloudMediaChildConfig, signal: AbortSignal): Promise<void> {
    const work = `cloud\\work\\${c.requestId}`;
    const original = parseCloudProbe(
      json(await this.#tool("cloud-probe-input", 65536, signal), 65536),
      c.operation === "cloud_probe" ? "mp3" : undefined,
    );
    let info = original,
      relative = `${work}\\result.mp3`;
    if (c.operation === "cloud_prepare") {
      relative = `${work}\\source.m4a`;
      await this.#tool("cloud-transcode", 65536, signal);
      info = parseCloudProbe(
        json(await this.#tool("cloud-probe-output", 65536, signal), 65536),
        "aac",
      );
      if (Math.abs(info.duration - original.duration) > 0.25)
        throw new Error("CLOUD_INPUT_INVALID");
    }
    const file = await this.#files().native.openPrivateFile(
      relative,
      "read",
      100000000,
    );
    if (!file) throw new Error("CLOUD_INPUT_INVALID");
    let bytes: number;
    try {
      bytes = (await file.info()).bytes;
    } finally {
      await file.close();
    }
    if (bytes! < 1 || bytes! > 100000000)
      throw new Error("CLOUD_INPUT_INVALID");
    const digest = await hashPrivateFile(
      this.#files(),
      relative,
      bytes!,
      signal,
    );
    await this.#publish({
      version: 1,
      operation: c.operation,
      requestId: c.requestId,
      executionId: c.executionId,
      source: original.source,
      bytes: bytes!,
      durationSeconds: info.duration,
      sha256: Buffer.from(digest, "hex").toString("base64"),
      codec: c.operation === "cloud_prepare" ? "aac" : "mp3",
    });
  }
  async #silence(c: SilenceChildConfig, signal: AbortSignal): Promise<void> {
    const relative = `prepare\\work\\${c.requestId}\\voice.bin`;
    if (
      (await hashPrivateFile(this.#files(), relative, c.inputBytes, signal)) !==
      c.inputSha256
    )
      throw new Error("SILENCE_UNAVAILABLE");
    parseSilenceProbe(
      json(await this.#tool("silence-probe", 16384, signal), 16384),
      c.durationSeconds,
    );
    const child = await this.#create("silence-decode", signal);
    const abort = () => {
      void child.stop().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await child.start();
      const result = await analyzeFloatPcm(
        child.stdout,
        { sampleRate: 44100, channels: 2 },
        signal,
      );
      if (
        (await child.waitForExit()) !== 0 ||
        Math.abs(result.duration - c.durationSeconds) >
          Math.max(0.25, c.durationSeconds * 0.0001) ||
        (await hashPrivateFile(
          this.#files(),
          relative,
          c.inputBytes,
          signal,
        )) !== c.inputSha256
      )
        throw new Error("SILENCE_UNAVAILABLE");
      await this.#publish(
        parseSilenceChildResult(
          {
            version: 1,
            operation: c.operation,
            requestId: c.requestId,
            executionId: c.executionId,
            analysisVersion: SILENCE_ANALYSIS_VERSION,
            inputSha256: c.inputSha256,
            durationSeconds: result.duration,
            ranges: result.ranges,
          },
          c,
        ),
      );
    } finally {
      signal.removeEventListener("abort", abort);
      await this.#retire(child);
    }
  }
  async #doctor(
    c: DiagnosticDoctorConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    let pythonAccepted = false,
      directmlAvailable = false,
      engineProtocolAccepted = false,
      mediaToolsAccepted = false;
    try {
      const row = plain(
        json(await this.#tool("doctor-metadata", 4096, signal), 4096),
        ["pythonAccepted", "directmlAvailable", "engineProtocolAccepted"],
      );
      if (Object.values(row).some((value) => typeof value !== "boolean"))
        denied();
      pythonAccepted = row.pythonAccepted as boolean;
      directmlAvailable = row.directmlAvailable as boolean;
      engineProtocolAccepted = row.engineProtocolAccepted as boolean;
    } catch (error) {
      if (!(error instanceof ToolFailure)) throw error;
    }
    try {
      const row = plain(
        json(await this.#tool("doctor-media", 4096, signal), 4096),
        ["mediaToolsAccepted"],
      );
      if (typeof row.mediaToolsAccepted !== "boolean") denied();
      mediaToolsAccepted = row.mediaToolsAccepted;
    } catch (error) {
      if (!(error instanceof ToolFailure)) throw error;
    }
    const gpus = await this.#files().native.enumerateGpus();
    await this.#publish(
      parseDiagnosticDoctorResult(
        {
          version: 1,
          operation: c.operation,
          requestId: c.requestId,
          executionId: c.executionId,
          release: c.release,
          manifestSha256: c.manifestSha256,
          sid: c.sid,
          nodeAccepted: process.version.startsWith("v24.18."),
          pythonAccepted,
          directmlAvailable,
          engineProtocolAccepted,
          mediaToolsAccepted,
          gpuCount: gpus.length,
          inferencePerformed: false,
          networkRequests: 0,
        },
        c,
      ),
    );
  }
  async #youtube(
    c: BrowserYoutubeCheckConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    let code: string | null = null;
    const text = async (kind: StoreFixedToolKind, maximum = 32768) =>
      new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
        await this.#tool(kind, maximum, signal),
      );
    try {
      if (
        (await text("downloader-version")).trim() !==
        WINDOWS_CONSUMER_PINS.downloader
      )
        throw new Error("YT_DLP_VERSION_INVALID");
      const help = await text("downloader-help", 131072);
      for (const flag of [
        "--no-plugin-dirs",
        "--no-cache-dir",
        "--no-remote-components",
        "--no-js-runtimes",
        "--js-runtimes",
        "--dump-single-json",
      ])
        if (!help.includes(flag)) throw new Error("CLI_OPTION_UNSUPPORTED");
      if ((await text("downloader-ejs")).trim() !== "ready")
        throw new Error("YT_DLP_EJS_MISSING");
      if (
        (await text("deno-version")).split("\n")[0]?.trim() !==
        `deno ${WINDOWS_CONSUMER_PINS.deno}`
      )
        throw new Error("DENO_VERSION_INVALID");
      if ((await text("deno-provider")).trim() !== "ready")
        throw new Error("PO_TOKEN_PROVIDER_UNAVAILABLE");
    } catch (error) {
      if (error instanceof ToolFailure) code = "YOUTUBE_TOOLS_UNAVAILABLE";
      else if (error instanceof Error && isInstallationCheckCode(error.message))
        code = error.message;
      else throw error;
    }
    await this.#publish(
      parseBrowserYoutubeCheckResult(
        {
          version: 1,
          operation: c.operation,
          requestId: c.requestId,
          executionId: c.executionId,
          release: c.release,
          manifestSha256: c.manifestSha256,
          sid: c.sid,
          passed: code === null,
          errorCode: code,
          inferencePerformed: false,
          networkRequests: 0,
        },
        c,
      ),
    );
  }
  close(): Promise<void> {
    if (arguments.length)
      return Promise.reject(new Error("STORE_MEDIA_EXECUTION_DENIED"));
    if (this.#closed) return Promise.resolve();
    this.#ending = true;
    this.#abort.abort();
    return (this.#closing ??= this.#close(false));
  }
  async recoverClose(): Promise<void> {
    if (arguments.length || !this.#ending || !this.#closing || this.#closed)
      denied();
    if (this.#recovering) return this.#recovering;
    const original = this.#closing;
    this.#recovering = (async () => {
      this.#closeFailures.push(original);
      await original.catch(() => {});
      if (this.#closed) return;
      this.#closing = this.#close(true);
      await this.#closing;
    })().finally(() => {
      this.#recovering = undefined;
    });
    return this.#recovering;
  }
  async retireForIssuer(
    issuer: StoreNodeIssuer,
    recovery: boolean,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      issuer !== this.#issuer ||
      typeof recovery !== "boolean"
    )
      denied();
    if (this.#closed) return;
    if (recovery && this.#closing) return this.recoverClose();
    return this.close();
  }
  async #close(recovery: boolean): Promise<void> {
    await this.#prepared?.catch(() => {});
    await this.#running?.catch(() => {});
    const factories = await Promise.allSettled(this.#constructing);
    for (const row of factories)
      if (row.status === "fulfilled") this.#children.add(row.value);
    const stops = await Promise.allSettled(
      [...this.#children].map((child) =>
        StoreFixedToolChild.prototype.retireForIssuer.call(
          child,
          this.#issuer,
          recovery,
        ),
      ),
    );
    if (stops.some((row) => row.status === "rejected"))
      throw new Error("STORE_MEDIA_CLEANUP_PENDING");
    this.#constructing.clear();
    this.#children.clear();
    await StoreCpuOperation.prototype.retireForIssuer.call(
      this.#operation,
      this.#issuer,
      recovery,
    );
    this.#configurationBytes.fill(0);
    this.#closed = true;
    StoreMediaExecution.#owners.delete(this);
    StoreNodeIssuer.prototype.mediaRetired.call(this.#issuer, this);
  }
}
