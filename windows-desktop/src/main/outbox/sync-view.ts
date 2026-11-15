import { DesktopApiError } from "../../../../chrome-extension/src/companion/account-api.js";
import { validateUploadGrant } from "../../../../chrome-extension/src/companion/local-sync-client.js";
import { OUTBOX_PROFILE, type OutboxArtifact } from "./model.js";
export interface OutboxSyncView {
  syncId: string;
  jobId: string;
  requestId: string;
  status: "awaiting_upload" | "ready" | "expired";
  committed: boolean;
  uploadGrants: { original: unknown; vocals: unknown } | null;
}
export function parseOutboxSyncView(
  value: unknown,
  requestId: string,
): OutboxSyncView {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DesktopApiError("LOCAL_SYNC_REPLY_INVALID");
  const row = value as Record<string, unknown>;
  if (
    !/^[a-f0-9]{24}$/.test(String(row.sync_id)) ||
    !/^[a-f0-9]{24}$/.test(String(row.job_id)) ||
    row.request_id !== requestId ||
    row.profile_id !== OUTBOX_PROFILE ||
    !["awaiting_upload", "ready", "expired"].includes(String(row.status)) ||
    typeof row.committed !== "boolean" ||
    row.committed !== (row.status === "ready") ||
    !(
      row.upload_grants === null ||
      (!!row.upload_grants &&
        typeof row.upload_grants === "object" &&
        !Array.isArray(row.upload_grants))
    ) ||
    (row.revision !== undefined &&
      (!Number.isSafeInteger(row.revision) || Number(row.revision) < 0))
  )
    throw new DesktopApiError("LOCAL_SYNC_REPLY_INVALID");
  return {
    syncId: row.sync_id as string,
    jobId: row.job_id as string,
    requestId,
    status: row.status as OutboxSyncView["status"],
    committed: row.committed,
    uploadGrants: row.upload_grants as OutboxSyncView["uploadGrants"],
  };
}
export function outboxGrant(value: unknown, artifact: OutboxArtifact) {
  return validateUploadGrant(value, {
    path: artifact.relativePath,
    extension: artifact.extension as "m4a",
    content_type: artifact.contentType,
    bytes: artifact.bytes,
    duration_seconds: artifact.durationSeconds,
    sha256: artifact.sha256,
  });
}
