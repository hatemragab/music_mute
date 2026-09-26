export interface UserView {
  id: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  providers: string[];
}

export interface ProcessingAccess {
  allowed: boolean;
  reason?:
    | "EMAIL_VERIFICATION_REQUIRED"
    | "APP_UPDATE_REQUIRED"
    | "DEVICE_SYNC_REQUIRED";
}

export interface SessionView {
  user: UserView;
  access: ProcessingAccess;
}

export type JobStatus =
  | "awaiting_upload"
  | "queued"
  | "validating"
  | "processing"
  | "uploading_result"
  | "interrupted"
  | "cancel_requested"
  | "ready"
  | "failed"
  | "cancelled";

export interface JobView {
  id: string;
  requestId: string;
  sourceTitle: string | null;
  displayName: string | null;
  sourceKind: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  processingProgress: {
    phase: string;
    phasePercent: number | null;
    stale: boolean;
  } | null;
  error: { code: string; message: string } | null;
  canDownloadInput: boolean;
  canDownloadOutput: boolean;
  input: { extension: string; bytes: number; durationSeconds: number };
}

export interface JobListView {
  items: JobView[];
  nextCursor: string | null;
}

export interface MediaImportView {
  importId: string;
  sourceTitle: string | null;
  status:
    | "queued"
    | "downloading"
    | "validating"
    | "uploading"
    | "submitted"
    | "failed";
  jobId: string | null;
  error: { code: string; message: string } | null;
}

export interface ProcessingPolicyView {
  acceptNewJobs: boolean;
  messageEn: string | null;
  messageAr: string | null;
  limits: {
    maxDurationSeconds: number;
    maxPreparedAudioBytes: number;
    maxLocalSourceBytes: number;
  };
  preparationProfile: { id: string; compatibilityRevision: string };
}

export interface DeviceView {
  installationId: string;
  platform: "android" | "ios" | "web";
  deviceModel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
