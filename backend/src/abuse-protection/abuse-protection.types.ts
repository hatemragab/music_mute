export const ABUSE_EVENT_TYPES = [
  'upload_grant_limit',
  'upload_attempt_limit',
  'invalid_upload_repeat',
  'cancel_after_upload_repeat',
  'client_retry_limit',
  'download_grant_limit',
  'download_bytes_limit',
  'processing_quota_limit',
  'queue_limit',
  'endpoint_rate_limit',
  'restriction_bypass_attempt',
  'service_safety_ceiling',
] as const;

export type AbuseEventType = (typeof ABUSE_EVENT_TYPES)[number];

export const ABUSE_EVENT_SEVERITIES = ['low', 'medium', 'high'] as const;
export type AbuseEventSeverity = (typeof ABUSE_EVENT_SEVERITIES)[number];

export const ABUSE_OPERATION_CLASSES = [
  'job_create',
  'upload_grant',
  'upload_confirm',
  'job_retry',
  'job_cancel',
  'download_grant',
  'account_deletion',
  'account_recovery',
  'admin',
  'other',
] as const;

export type AbuseOperationClass = (typeof ABUSE_OPERATION_CLASSES)[number];

export const RESTRICTION_REASON_CODES = [
  'manual_review',
  'repeated_limit_bypass',
  'provider_cost_risk',
  'terms_violation',
] as const;

export type RestrictionReasonCode = (typeof RESTRICTION_REASON_CODES)[number];

export interface RecordAbuseEvent {
  accountId: string;
  type: AbuseEventType;
  severity: AbuseEventSeverity;
  operationClass: AbuseOperationClass;
  policyRevision?: number | null;
  restrictionId?: string | null;
  occurredAt?: Date;
  count?: number;
}

export type RestrictedOperation =
  | 'job_create'
  | 'upload_grant'
  | 'upload_confirm'
  | 'job_retry'
  | 'download_grant';
