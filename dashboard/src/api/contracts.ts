export const ADMIN_ROLES = [
  "owner",
  "release_manager",
  "worker_manager",
  "support",
  "viewer",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PERMISSIONS = [
  "overview.read",
  "workers.read",
  "workers.manage",
  "workers.recover",
  "jobs.read",
  "jobs.manage",
  "users.read",
  "users.processing.manage",
  "users.account-recovery.manage",
  "media.read",
  "releases.read",
  "releases.manage",
  "settings.read",
  "settings.manage",
  "health.read",
  "alerts.manage",
  "audit.read",
  "exports.read",
  "admin.access.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface AdminSession {
  uid: string;
  verifiedEmail: string;
  role: AdminRole;
  permissions: Permission[];
  accessRevision: number;
  authTimeSec: number;
  serverTime: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  asOf: string;
}

export interface AdminAccess {
  uid: string;
  verifiedEmail: string;
  role: AdminRole;
  active: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkerState = "enabled" | "draining" | "revoked";

export interface WorkerSummary {
  id: string;
  label: string;
  state: WorkerState;
  online: boolean;
  lastSeenAt: string | null;
  activeJobId: string | null;
  activeAttemptId: string | null;
  recoveryRequired: boolean;
  revision: number;
}

export interface WorkerAssignment {
  jobId: string;
  attemptId: string;
  sessionId: string;
  generation: number;
  leaseExpiresAt: string;
}

export interface WorkerDetail extends WorkerSummary {
  protocolVersion: number;
  slotState: "idle" | "active" | "reserved" | "recovery_required";
  assignment: WorkerAssignment | null;
  recentEvents: Array<{
    id: string;
    action: string;
    at: string;
    outcome: string;
  }>;
}

export const JOB_STATUSES = [
  "awaiting_upload",
  "queued",
  "validating",
  "processing",
  "uploading_result",
  "interrupted",
  "cancel_requested",
  "ready",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobSummary {
  id: string;
  userId: string;
  status: JobStatus;
  workerId: string | null;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedSeconds: number | null;
  queuePosition: number | null;
  revision: number;
  lastError: { code: string; message?: string } | null;
  displayName: string | null;
  sourceUrl?: string | null;
  userEmail?: string;
  userDisplayName?: string;
}

export interface JobDetail extends JobSummary {
  retryOfJobId: string | null;
  stageTimings: Array<{
    stage: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationSeconds: number | null;
  }>;
  declaredDurationSeconds: number | null;
  measuredDurationSeconds: number | null;
  media: { inputAvailable: boolean; resultAvailable: boolean };
  recoveryRequired: boolean;
  activeAttemptId: string | null;
}

export interface AttemptSummary {
  id: string;
  jobId: string;
  workerId: string | null;
  sessionId: string | null;
  generation: number;
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
  interruptedAt: string | null;
  releasedAt: string | null;
  recoveryRequired: boolean;
  durationSeconds: number | null;
}

export interface UserSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  status: "active" | "disabled" | "deleting" | string;
  processingSuspended: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface UserDetail extends UserSummary {
  processingCounts: Record<string, number>;
  recentJobIds: string[];
  suspension: {
    reason: string;
    actorUid: string;
    at: string;
  } | null;
  deletion: {
    requestId: string;
    requestedAt: string | null;
    recoverUntil: string | null;
    purgeStartedAt: string | null;
    recoveryAvailable: boolean;
  } | null;
}

export interface AccountRecoveryRequest {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  reason: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  reviewReason: string | null;
  revision: number;
  deletionRequestId: string;
  deletionRequestedAt: string;
  recoverUntil: string;
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    status: string | null;
  };
}

export interface AccountRecoveryQueueSummary {
  pendingCount: number;
  oldestRequestedAt: string | null;
  highPriority: boolean;
  asOf: string;
}

export type ReleasePlatform = "android" | "ios";
export type ReleaseSource = "direct_apk" | "google_play" | "app_store";

export interface ReleaseSummary {
  id: string;
  platform: ReleasePlatform;
  source: ReleaseSource;
  versionName: string;
  buildNumber: number;
  changelogEn: string;
  storeUrl: string | null;
  state: "draft" | "published" | "withdrawn";
  artifactState:
    "awaiting_upload" | "verifying" | "verified" | "rejected" | null;
  revision: number;
  createdAt: string;
  publishedAt: string | null;
}

export interface ReleaseDetail extends ReleaseSummary {
  bytes: number | null;
  sha256Hex: string | null;
  signerSha256Hex: string | null;
  rejectionCode: string | null;
  publishedBy: string | null;
}

export interface ReleaseProposal {
  platform: ReleasePlatform;
  source: ReleaseSource;
  current: { versionName: string; buildNumber: number };
  suggested: { versionName: string; buildNumber: number };
}

export interface UpdatePolicy {
  revision: number;
  android: {
    minimumBuild: number | null;
    source: "direct_apk" | "google_play";
    directReleaseId: string | null;
    storeReleaseId: string | null;
  };
  ios: {
    minimumBuild: number | null;
    storeReleaseId: string | null;
  };
}

export interface ProcessingSettings {
  revision: number;
  acceptNewJobs: boolean;
  maintenanceMessageEn: string;
  maintenanceMessageAr: string | null;
  maxInputBytesExclusive: number;
  maxDurationSecondsExclusive: number;
  maxActiveJobsPerUser: number | null;
  updatedAt: string;
}

export interface OverviewSnapshot {
  asOf: string;
  from: string;
  to: string;
  counts: {
    submitted: number;
    processingActiveUsers: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  queue: {
    waiting: number;
    processing: number;
    oldestWaitSeconds: number | null;
  };
  timings: {
    meanQueueWaitSeconds: number | null;
    meanProcessingSeconds: number | null;
    sampleCount: { queueWait: number; processing: number };
  };
  workers: { total: number; online: number };
  series: Array<{
    start: string;
    submitted: number;
    completed: number;
    failed: number;
    cancelled: number;
  }>;
  releaseSummary?: {
    draft: number;
    published: number;
    withdrawn: number;
    rejectedArtifacts: number;
  };
}

export interface HealthSnapshot {
  status: "healthy" | "degraded" | "unavailable" | "unknown";
  asOf: string;
  components: Array<{
    name: string;
    status: "healthy" | "degraded" | "unavailable" | "unknown";
    checkedAt: string | null;
    code: string | null;
  }>;
  activeAlertCount: number;
}

export const ALERT_SEVERITIES = ["warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface AlertRecord {
  id: string;
  type: string;
  severity: AlertSeverity;
  resourceId: string | null;
  state: "active" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  revision: number;
  message: string;
}

export interface AuditEvent {
  id: string;
  actorUid: string;
  action: string;
  resourceType: string;
  resourceId: string;
  operationId: string | null;
  reason: string | null;
  at: string;
  previousRevision: number | null;
  nextRevision: number | null;
  outcome: string;
}

export interface OperationReceipt {
  operationId: string;
  status: "pending" | "succeeded" | "failed";
  resourceId: string | null;
  revision?: number;
  code?: string;
}

export interface MediaGrant {
  url: string;
  expiresAt: string;
  bytes: number;
  contentType: string;
  filename: string;
}

export interface RevisionCommand {
  expectedRevision: number;
  operationId: string;
  reason: string;
}
