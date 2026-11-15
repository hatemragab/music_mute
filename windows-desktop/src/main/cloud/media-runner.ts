import { randomUUID } from "node:crypto";
import type { HostContext } from "../host-context.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import {
  runOwnedMediaOperation,
  mediaToolRelease,
} from "../prepare/owned-media-operation.js";
import type { CloudScratchWorkspace } from "./workspace.js";
import type {
  CloudMediaChildConfig,
  CloudMediaChildResult,
} from "./media-child.js";
export function parseCloudMediaResult(
  value: unknown,
  config: CloudMediaChildConfig,
): CloudMediaChildResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLOUD_INPUT_INVALID");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 9 ||
    row.version !== 1 ||
    row.operation !== config.operation ||
    row.requestId !== config.requestId ||
    row.executionId !== config.executionId ||
    !["audio_file", "video_file"].includes(String(row.source)) ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > 100000000 ||
    !Number.isFinite(row.durationSeconds) ||
    (row.durationSeconds as number) <= 0 ||
    (row.durationSeconds as number) > 1200 ||
    typeof row.sha256 !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(row.sha256) ||
    Buffer.from(row.sha256, "base64").toString("base64") !== row.sha256 ||
    row.codec !== (config.operation === "cloud_prepare" ? "aac" : "mp3")
  )
    throw new Error("CLOUD_INPUT_INVALID");
  return row as unknown as CloudMediaChildResult;
}
/** Uses the shared fixed Prepare guardian and exact Node-to-Native workspace handoff. */
export class WindowsCloudMediaRunner {
  constructor(
    private readonly host: HostContext,
    private readonly tools: Pick<
      WindowsPreparationOperations,
      "snapshotMediaTools"
    >,
  ) {}
  run(
    operation: CloudMediaChildConfig["operation"],
    requestId: string,
    inputBytes: number,
    signal: AbortSignal,
    workspace: Pick<CloudScratchWorkspace, "beforeLaunch" | "onOwner">,
  ): Promise<CloudMediaChildResult> {
    return runOwnedMediaOperation({
      host: this.host,
      tools: this.tools,
      signal,
      configuration: (verified) => ({
        version: 1 as const,
        operation,
        requestId,
        executionId: randomUUID(),
        release: mediaToolRelease(verified),
        sid: this.host.identity.sid,
        manifestSha256: verified.manifestSha256,
        helperSha256: verified.nativeSha256,
        inputBytes,
      }),
      resultRelative: () => `cloud\\work\\${requestId}\\media-result.json`,
      parse: parseCloudMediaResult,
      maxResultBytes: 4096,
      beforeLaunch: () => workspace.beforeLaunch(),
      onOwner: (owner) => workspace.onOwner(owner),
    }).catch((error) => {
      if (error instanceof Error && error.message === "MEDIA_BUSY")
        throw new Error("CLOUD_BUSY");
      throw error;
    });
  }
}
