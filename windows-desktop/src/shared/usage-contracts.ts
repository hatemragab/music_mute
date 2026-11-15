export type LiveConnectionState =
  "stopped" | "connecting" | "live" | "reconnecting";
export interface RealtimeStatusView {
  state: LiveConnectionState;
  authenticated: boolean;
  libraryReady: boolean;
  errorCode: string | null;
}
export interface UsageAmountView {
  usedSeconds: number;
  remainingSeconds: number;
  limitSeconds: number;
  usedPercent: number;
  resetAt: string;
  resetOverdue: boolean;
  availability: "available" | "blocked";
  unavailableReason:
    | "paused"
    | "storage_limit_reached"
    | "monthly_limit_reached"
    | "waiting_job_limit"
    | null;
}
export type LinkVisibilityReason =
  | "allowed"
  | "globally_hidden"
  | "user_hidden"
  | "country_hidden"
  | "unknown_country";
export interface ProcessingPolicyView {
  revision: number;
  linkRevision: number;
  acceptNewJobs: boolean;
  linkImportVisible: boolean;
  linkImportReason: LinkVisibilityReason;
  linkImportEnabled: boolean;
  disabledCountries: string[];
  visitorCountry: string | null;
  maxDurationSeconds: number;
  maxPreparedAudioBytes: number;
  checkedAt: string;
}
export interface AccountUsageView {
  connection: LiveConnectionState;
  authenticated: boolean;
  libraryReady: boolean;
  usageState: "loading" | "current" | "stale" | "unavailable";
  usage: UsageAmountView | null;
  policyState: "loading" | "current" | "cached" | "unavailable";
  policy: ProcessingPolicyView | null;
  errorCode: string | null;
}
export type ProcessingMode = "local" | "cloud";
export interface ProcessingAdmissionPreview {
  mode: ProcessingMode;
  allowed: boolean;
  reason: string | null;
  signInRequired: boolean;
}
