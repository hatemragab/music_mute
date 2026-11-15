export type LogEvent = string;
export type LogSource =
  | "backend"
  | "web-client"
  | "dashboard"
  | "landing-page"
  | "chrome-extension"
  | "macos"
  | "worker"
  | "windows-desktop"
  | "ios"
  | "android"
  | "provider"
  | "redis"
  | "mongodb"
  | "collector";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CaptureSelection {
  archive?: string;
}

export interface SourceFilters {
  operationId?: string;
  operation?: string;
  result?: string;
  service?: string;
  jobId?: string;
  importId?: string;
  workerId?: string;

  source?: LogSource;
  instanceId?: string;
  captureId?: string;
  category?: string;
  name?: string;
  phase?: string;
  traceId?: string;
  roomId?: string;
  sessionGeneration?: number;
  metricName?: string;
  metricGroup?: string;
  sourceEventCode?: string;
  timestampSource?: "service" | "collection";
}

export interface LogFilters extends SourceFilters {
  query?: string;
  requestId?: string;
  userId?: string;
  recipientUserId?: string;
  event?: LogEvent;
  eventType?: string;
  method?: string;
  route?: string;
  level?: LogLevel;
  status?: number;
  from?: string;
  to?: string;
}

export interface SearchLogsInput extends LogFilters, CaptureSelection {
  limit?: number;
  cursor?: string;
  includePayloads?: boolean;
}

export interface TraceEventsInput extends SourceFilters, CaptureSelection {
  source: LogSource;
  instanceId: string;
  traceId: string;
  includePayloads?: boolean;
  limit?: number;
  cursor?: string;
}

export interface TraceEventsResult extends SearchLogsResult {
  semantics: string;
}

export interface TraceRequestInput extends CaptureSelection, SourceFilters {
  requestId: string;
  includePayloads?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ErrorSummaryInput extends SourceFilters, CaptureSelection {
  from?: string;
  to?: string;
  userId?: string;
  recipientUserId?: string;
  route?: string;
  method?: string;
  limit?: number;
  cursor?: string;
}

/** Metadata is projected explicitly; payloads require an opt-in on each call. */
export interface LogRecordView {
  operationId?: string;
  summary?: string;
  service?: string;
  jobId?: string;
  importId?: string;
  workerId?: string;

  timestamp: string;
  sourceTimestamp?: string;
  receivedAt?: string;
  collectedAt?: string;
  timestampSource?: "service" | "collection";
  sourceEventCode?: string;
  metricName?: string;
  metricGroup?: string;
  metricValue?: number;
  source: LogSource;
  instanceId?: string;
  captureId?: string;
  category?: string;
  name?: string;
  phase?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  sessionGeneration?: number;
  roomId?: string;
  seq?: number;
  durationMicros?: number;
  origin?: string;
  component?: string;
  operation?: string;
  direction?: string;
  level: LogLevel;
  event: LogEvent;
  requestId: string | null;
  userId: string | null;
  actorUserId?: string | null;
  recipientUserId?: string | null;
  method?: string;
  route?: string;
  status?: number | null;
  durationMs?: number;
  aborted?: boolean;
  eventType?: string;
  publicationId?: string | null;
  channel?: string;
  attempt?: number;
  result?: string;
  pts?: number;
  payload?: Record<string, unknown>;
  payloadOmitted?: boolean;
  omissionReason?: "record_byte_limit";
  omittedBytes?: number;
  metadataTruncated?: boolean;
}

/** Counts and traces describe only these byte offsets in this snapshot. */
export interface LogCoverage {
  snapshotBytes: number;
  scannedFromByte: number;
  scannedToByte: number;
  readBytes: number;
  scannedRecords: number;
  malformedLines: number;
  invalidRecords: number;
  oversizedLines: number;
  incompleteTrailingLine: boolean;
  skippedBoundaryBytes: number;
  olderRecordsAvailable: boolean;
  partial: boolean;
  resultLimited: boolean;
  payloadsOmitted: number;
  metadataTruncated: number;
}

export interface BaseLogResult {
  available: boolean;
  coverage: LogCoverage;
  warnings: string[];
  nextCursor?: string;
}

export interface SearchLogsResult extends BaseLogResult {
  records: LogRecordView[];
}

export interface PublicationTrace {
  publicationId: string | null;
  actorUserId: string | null;
  recipientUserId: string | null;
  eventType: string | null;
  attempts: number;
  failedAttempts: number;
  providerAccepted: boolean;
  /** Backend traffic capture has no client receipt evidence. */
  clientReceiptObserved: false;
}

export interface TraceRequestResult extends SearchLogsResult {
  publications: PublicationTrace[];
  semantics: string;
}

export type FailureKind =
  | "http_4xx"
  | "http_5xx"
  | "http_aborted"
  | "realtime_failure"
  | "log_warning"
  | "log_error"
  | "operation_failure";

export interface ErrorGroup {
  kind: FailureKind;
  source: LogSource;
  category: string | null;
  name: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  eventType: string | null;
  count: number;
  firstTimestamp: string;
  lastTimestamp: string;
}

export interface ErrorSummaryResult extends BaseLogResult {
  /** Legacy union, including warning-only records. Prefer the explicit counters below. */
  totalFailures: number;
  warningRecords: number;
  errorRecords: number;
  failedOperations: number;
  warningOnlyRecords: number;
  totalErrorsAndFailedOperations: number;
  semantics: string;
  http4xx: number;
  http5xx: number;
  httpAborts: number;
  realtimeFailedAttempts: number;
  genericFailures: number;
  groups: ErrorGroup[];
  groupsOmitted: number;
}

export interface LogArchive {
  id: string;
  bytes: number;
  modifiedAt: string;
}

export interface ListLogArchivesResult {
  available: boolean;
  archives: LogArchive[];
  inspectedEntries: number;
  unsafeEntries: number;
  truncated: boolean;
  warnings: string[];
  semantics: string;
}
