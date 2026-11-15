import { randomUUID } from "node:crypto";
import type { HostContext } from "../host-context.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import { hashPrivateFile } from "../prepare/private-files.js";
import {
  runOwnedMediaOperation,
  mediaToolRelease,
  MediaShutdownPending,
} from "../prepare/owned-media-operation.js";
import {
  CloudScratchWorkspace,
  type CloudScratchAdmission,
} from "../cloud/workspace.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import type {
  WindowsDiagnosticDoctor,
  WindowsDiagnosticCheck,
} from "../../shared/diagnostics-contracts.js";
import {
  parseDiagnosticDoctorConfiguration,
  parseDiagnosticDoctorResult,
} from "./doctor-child.js";
/** Explicit CPU-only Doctor owns its scratch/whole native tree independently of model readiness. */
export class WindowsDiagnosticDoctorRunner {
  private pending = 0;
  private readonly retained = new Set<CloudScratchWorkspace>();
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly host: HostContext,
    private readonly operations: Pick<
      WindowsPreparationOperations,
      "snapshotMediaTools"
    >,
    private readonly storage: CloudScratchAdmission,
  ) {}
  activity() {
    return {
      pending: this.pending,
      retained: this.retained.size,
      idle: this.pending === 0 && this.retained.size === 0,
    };
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
      } catch {
        /* Observers never release native ownership. */
      }
  }
  async run(
    full: boolean,
    signal: AbortSignal,
  ): Promise<WindowsDiagnosticDoctor> {
    // An explicit recovery must never retire another live check's workspace.
    if (this.pending) throw new Error("DIAGNOSTICS_BUSY");
    this.pending++;
    this.changed();
    let workspace: CloudScratchWorkspace | undefined;
    try {
      signal.throwIfAborted();
      if (this.retained.size) await this.recoverRetained();
      const nativeIdentity = await this.host.native.identity();
      if (
        nativeIdentity.sid !== this.host.identity.sid ||
        nativeIdentity.sessionId !== this.host.identity.sessionId
      )
        throw new Error("DIAGNOSTICS_CONTEXT_INVALID");
      try {
        await this.operations.snapshotMediaTools(signal);
      } catch {
        signal.throwIfAborted();
        const gpus = await this.host.native.enumerateGpus();
        return {
          version: 1,
          healthy: false,
          inferencePerformed: false,
          networkRequests: 0,
          gpuCount: gpus.length,
          directmlAvailable: false,
          expectedModelSha256: MODEL.sha256,
          verifiedModelSha256: null,
          checks: [
            { name: "native-host", status: "passed", code: "OK" },
            {
              name: "physical-gpu",
              status: gpus.length ? "passed" : "warning",
              code: gpus.length ? "OK" : "GPU_UNAVAILABLE",
            },
            {
              name: "signed-runtime",
              status: "failed",
              code: "SETUP_REQUIRED",
            },
            { name: "python-lock", status: "not-run", code: "SETUP_REQUIRED" },
            {
              name: "engine-protocol",
              status: "not-run",
              code: "SETUP_REQUIRED",
            },
            { name: "media-tools", status: "not-run", code: "SETUP_REQUIRED" },
            { name: "model-bytes", status: "not-run", code: "MODEL_NOT_READY" },
            {
              name: "live-inference",
              status: "not-run",
              code: "EXPLICIT_GPU_QUALIFICATION_REQUIRED",
            },
          ],
        };
      }
      const id = randomUUID();
      workspace = await CloudScratchWorkspace.create(
        this.host,
        this.storage,
        `cloud\\work\\${id}`,
        1024 * 1024,
      );
      this.retained.add(workspace);
      this.changed();
      const result = await runOwnedMediaOperation({
        host: this.host,
        tools: this.operations,
        signal,
        configuration: (tools) =>
          parseDiagnosticDoctorConfiguration({
            version: 1,
            operation: "diagnostics_doctor",
            requestId: id,
            executionId: randomUUID(),
            release: mediaToolRelease(tools),
            sid: this.host.identity.sid,
            manifestSha256: tools.manifestSha256,
            helperSha256: tools.nativeSha256,
          }),
        resultRelative: (c) =>
          `cloud\\work\\${c.requestId}\\doctor-result.json`,
        parse: parseDiagnosticDoctorResult,
        maxResultBytes: 4096,
        timeoutMs: 90000,
        beforeLaunch: () => workspace!.beforeLaunch(),
        onOwner: (o) => workspace!.onOwner(o),
      }).catch((error) => {
        if (error instanceof MediaShutdownPending) workspace!.markUnsafe();
        throw error;
      });
      const checks: WindowsDiagnosticCheck[] = [
        { name: "signed-runtime", status: "passed", code: "OK" },
        { name: "native-host", status: "passed", code: "OK" },
        {
          name: "physical-gpu",
          status: result.gpuCount > 0 ? "passed" : "warning",
          code: result.gpuCount > 0 ? "OK" : "GPU_UNAVAILABLE",
        },
        {
          name: "python-lock",
          status:
            result.pythonAccepted && result.nodeAccepted ? "passed" : "failed",
          code:
            result.pythonAccepted && result.nodeAccepted
              ? "OK"
              : "ENGINE_PROTOCOL_INVALID",
        },
        {
          name: "engine-protocol",
          status: result.engineProtocolAccepted ? "passed" : "failed",
          code: result.engineProtocolAccepted
            ? "OK"
            : "ENGINE_PROTOCOL_INVALID",
        },
        {
          name: "media-tools",
          status: result.mediaToolsAccepted ? "passed" : "failed",
          code: result.mediaToolsAccepted ? "OK" : "TOOL_FAILED",
        },
      ];
      let verifiedModelSha256: string | null = null;
      if (full)
        try {
          if (
            (await hashPrivateFile(
              this.host,
              `models\\${MODEL.filename}`,
              MODEL.bytes,
              signal,
            )) !== MODEL.sha256
          )
            throw new Error();
          verifiedModelSha256 = MODEL.sha256;
        } catch {
          signal.throwIfAborted();
        }
      checks.push(
        {
          name: "model-bytes",
          status: verifiedModelSha256 ? "passed" : full ? "failed" : "not-run",
          code: verifiedModelSha256 ? "OK" : "MODEL_NOT_READY",
        },
        {
          name: "live-inference",
          status: "not-run",
          code: "EXPLICIT_GPU_QUALIFICATION_REQUIRED",
        },
      );
      return {
        version: 1,
        checks,
        healthy:
          checks
            .filter((c) => c.name !== "live-inference")
            .every((c) => c.status === "passed") && result.directmlAvailable,
        inferencePerformed: false,
        networkRequests: 0,
        gpuCount: result.gpuCount,
        directmlAvailable: result.directmlAvailable,
        expectedModelSha256: MODEL.sha256,
        verifiedModelSha256,
      };
    } finally {
      try {
        if (workspace) {
          await workspace.close();
          this.retained.delete(workspace);
        }
      } finally {
        this.pending--;
        this.changed();
      }
    }
  }
  async recover(): Promise<void> {
    if (this.pending) throw new Error("DIAGNOSTICS_BUSY");
    return this.recoverRetained();
  }
  private async recoverRetained(): Promise<void> {
    for (const workspace of this.retained) {
      await workspace.close();
      this.retained.delete(workspace);
    }
    this.changed();
  }
}
