import type { ConsumerProcessIdentity } from "../../../../worker/src/platform/windows/consumer-native.js";
import type {
  DownloadGrant,
  JobMetadata,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import type {
  JobSnapshot,
  MediaSource,
} from "../../../../chrome-extension/src/shared/protocol.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type { CloudControllerOptions } from "../cloud/controller.js";
import type { ChromeDiagnosticExport } from "../diagnostics/browser-report.js";
import type { InstallationCheck } from "../../../../chrome-extension/src/shared/installation-check.js";
import {
  parseBrowserToolkitEvent,
  type BrowserToolkitPort,
  type BrowserToolkitEvent,
} from "./toolkit.js";
import type {
  PersonalPlaybackOwnerProof,
  PersonalPlaybackOwnerRequest,
} from "../session/personal-owner-proof.js";

export interface BrowserAccountSelection {
  processing_provider: "LOCAL_WINDOWS" | "ONLINE_MUSICMUTE";
  processing_scope: string | null;
  cloud_ready: boolean;
  error_code: string | null;
  cache_reuse_supported: boolean;
  publication_supported: boolean;
}
/** Native-only publisher. Paths, R2 grants and account scope never enter Chrome replies. */
export interface BrowserCloudMediaPort {
  publish(input: {
    ownerId: string;
    peer: ConsumerProcessIdentity;
    scope: AccountSessionScope;
    requestId: string;
    videoId: string;
    durationSeconds: number;
    job: JobMetadata;
    grant: DownloadGrant;
    signal: AbortSignal;
    assertCurrent(): void;
  }): Promise<{ media: MediaSource; release(): Promise<void> }>;
}
/** Always current-Windows-user guest scope, never the app account's Library. */
export interface BrowserLocalReusePort {
  find(input: {
    ownerId: string;
    peer: ConsumerProcessIdentity;
    requestId: string;
    videoId: string;
    durationSeconds: number;
    cacheOnly: boolean;
    signal: AbortSignal;
  }): Promise<{ media: MediaSource; release(): Promise<void> } | null>;
}
export interface BrowserPublicationPort {
  subscribe(
    listener: (update: {
      ownerId: string;
      jobId: string;
      videoId: string;
      state: "pending" | "saving" | "saved";
    }) => void,
  ): () => void;
  playbackStarted(input: {
    ownerId: string;
    peer: ConsumerProcessIdentity;
    jobId: string;
    videoId: string;
    proof: PersonalPlaybackOwnerProof;
  }): Promise<"pending" | "saving" | "saved" | null>;
}
export interface BrowserAccountAuthorityOptions {
  origin: string | null;
  installationId: string;
  account: CloudControllerOptions["account"];
  usage: CloudControllerOptions["usage"];
  realtime: CloudControllerOptions["realtime"];
  modeStore: CloudControllerOptions["modeStore"];
  /** Same authoritative selection used by the UI, read synchronously before intake. */
  selectedMode(): "local" | "cloud";
  /** Synchronous update/maintenance intake fence; accepted operations remain owned. */
  consumersAllowed?(): boolean;
  media: BrowserCloudMediaPort;
  localReuse?: BrowserLocalReusePort;
  publication?: BrowserPublicationPort;
  /** Current-SID personal report only: no worker, account token, model or network authority. */
  diagnostics?: {
    exportReport(
      requestId: string,
      signal: AbortSignal,
    ): Promise<ChromeDiagnosticExport>;
  };
  toolkit?: BrowserToolkitPort;
  provePersonalOwner?(
    request: PersonalPlaybackOwnerRequest,
  ): Promise<PersonalPlaybackOwnerProof>;
  /** Actual packaged-host/parent/bootstrap verification; SID equality alone is insufficient. */
  verifyPeer(peer: ConsumerProcessIdentity): Promise<boolean>;
  fetch?: CloudControllerOptions["fetch"];
  now?: () => number;
}
export interface BrowserAccountState {
  version: 1;
  instance_id: string;
  revision: number;
  selection: BrowserAccountSelection;
  job: JobSnapshot | null;
  unchanged: boolean;
  installation_check?: { request_id: string; status: InstallationCheck };
  publication?: {
    job_id: string;
    video_id: string;
    state: "pending" | "saving" | "saved";
  };
}
export type BrowserAccountCommand = {
  version: 1;
  request_id: string;
  owner_id: string;
} & (
  | {
      action:
        | "selection"
        | "status"
        | "detach"
        | "diagnostics"
        | "check"
        | "clear_cache";
    }
  | { action: "event"; event: BrowserToolkitEvent }
  | {
      action: "local_lookup";
      video_id: string;
      duration_seconds: number;
      cache_only: boolean;
      restore_job_id?: string;
    }
  | { action: "playback_started"; job_id: string; video_id: string }
  | { action: "cancel"; job_id: string }
  | { action: "wait"; after_revision: number; instance_id?: string }
  | {
      action: "start";
      video_id: string;
      duration_seconds: number;
      processing_scope: string;
    }
);
export type BrowserAccountReply =
  | { version: 1; request_id: string; ok: true; state: BrowserAccountState }
  | { version: 1; request_id: string; ok: false; error_code: string };
export type BrowserDiagnosticReply =
  | {
      version: 1;
      request_id: string;
      ok: true;
      diagnostics: ChromeDiagnosticExport;
    }
  | { version: 1; request_id: string; ok: false; error_code: string };

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function parseBrowserAccountCommand(
  value: unknown,
): BrowserAccountCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_COMMAND");
  const row = value as Record<string, unknown>,
    shapes: Record<string, string[]> = {
      selection: [],
      diagnostics: [],
      check: [],
      clear_cache: [],
      event: ["event"],
      local_lookup: [
        "video_id",
        "duration_seconds",
        "cache_only",
        ...(row.restore_job_id === undefined ? [] : ["restore_job_id"]),
      ],
      playback_started: ["job_id", "video_id"],
      status: [],
      detach: [],
      cancel: ["job_id"],
      wait: [
        "after_revision",
        ...(row.instance_id === undefined ? [] : ["instance_id"]),
      ],
      start: ["video_id", "duration_seconds", "processing_scope"],
    };
  if (
    row.version !== 1 ||
    typeof row.request_id !== "string" ||
    !UUID.test(row.request_id) ||
    typeof row.owner_id !== "string" ||
    !UUID.test(row.owner_id) ||
    typeof row.action !== "string" ||
    !Object.hasOwn(shapes, row.action) ||
    Object.keys(row).sort().join() !==
      ["version", "request_id", "owner_id", "action", ...shapes[row.action]!]
        .sort()
        .join()
  )
    throw new Error("INVALID_COMMAND");
  if (row.action === "event") parseBrowserToolkitEvent(row.event);
  if (
    ["cancel", "playback_started"].includes(String(row.action)) &&
    (typeof row.job_id !== "string" || !UUID.test(row.job_id))
  )
    throw new Error("INVALID_COMMAND");
  if (
    row.action === "playback_started" &&
    (typeof row.video_id !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/u.test(row.video_id))
  )
    throw new Error("INVALID_COMMAND");
  if (
    row.action === "local_lookup" &&
    (typeof row.video_id !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/u.test(row.video_id) ||
      typeof row.duration_seconds !== "number" ||
      !Number.isFinite(row.duration_seconds) ||
      row.duration_seconds <= 0 ||
      row.duration_seconds > 1200 ||
      typeof row.cache_only !== "boolean" ||
      (row.restore_job_id !== undefined &&
        (typeof row.restore_job_id !== "string" ||
          !UUID.test(row.restore_job_id))) ||
      (row.restore_job_id !== undefined && row.cache_only !== true))
  )
    throw new Error("INVALID_COMMAND");
  if (
    row.action === "wait" &&
    (!Number.isSafeInteger(row.after_revision) ||
      (row.after_revision as number) < 0 ||
      (row.instance_id !== undefined &&
        (typeof row.instance_id !== "string" || !UUID.test(row.instance_id))))
  )
    throw new Error("INVALID_COMMAND");
  if (
    row.action === "start" &&
    (typeof row.video_id !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/u.test(row.video_id) ||
      typeof row.duration_seconds !== "number" ||
      !Number.isFinite(row.duration_seconds) ||
      row.duration_seconds <= 0 ||
      row.duration_seconds > 1200 ||
      typeof row.processing_scope !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.processing_scope))
  )
    throw new Error("INVALID_COMMAND");
  return structuredClone(row) as BrowserAccountCommand;
}
