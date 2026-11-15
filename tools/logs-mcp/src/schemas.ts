/* eslint-disable no-control-regex -- Security boundaries deliberately reject control characters. */
import * as z from "zod/v4";

const argumentError = "Invalid argument.";
const identifier = z
  .string({ error: argumentError })
  .min(1, { error: argumentError })
  .max(128, { error: argumentError })
  .regex(/^[^\u0000-\u001f\u007f]+$/, { error: argumentError });
const literal = (max: number) =>
  z
    .string({ error: argumentError })
    .min(1, { error: argumentError })
    .max(max, { error: argumentError })
    .regex(/^[^\u0000-\u001f\u007f]+$/, { error: argumentError });
const timestamp = z.iso.datetime({ offset: true, error: argumentError });
const cursor = z
  .string({ error: argumentError })
  .min(1, { error: argumentError })
  .max(512, { error: argumentError })
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, { error: argumentError })
  .describe("Opaque cursor from the preceding page; keep the same filters.");
const method = z.enum(
  [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "CONNECT",
    "TRACE",
  ],
  { error: argumentError },
);
const resultLimit = z
  .number({ error: argumentError })
  .int({ error: argumentError })
  .min(1, { error: argumentError })
  .max(200, { error: argumentError });
const timeRange = {
  from: timestamp
    .optional()
    .describe("Inclusive ISO 8601 time with a timezone."),
  to: timestamp.optional().describe("Inclusive ISO 8601 time with a timezone."),
};
const chronological = (value: { from?: string; to?: string }) =>
  value.from === undefined ||
  value.to === undefined ||
  Date.parse(value.from) <= Date.parse(value.to);

const source = z.enum(
  [
    "backend",
    "web-client",
    "dashboard",
    "landing-page",
    "chrome-extension",
    "macos",
    "worker",
    "windows-desktop",
    "ios",
    "android",
    "provider",
    "redis",
    "mongodb",
    "collector",
  ],
  { error: argumentError },
);
const archiveSelection = {
  archive: literal(160)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.\d{8}T\d{9}Z-[a-f0-9]{8}\.jsonl$/,
      { error: argumentError },
    )
    .optional()
    .describe(
      "Exact archive ID from list_log_archives; omitted reads the live capture. Paths are rejected.",
    ),
};
const sourceFilters = {
  operationId: identifier.optional(),
  operation: identifier.optional(),
  result: identifier.optional(),
  service: identifier.optional(),
  jobId: identifier.optional(),
  importId: identifier.optional(),
  workerId: identifier.optional(),

  metricName: literal(128).optional(),
  metricGroup: literal(128).optional(),
  sourceEventCode: literal(32).optional(),
  timestampSource: z
    .enum(["service", "collection"], { error: argumentError })
    .optional(),
  source: source.optional(),
  instanceId: identifier.optional(),
  captureId: identifier.optional(),
  category: literal(128).optional(),
  name: literal(128).optional(),
  phase: literal(128).optional(),
  traceId: identifier.optional(),
  roomId: identifier.optional(),
  sessionGeneration: z
    .number({ error: argumentError })
    .int({ error: argumentError })
    .min(0, { error: argumentError })
    .max(Number.MAX_SAFE_INTEGER, { error: argumentError })
    .optional(),
};

export const searchLogsInputSchema = z
  .strictObject(
    {
      ...sourceFilters,
      ...archiveSelection,
      query: literal(500)
        .optional()
        .describe(
          "Literal text search; regular expressions are not evaluated.",
        ),
      requestId: identifier.optional(),
      userId: identifier
        .optional()
        .describe("Causative actor/user identifier."),
      recipientUserId: identifier.optional(),
      event: literal(128).optional(),
      eventType: literal(96).optional(),
      method: method.optional(),
      route: literal(512).optional(),
      level: z
        .enum(["debug", "info", "warn", "error"], { error: argumentError })
        .optional(),
      status: z
        .number({ error: argumentError })
        .int({ error: argumentError })
        .min(100, { error: argumentError })
        .max(599, { error: argumentError })
        .optional(),
      ...timeRange,
      limit: resultLimit.optional(),
      cursor: cursor.optional(),
      includePayloads: z
        .boolean({ error: argumentError })
        .optional()
        .describe(
          "Opt in to bounded, redacted payloads; metadata only by default.",
        ),
    },
    { error: "Unsupported arguments." },
  )
  .refine(chronological, { error: "from must be no later than to." });

export const traceEventsInputSchema = z.strictObject(
  {
    ...sourceFilters,
    ...archiveSelection,
    source,
    instanceId: identifier,
    traceId: identifier,
    includePayloads: z.boolean({ error: argumentError }).optional(),
    limit: resultLimit.optional(),
    cursor: cursor.optional(),
  },
  { error: "Unsupported arguments." },
);

export const traceRequestInputSchema = z.strictObject(
  {
    ...sourceFilters,
    ...archiveSelection,
    requestId: identifier.describe("Exact request identifier to correlate."),
    includePayloads: z
      .boolean({ error: argumentError })
      .optional()
      .describe(
        "Opt in to bounded, redacted payloads; metadata only by default.",
      ),
    limit: resultLimit.optional(),
    cursor: cursor.optional(),
  },
  { error: "Unsupported arguments." },
);

