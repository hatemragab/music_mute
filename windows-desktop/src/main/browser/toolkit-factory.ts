import { randomUUID } from "node:crypto";
import type { HostContext } from "../host-context.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import { WindowsDiagnosticDoctorRunner } from "../diagnostics/doctor.js";
import {
  CloudScratchWorkspace,
  type CloudScratchAdmission,
} from "../cloud/workspace.js";
import {
  runOwnedMediaOperation,
  mediaToolRelease,
  MediaShutdownPending,
} from "../prepare/owned-media-operation.js";
import { BrowserToolkit, type BrowserToolkitEvent } from "./toolkit.js";
import {
  parseBrowserYoutubeCheckConfiguration,
  parseBrowserYoutubeCheckResult,
} from "./youtube-check-child.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import type { WindowsDiagnosticDoctor } from "../../shared/diagnostics-contracts.js";
export function createWindowsBrowserToolkit(options: {
  packageIdentity: string;
  host: HostContext;
  operations: Pick<WindowsPreparationOperations, "snapshotMediaTools">;
  storage: CloudScratchAdmission;
  clearCache(signal: AbortSignal): Promise<void>;
  recordEvent(input: BrowserToolkitEvent): Promise<void> | void;
}) {
  // Dedicated CHECK ownership; never recover the UI Doctor's active workspace.
  const doctor = new WindowsDiagnosticDoctorRunner(
    options.host,
    options.operations,
    options.storage,
  );
  let report: WindowsDiagnosticDoctor | undefined,
    active = 0;
  const retained = new Set<CloudScratchWorkspace>(),
    listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners)
      try {
        listener();
      } catch {}
  };
  const toolkit = new BrowserToolkit({
    packageIdentity: options.packageIdentity,
    clearCache: options.clearCache,
    recordEvent: options.recordEvent,
    inspect: {
      runtime: async (signal) => {
        report = undefined;
        report = await doctor.run(true, signal);
        if (
          [
            "signed-runtime",
            "native-host",
            "python-lock",
            "engine-protocol",
            "media-tools",
          ].some(
            (name) =>
              !report!.checks.some(
                (check) => check.name === name && check.status === "passed",
              ),
          )
        )
          throw new Error("SETUP_REQUIRED");
      },
      model: async (signal) => {
        signal.throwIfAborted();
        if (report?.verifiedModelSha256 !== MODEL.sha256)
          throw new Error("MODEL_NOT_READY");
        if (!report.directmlAvailable || !report.gpuCount)
          throw new Error("GPU_UNSUPPORTED");
      },
      youtube_tools: async (signal) => {
        const id = randomUUID();
        let workspace: CloudScratchWorkspace | undefined;
        active++;
        changed();
        try {
          if (retained.size) throw new Error("INSTALLATION_CHECK_BUSY");
          workspace = await CloudScratchWorkspace.create(
            options.host,
            options.storage,
            `cloud\\work\\${id}`,
            16 * 1024 * 1024,
          );
          retained.add(workspace);
          changed();
          const result = await runOwnedMediaOperation({
            host: options.host,
            tools: options.operations,
            signal,
            configuration: (tools) =>
              parseBrowserYoutubeCheckConfiguration({
                version: 1,
                operation: "browser_check_youtube",
                requestId: id,
                executionId: randomUUID(),
                release: mediaToolRelease(tools),
                sid: options.host.identity.sid,
                manifestSha256: tools.manifestSha256,
                helperSha256: tools.nativeSha256,
              }),
            resultRelative: (c) =>
              `cloud\\work\\${c.requestId}\\youtube-check-result.json`,
            parse: parseBrowserYoutubeCheckResult,
            maxResultBytes: 4096,
            timeoutMs: 200000,
            beforeLaunch: () => workspace!.beforeLaunch(),
            onOwner: (owner) => workspace!.onOwner(owner),
          }).catch((error) => {
            if (error instanceof MediaShutdownPending) workspace!.markUnsafe();
            throw error;
          });
          if (!result.passed)
            throw new Error(result.errorCode ?? "YOUTUBE_TOOLS_UNAVAILABLE");
        } finally {
          try {
            if (workspace) {
              await workspace.close();
              retained.delete(workspace);
            }
          } finally {
            active--;
            changed();
          }
        }
      },
    },
  });
  const subscribeBase = toolkit.subscribeActivity.bind(toolkit);
  return Object.assign(toolkit, {
    activity: () => ({
      pending: active + doctor.activity().pending,
      retained: retained.size + doctor.activity().retained,
      idle:
        active === 0 &&
        retained.size === 0 &&
        doctor.activity().idle &&
        !toolkit.checking(),
    }),
    subscribeActivity: (listener: () => void) => {
      listeners.add(listener);
      const stop = doctor.subscribeActivity(listener),
        other = subscribeBase(listener);
      listener();
      return () => {
        listeners.delete(listener);
        stop();
        other();
      };
    },
    dispose: async () => {
      await BrowserToolkit.prototype.dispose.call(toolkit);
      await doctor.recover();
      for (const workspace of retained) {
        await workspace.close();
        retained.delete(workspace);
      }
      changed();
    },
  });
}
