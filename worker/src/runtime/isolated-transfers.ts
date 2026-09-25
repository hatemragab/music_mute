import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TransferError,
  TransferOwnershipError,
  type TransferClientOptions,
  type WorkerTransferClient,
} from "./transfers.js";
import type { TransferProcessRequest } from "./transfer-process.js";
import { assertNoLiveTransfer } from "./transfer-workspace-owner.js";

type Options = Omit<TransferClientOptions, "fetch"> & {
  workRoot: string;
  killTimeoutMs?: number;
};
export class IsolatedWorkerTransferClient {
  constructor(
    private readonly options: Options,
    private readonly launch: (
      path: string,
      args: string[],
      options: ForkOptions,
    ) => ChildProcess = fork,
  ) {
    if (
      !Number.isSafeInteger(options.timeoutMs ?? 7_200_000) ||
      (options.timeoutMs ?? 7_200_000) < 1 ||
      (options.timeoutMs ?? 7_200_000) > 2_147_483_647 ||
      !Number.isSafeInteger(options.killTimeoutMs ?? 5000) ||
      (options.killTimeoutMs ?? 5000) < 1 ||
      (options.killTimeoutMs ?? 5000) > 2_147_483_647
    )
      throw new TypeError("Transfer process timeout is invalid");
  }
  download: WorkerTransferClient["download"] = async (
    grant,
    expected,
    path,
    signal,
  ) => {
    await this.run("download", grant, expected, path, signal);
  };
  upload: WorkerTransferClient["upload"] = async (
    grant,
    path,
    expected,
    signal,
  ) => {
    const result = await this.run("upload", grant, expected, path, signal);
    if (typeof result !== "string")
      throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
    return result;
  };
  private async run(
    operation: "download" | "upload",
    grant: TransferProcessRequest["grant"],
    expected: TransferProcessRequest["expected"],
    path: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const workRoot = await realpath(this.options.workRoot);
    const local = relative(workRoot, resolve(path)).split(sep);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        local[0] ?? "",
      ) ||
      local.length < 2
    )
      throw new TypeError("Transfer path is outside an attempt workspace");
    const workspace = join(workRoot, local[0]!);
    const source = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(
      new URL(
        source ? "./transfer-process.ts" : "./transfer-process.js",
        import.meta.url,
      ),
    );
    const code =
      operation === "download" ? "DOWNLOAD_FAILED" : "OUTPUT_UPLOAD_FAILED";
    const {
      workRoot: _root,
      killTimeoutMs: _killTimeout,
      ...transferOptions
    } = this.options;
    const result = await new Promise((resolveRun, rejectRun) => {
      let child: ChildProcess;
      let outcome:
        | {
            ok: boolean;
            result?: unknown;
            retryable?: boolean;
            diagnostic?: string;
          }
        | undefined;
      let failure: unknown;
      let finished = false;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", aborted);
        if (error) rejectRun(error);
        else resolveRun(outcome?.result);
      };
      const terminate = (error: unknown) => {
        if (failure || finished) return;
        failure = error;
        child.kill("SIGKILL");
        killTimer = setTimeout(
          () => finish(new TransferOwnershipError(code)),
          this.options.killTimeoutMs ?? 5000,
        );
        killTimer.unref();
      };
      const aborted = () =>
        terminate(signal?.reason ?? new Error("Transfer cancelled"));
      const timer = setTimeout(
        () =>
          terminate(new TransferError(code, true, "transfer-process-timeout")),
        this.options.timeoutMs ?? 7_200_000,
      );
      timer.unref();
      try {
        child = this.launch(entry, [], {
          execArgv: source ? ["--experimental-transform-types"] : [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env:
            process.platform === "win32" && process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {},
        });
      } catch (error) {
        finish(error);
        return;
      }
      child.once("error", (error) => {
        if (child.pid === undefined) finish(error);
        else terminate(error);
      });
      child.on("message", (message: unknown) => {
        if (
          !message ||
          typeof message !== "object" ||
          typeof (message as { ok?: unknown }).ok !== "boolean"
        ) {
          terminate(
            new TransferError(code, false, "transfer-process-protocol"),
          );
          return;
        }
        const response = message as Record<string, unknown>;
        outcome = {
          ok: response.ok as boolean,
          result: response.result,
          retryable: response.retryable !== false,
          diagnostic:
            typeof response.diagnostic === "string" &&
            /^[a-z0-9-]{1,80}$/u.test(response.diagnostic)
              ? response.diagnostic
              : "transfer-process-failed",
        };
      });
      child.once("exit", () => {
        if (failure) finish(failure);
        else if (!outcome?.ok)
          finish(
            new TransferError(
              code,
              outcome?.retryable !== false,
              outcome?.diagnostic ?? "transfer-process-failed",
            ),
          );
        else finish();
      });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      if (!failure)
        child.send(
          {
            operation,
            workspace,
            path,
            grant,
            expected,
            options: transferOptions,
          } satisfies TransferProcessRequest,
          (error) => {
            if (error)
              terminate(new TransferError(code, true, "transfer-process-send"));
          },
        );
    });
    // Success is delivered only after exit, when the helper no longer owns files.
    // Remove its marker before handing the input-only directory to the engine.
    await assertNoLiveTransfer(workspace, true);
    return result;
  }
}
