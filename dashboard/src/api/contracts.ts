export const ADMIN_ROLES = [
  "owner",
  "release_manager",
  "support",
  "viewer",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PERMISSIONS = [
  "overview.read",
  "jobs.read",
  "jobs.manage",
  "users.read",
  "users.processing.manage",
  "users.restrictions.manage",
  "users.account-recovery.manage",
  "abuse.read",
  "media.read",
  "releases.read",
  "releases.manage",
  "settings.read",
  "settings.manage",
  "health.read",
  "alerts.manage",
  "audit.read",
  "exports.read",
  "workers.read",
  "workers.manage",
  "workers.enroll",
  "workers.logs.read",
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
  source?: "audio_file" | "video_file" | "youtube";
  declaredBytes?: number | null;
  measuredBytes?: number | null;
  policyVersion?: number;
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
}

export interface UserSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  status: "active" | "disabled" | "deleting" | string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface UserDetail extends UserSummary {
  processingCounts: Record<string, number>;
  recentJobIds: string[];
  deletion: {
    requestId: string;
    requestedAt: string | null;
    recoverUntil: string | null;
    purgeStartedAt: string | null;
    phase: string | null;
    failureCode: "DEPENDENCY_RETRY" | null;
    recoveryAvailable: boolean;
  } | null;
}

export type RestrictionReasonCode =
  | "manual_review"
  | "repeated_limit_bypass"
  | "provider_cost_risk"
  | "terms_violation";

export interface AccountRestriction {
  id: string;
  accountId: string;
  status: "active" | "expired" | "removed";
  reasonCode: RestrictionReasonCode;
  note: string;
  startsAt: string;
  expiresAt: string | null;
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  revision: number;
  cancelledJobs?: number;
}

export type AbuseEventType =
  | "upload_grant_limit"
  | "upload_attempt_limit"
  | "invalid_upload_repeat"
  | "cancel_after_upload_repeat"
  | "client_retry_limit"
  | "download_grant_limit"
  | "download_bytes_limit"
  | "processing_quota_limit"
  | "queue_limit"
  | "endpoint_rate_limit"
  | "restriction_bypass_attempt"
  | "service_safety_ceiling";

export interface AbuseEvent {
  id: string;
  accountId: string;
  type: AbuseEventType;
  severity: "low" | "medium" | "high";
  operationClass: string;
  count: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  policyRevision: number | null;
  restrictionId: string | null;
  restrictionStatus: "active" | "expired" | "removed" | "none";
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
    deletionPhase: string | null;
    deletionFailureCode: "DEPENDENCY_RETRY" | null;
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

export interface AccountPolicyValues {
  monthlyProcessingSeconds: number;
  maxDurationSeconds: number;
  maxPreparedAudioBytes: number;
  dailyUploadGrants: number;
  monthlyUploadGrants: number;
  monthlyConfirmedUploadBytes: number;
  maxWaitingJobs: number;
  maxProcessingJobs: number;
  maxInfrastructureAttempts: number;
  maxClientInputAttempts: number;
  monthlyDownloadGrants: number;
  monthlyEstimatedDownloadBytes: number;
  maxRetainedOutputBytes: number;
  signedUrlTtlSeconds: number;
  monthlyServiceOutboundBytes: number;
  deletionGraceHours: number;
}

export interface AccountPolicy {
  plan: "standard";
  revision: number;
  acceptNewJobs: boolean;
  maintenanceMessageEn: string;
  maintenanceMessageAr: string | null;
  values: AccountPolicyValues;
  enforcedFeatures: string[];
  updatedBy: string;
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
  processingChanges?: Array<{
    field: string;
    before: string | number | boolean | null;
    after: string | number | boolean | null;
  }>;
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

export interface AccountPolicyOverride {
  revision: number;
  values: Partial<
    Pick<
      AccountPolicyValues,
      | "monthlyProcessingSeconds"
      | "maxDurationSeconds"
      | "maxPreparedAudioBytes"
      | "dailyUploadGrants"
      | "monthlyUploadGrants"
      | "monthlyConfirmedUploadBytes"
      | "maxClientInputAttempts"
      | "monthlyDownloadGrants"
      | "monthlyEstimatedDownloadBytes"
      | "maxRetainedOutputBytes"
      | "signedUrlTtlSeconds"
    >
  >;
  expiresAt: string | null;
  reason: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountUsage {
  schemaVersion: 2;
  plan: "standard";
  policyRevision: number;
  overrideRevision: number | null;
  effectivePolicySource: "global" | "account_override";
  overrideExpiresAt: string | null;
  period: {
    key: string;
    start: string;
    end: string;
    nextResetAt: string;
  };
  processing: {
    limitSeconds: number;
    usedSeconds: number;
    reservedSeconds: number;
    releasedSeconds: number;
    remainingSeconds: number;
  };
  uploads: {
    dailyGrantLimit: number;
    dailyGrants: number;
    dailyRemainingGrants: number;
    dailyResetAt: string;
    monthlyGrantLimit: number;
    monthlyGrants: number;
    monthlyRemainingGrants: number;
    monthlyByteLimit: number;
    confirmedBytes: number;
    monthlyRemainingBytes: number;
    monthlyResetAt: string;
  };
  storage: {
    limitBytes: number;
    retainedBytes: number;
    remainingBytes: number;
  };
  effectiveLimits: {
    maxDurationSeconds: number;
    maxPreparedAudioBytes: number;
    maxClientInputAttempts: number;
    signedUrlTtlSeconds: number;
  };
  downloads: {
    monthlyGrantLimit: number;
    monthlyGrants: number;
    monthlyRemainingGrants: number;
    monthlyByteLimit: number;
    estimatedBytes: number;
    monthlyRemainingBytes: number;
    monthlyResetAt: string;
  };
  usageRevision: number;
  waitingJobs: number;
  maxWaitingJobs: number;
  processingJobs: number;
  maxProcessingJobs: number;
  availability: {
    status: "available" | "blocked";
    reason:
      | "paused"
      | "monthly_limit_reached"
      | "waiting_job_limit"
      | "storage_limit_reached"
      | null;
  };
  checkedAt: string;
  policyOverride: AccountPolicyOverride | null;
}
