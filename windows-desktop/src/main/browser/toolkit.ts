import {
  CHECK_COMPONENTS,
  isInstallationCheck,
  type InstallationCheck,
  type CheckComponent,
} from "../../../../chrome-extension/src/shared/installation-check.js";
import { projectDiagnosticInput } from "../diagnostics/projection.js";
import { isDeepStrictEqual } from "node:util";
import { installationCheckFailure } from "./check-errors.js";
export type BrowserToolkitEvent = ReturnType<
  typeof projectDiagnosticInput
>["input"];
export function parseBrowserToolkitEvent(value: unknown): BrowserToolkitEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_COMMAND");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join() !==
      "code,event,job,metrics,phase,severity,subsystem" ||
    input.subsystem !== "chrome" ||
    input.job !== null
  )
    throw new Error("INVALID_COMMAND");
  const projected = projectDiagnosticInput(input);
  if (projected.rejected || !isDeepStrictEqual(projected.input, input))
    throw new Error("INVALID_COMMAND");
  return projected.input;
}
/** Public extension events are projected before the private bridge. Raw strings,
 * IDs, URLs, paths and tokens cannot become a diagnostic field or metric. */
export function projectBrowserEvent(value: unknown): BrowserToolkitEvent {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return projectDiagnosticInput({
    subsystem: "chrome",
    event: raw.severity === "error" ? "ui_error" : "resource_sample",
    severity: raw.severity,
    code: raw.code ?? "OK",
    phase: null,
    metrics: raw.metrics,
    job: null,
  }).input;
}
export interface BrowserToolkitPort {
  startCheck(
    signal: AbortSignal,
    publish: (value: InstallationCheck) => void,
  ): {
    initial: InstallationCheck;
    done: Promise<InstallationCheck>;
    cancel(): void;
  };
  clearCache(signal: AbortSignal): Promise<void>;
  recordEvent(input: BrowserToolkitEvent): Promise<void>;
  dispose(): Promise<void>;
}
export class BrowserToolkit implements BrowserToolkitPort {
  private active:
    { abort: AbortController; done: Promise<InstallationCheck> } | undefined;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  checking() {
    return this.active !== undefined;
  }
  subscribeActivity(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.listeners)
      try {
        listener();
      } catch {}
  }
  constructor(
    private readonly options: {
      /** Exact already verified public app package SHA. Never an install UUID hash. */
      packageIdentity: string;
      inspect: Record<CheckComponent, (signal: AbortSignal) => Promise<void>>;
      clearCache(signal: AbortSignal): Promise<void>;
      recordEvent(input: BrowserToolkitEvent): Promise<void> | void;
    },
  ) {
    if (!/^[a-f0-9]{64}$/u.test(options.packageIdentity))
      throw new Error("INSTALLATION_CHECK_FAILED");
  }
  startCheck(signal: AbortSignal, publish: (value: InstallationCheck) => void) {
    if (this.closed) throw new Error("LOCAL_HOST_UNAVAILABLE");
    if (this.active) throw new Error("INSTALLATION_CHECK_BUSY");
    signal.throwIfAborted();
    const abort = new AbortController(),
      combined = AbortSignal.any([signal, abort.signal]);
    const status: InstallationCheck = {
      installation_id: this.options.packageIdentity,
      started_at: Date.now(),
      state: "running",
      checks: CHECK_COMPONENTS.map((component) => ({
        component,
        state: "pending",
      })),
    };
    const emit = () => {
      const value = structuredClone(status);
      if (!isInstallationCheck(value))
        throw new Error("INSTALLATION_CHECK_FAILED");
      // A failed observer cannot interrupt the owned diagnostic child/cleanup.
      try {
        publish(value);
      } catch {}
    };
    const initial = structuredClone(status);
    // Reserve before callbacks/await. A simultaneous second CHECK cannot start.
    let resolve!: (value: InstallationCheck) => void,
      reject!: (error: unknown) => void;
    const done = new Promise<InstallationCheck>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    this.active = { abort, done };
    this.changed();
    void done.catch(() => {});
    void (async () => {
      emit();
      for (const check of status.checks) {
        if (combined.aborted) break;
        check.state = "running";
        emit();
        const at = performance.now();
        try {
          combined.throwIfAborted();
          await this.options.inspect[check.component](combined);
          combined.throwIfAborted();
          check.state = "passed";
        } catch (error) {
          check.state = "failed";
          const code = combined.aborted
            ? "CANCELLED"
            : installationCheckFailure(error, "INSTALLATION_CHECK_FAILED");
          check.error_code = code;
        }
        check.duration_ms = Math.round(performance.now() - at);
        emit();
        if (
          check.state === "failed" &&
          (check.component === "runtime" || combined.aborted)
        )
          break;
      }
      status.state = status.checks.every((check) => check.state === "passed")
        ? "passed"
        : "failed";
      status.completed_at = Date.now();
      emit();
      return structuredClone(status);
    })().then(
      (result) => {
        this.active = undefined;
        this.changed();
        resolve(result);
      },
      (error: unknown) => {
        this.active = undefined;
        this.changed();
        reject(error);
      },
    );
    return { initial, done, cancel: () => abort.abort(new Error("CANCELLED")) };
  }
  async clearCache(signal: AbortSignal) {
    if (this.closed) throw new Error("LOCAL_HOST_UNAVAILABLE");
    signal.throwIfAborted();
    await this.options.clearCache(signal);
  }
  async recordEvent(value: BrowserToolkitEvent) {
    if (this.closed) throw new Error("LOCAL_HOST_UNAVAILABLE");
    await this.options.recordEvent(parseBrowserToolkitEvent(value));
  }
  async dispose() {
    this.closed = true;
    this.active?.abort.abort(new Error("CANCELLED"));
    await this.active?.done.catch(() => {});
  }
}