export const errorSummaryInputSchema = z
  .strictObject(
    {
      ...timeRange,
      ...sourceFilters,
      ...archiveSelection,
      userId: identifier.optional(),
      recipientUserId: identifier.optional(),
      route: literal(512).optional(),
      method: method.optional(),
      limit: resultLimit.max(100, { error: argumentError }).optional(),
      cursor: cursor.optional(),
    },
    { error: "Unsupported arguments." },
  )
  .refine(chronological, { error: "from must be no later than to." });

const count = z.number().int().nonnegative();
const recordViewSchema = z.strictObject({
  operationId: z.string().optional(),
  summary: z.string().optional(),
  service: z.string().optional(),
  jobId: z.string().optional(),
  importId: z.string().optional(),
  workerId: z.string().optional(),

  timestamp: z.string(),
  sourceTimestamp: timestamp.optional(),
  receivedAt: timestamp.optional(),
  collectedAt: timestamp.optional(),
  timestampSource: z.enum(["service", "collection"]).optional(),
  sourceEventCode: z.string().optional(),
  metricName: z.string().optional(),
  metricGroup: z.string().optional(),
  metricValue: z.number().finite().optional(),
  source,
  instanceId: z.string().optional(),
  captureId: z.string().optional(),
  category: z.string().optional(),
  name: z.string().optional(),
  phase: z.string().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  sessionGeneration: z.number().optional(),
  roomId: z.string().optional(),
  seq: z.number().optional(),
  durationMicros: z.number().optional(),
  origin: z.string().optional(),
  component: z.string().optional(),
  operation: z.string().optional(),
  direction: z.string().optional(),
  level: z.enum(["debug", "info", "warn", "error"]),
  event: z.string(),
  requestId: z.string().nullable(),
  userId: z.string().nullable(),
  actorUserId: z.string().nullable().optional(),
  recipientUserId: z.string().nullable().optional(),
  method: z.string().optional(),
  route: z.string().optional(),
  status: z.number().nullable().optional(),
  durationMs: z.number().optional(),
  aborted: z.boolean().optional(),
  eventType: z.string().optional(),
  publicationId: z.string().nullable().optional(),
  channel: z.string().optional(),
  attempt: z.number().optional(),
  result: z.string().optional(),
  pts: z.number().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  payloadOmitted: z.boolean().optional(),
  omissionReason: z.literal("record_byte_limit").optional(),
  omittedBytes: z.number().int().nonnegative().optional(),
  metadataTruncated: z.boolean().optional(),
});

const coverageSchema = z.strictObject({
  snapshotBytes: count,
  scannedFromByte: count,
  scannedToByte: count,
  readBytes: count,
  scannedRecords: count,
  malformedLines: count,
  invalidRecords: count,
  oversizedLines: count,
  incompleteTrailingLine: z.boolean(),
  skippedBoundaryBytes: count,
  olderRecordsAvailable: z.boolean(),
  partial: z.boolean(),
  resultLimited: z.boolean(),
  payloadsOmitted: count,
  metadataTruncated: count,
});

const baseResultShape = {
  available: z.boolean(),
  coverage: coverageSchema,
  warnings: z.array(z.string()),
  nextCursor: cursor.optional(),
};

export const searchLogsOutputSchema = z.strictObject({
  ...baseResultShape,
  records: z.array(recordViewSchema).max(200),
});

export const traceEventsOutputSchema = z.strictObject({
  ...baseResultShape,
  records: z.array(recordViewSchema).max(200),
  semantics: z.string(),
});

export const traceRequestOutputSchema = z.strictObject({
  ...baseResultShape,
  records: z.array(recordViewSchema).max(200),
  publications: z
    .array(
      z.strictObject({
        publicationId: z.string().nullable(),
        actorUserId: z.string().nullable(),
        recipientUserId: z.string().nullable(),
        eventType: z.string().nullable(),
        attempts: count,
        failedAttempts: count,
        providerAccepted: z.boolean(),
        clientReceiptObserved: z.literal(false),
      }),
    )
    .max(200),
  semantics: z.string(),
});

export const errorSummaryOutputSchema = z.strictObject({
  ...baseResultShape,
  totalFailures: count,
  warningRecords: count,
  errorRecords: count,
  failedOperations: count,
  warningOnlyRecords: count,
  totalErrorsAndFailedOperations: count,
  semantics: z.string(),
  http4xx: count,
  http5xx: count,
  httpAborts: count,
  realtimeFailedAttempts: count,
  genericFailures: count,
  groups: z
    .array(
      z.strictObject({
        kind: z.enum([
          "http_4xx",
          "http_5xx",
          "http_aborted",
          "realtime_failure",
          "log_warning",
          "log_error",
          "operation_failure",
        ]),
        source,
        category: z.string().nullable(),
        name: z.string().nullable(),
        method: z.string().nullable(),
        route: z.string().nullable(),
        status: z.number().nullable(),
        eventType: z.string().nullable(),
        count,
        firstTimestamp: z.string(),
        lastTimestamp: z.string(),
      }),
    )
    .max(100),
  groupsOmitted: count,
});

export const listLogArchivesInputSchema = z.strictObject(
  {},
  { error: "Unsupported arguments." },
);
export const listLogArchivesOutputSchema = z.strictObject({
  available: z.boolean(),
  archives: z
    .array(
      z.strictObject({
        id: z.string(),
        bytes: count,
        modifiedAt: timestamp,
      }),
    )
    .max(128),
  inspectedEntries: count,
  unsafeEntries: count,
  truncated: z.boolean(),
  warnings: z.array(z.string()),
  semantics: z.string(),
});
