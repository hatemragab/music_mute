/* eslint-disable no-control-regex -- Security boundaries deliberately reject control characters. */
import { redact } from "./redact.js";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  errorSummaryInputSchema,
  searchLogsInputSchema,
  traceRequestInputSchema,
  traceEventsInputSchema,
} from "./schemas.js";
import type {
  ErrorGroup,
  ErrorSummaryInput,
  ErrorSummaryResult,
  FailureKind,
  LogCoverage,
  LogFilters,
  LogRecordView,
  ListLogArchivesResult,
  PublicationTrace,
  SearchLogsInput,
  SearchLogsResult,
  TraceEventsInput,
  TraceEventsResult,
  TraceRequestInput,
  TraceRequestResult,
} from "./types.js";

const MiB = 1024 * 1024;
const levels = new Set(["debug", "info", "warn", "error"]);
const sources = new Set([
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
]);
const isoDate =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const payloadKeys = [
  "path",
  "params",
  "query",
  "requestHeaders",
  "requestBody",
  "responseHeaders",
  "responseBody",
  "data",
] as const;
const filterKeys = [
  "operationId",
  "operation",
  "result",
  "service",
  "jobId",
  "importId",
  "workerId",

  "source",
  "instanceId",
  "captureId",
  "category",
  "name",
  "phase",
  "traceId",
  "roomId",
  "sessionGeneration",
  "metricName",
  "metricGroup",
  "sourceEventCode",
  "timestampSource",
  "query",
  "requestId",
  "userId",
  "recipientUserId",
  "event",
  "eventType",
  "method",
  "route",
  "level",
  "status",
  "from",
  "to",
] as const;
// Keep logical retry identities distinct even when their displayed metadata is bounded.
const publicationIdentities = new WeakMap<LogRecordView, string>();

type RawRecord = Record<string, unknown>;
type Operation = "s" | "t" | "e" | "c";
type CursorData = [
  1,
  Operation,
  string,
  string,
  number,
  string,
  number,
  string,
];
interface Snapshot {
  dev: string;
  ino: string;
  size: number;
  anchor: string;
  before: number;
}
interface ScanResult {
  available: boolean;
  coverage: LogCoverage;
  warnings: string[];
  nextCursor?: string;
}

export class LogStoreError extends Error {
  constructor(
    public readonly code:
      "INVALID_ARGUMENT" | "INVALID_CURSOR" | "CAPTURE_UNAVAILABLE",
  ) {
    super(
      code === "INVALID_ARGUMENT"
        ? "Invalid backend log query."
        : code === "INVALID_CURSOR"
          ? "Log cursor is invalid or its capture snapshot changed. Repeat the query without a cursor."
          : "Backend log capture cannot be read safely.",
    );
    this.name = "LogStoreError";
  }
}

export interface BackendLogStoreOptions {
  maxScanBytes?: number;
  maxRecordBytes?: number;
  maxResultBytes?: number;
}

function isHttpRecord(record: RawRecord): boolean {
  return [
    "http_request",
    "http.request",
    "http.response",
    "http.failure",
    "http.completed",
  ].includes(String(record.event));
}

function utcTimestamp(value: string): string {
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "000";
  return new Date(value).toISOString().slice(0, 19) + "." + fraction + "Z";
}
function timestampOrder(value: string): string {
  const canonical = utcTimestamp(value);
  return canonical.replace(
    /\.(\d+)Z$/,
    (_, fraction: string) => "." + fraction.padEnd(9, "0") + "Z",
  );
}

function emptyCoverage(): LogCoverage {
  return {
    snapshotBytes: 0,
    scannedFromByte: 0,
    scannedToByte: 0,
    readBytes: 0,
    scannedRecords: 0,
    malformedLines: 0,
    invalidRecords: 0,
    oversizedLines: 0,
    incompleteTrailingLine: false,
    skippedBoundaryBytes: 0,
    olderRecordsAvailable: false,
    partial: false,
    resultLimited: false,
    payloadsOmitted: 0,
    metadataTruncated: 0,
  };
}

function validate(
  input: unknown,
  operation: Operation,
): asserts input is SearchLogsInput {
  const schema =
    operation === "s"
      ? searchLogsInputSchema
      : operation === "t"
        ? traceRequestInputSchema
        : operation === "c"
          ? traceEventsInputSchema
          : errorSummaryInputSchema;
  if (!schema.safeParse(input).success)
    throw new LogStoreError("INVALID_ARGUMENT");
}

function queryHash(
  args:
    SearchLogsInput | TraceRequestInput | TraceEventsInput | ErrorSummaryInput,
): string {
  const data = Object.fromEntries(
    [...filterKeys, "limit", "includePayloads", "archive"].map((key) => [
      key,
      (args as RawRecord)[key],
    ]),
  );
  return createHash("sha256").update(JSON.stringify(data)).digest("base64url");
}

function isRecord(value: unknown): value is RawRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as RawRecord;
  return (
    sources.has(row.source as string) &&
    typeof row.event === "string" &&
    row.event.length > 0 &&
    row.event.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(row.event) &&
    levels.has(row.level as string) &&
    typeof row.timestamp === "string" &&
    isoDate.test(row.timestamp) &&
    Number.isFinite(Date.parse(row.timestamp)) &&
    (row.requestId === null || typeof row.requestId === "string") &&
    (row.userId === null || typeof row.userId === "string")
  );
}

function matches(
  record: RawRecord,
  args: LogFilters,
  rawLine: Buffer,
): boolean {
  for (const key of filterKeys) {
    if (key === "query" || key === "from" || key === "to") continue;
    if (args[key] !== undefined && record[key] !== args[key]) return false;
  }
  const time = Date.parse(record.timestamp as string);
  if (args.from !== undefined && time < Date.parse(args.from)) return false;
  if (args.to !== undefined && time > Date.parse(args.to)) return false;
  return (
    args.query === undefined ||
    rawLine.toString("utf8").toLowerCase().includes(args.query.toLowerCase())
  );
}

/** The configured capture is already redacted by the backend producer. */
function project(
  row: RawRecord,
  includePayloads: boolean,
  remainingBytes: number,
): LogRecordView {
  const originalPayloadBytes = Buffer.byteLength(
    JSON.stringify(
      Object.fromEntries(
        payloadKeys
          .filter((key) => Object.hasOwn(row, key))
          .map((key) => [key, row[key]]),
      ),
    ),
  );
  row = redact(row) as RawRecord;
  let truncated = false;
  const text = (key: string, max = 128): string | undefined => {
    const value = row[key];
    if (typeof value !== "string") return undefined;
    const encodedBytes = (part: string) =>
      Buffer.byteLength(JSON.stringify(part)) - 2;
    if (value.length <= max && encodedBytes(value) <= max) return value;
    truncated = true;
    // Bound JSON escaping as well as UTF8, and never split a surrogate pair.
    let low = 0,
      high = Math.min(value.length, max);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encodedBytes(value.slice(0, middle)) <= max - 3) low = middle;
      else high = middle - 1;
    }
    const lastCode = value.charCodeAt(low - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) low--;
    return `${value.slice(0, low)}…`;
  };
  const result: LogRecordView = {
    timestamp: utcTimestamp(row.timestamp as string),
    level: row.level as LogRecordView["level"],
    event: row.event as string,
    source: row.source as LogRecordView["source"],
    requestId: text("requestId") ?? null,
    userId: text("userId") ?? null,
  };
  for (const key of [
    "actorUserId",
    "recipientUserId",
    "publicationId",
  ] as const) {
    if (row[key] === null || typeof row[key] === "string")
      result[key] = text(key) ?? null;
  }
  for (const key of [
    "method",
    "route",
    "eventType",
    "channel",
    "result",
    "instanceId",
    "captureId",
    "category",
    "name",
    "phase",
    "traceId",
    "spanId",
    "parentSpanId",
    "roomId",
    "origin",
    "component",
    "operation",
    "direction",
    "operationId",
    "summary",
    "service",
    "jobId",
    "importId",
    "workerId",
  ] as const) {
    const value = text(
      key,
      key === "route" ? 512 : key === "channel" ? 256 : 128,
    );
    if (value !== undefined) result[key] = value;
  }
  for (const key of [
    "status",
    "durationMs",
    "attempt",
    "pts",
    "sessionGeneration",
    "seq",
    "durationMicros",
  ] as const) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value))
      result[key] = value;
  }
  for (const key of ["sourceTimestamp", "receivedAt", "collectedAt"] as const) {
    const value = row[key];
    if (
      typeof value === "string" &&
      value.length <= 64 &&
      isoDate.test(value) &&
      Number.isFinite(Date.parse(value))
    )
      result[key] = utcTimestamp(value);
  }
  if (row.timestampSource === "service" || row.timestampSource === "collection")
    result.timestampSource = row.timestampSource;
  if (
    typeof row.sourceEventCode === "string" &&
    /^\d{1,32}$/.test(row.sourceEventCode)
  )
    result.sourceEventCode = row.sourceEventCode;
  if (
    row.source === "web-client" &&
    row.event === "client_inspector" &&
    row.category === "inspector"
  ) {
    const safeMetric = (value: unknown): value is string =>
      typeof value === "string" &&
      /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value);
    if (
      safeMetric(row.metricName) &&
      typeof row.metricValue === "number" &&
      Number.isFinite(row.metricValue)
    ) {
      result.metricName = row.metricName;
      result.metricValue = row.metricValue;
      if (safeMetric(row.metricGroup)) result.metricGroup = row.metricGroup;
    }
  }
  if (row.payloadOmitted === true) {
    result.payloadOmitted = true;
    if (row.omissionReason === "record_byte_limit")
      result.omissionReason = "record_byte_limit";
    if (
      Number.isSafeInteger(row.omittedBytes) &&
      (row.omittedBytes as number) >= 0
    )
      result.omittedBytes = row.omittedBytes as number;
  }
  if (row.status === null) result.status = null;
  if (typeof row.aborted === "boolean") result.aborted = row.aborted;
  if (truncated) result.metadataTruncated = true;
  if (isBackendPublication(result) && typeof row.publicationId === "string") {
    publicationIdentities.set(
      result,
      createHash("sha256")
        .update(
          JSON.stringify([
            row.instanceId ?? null,
            row.captureId ?? null,
            row.publicationId,
          ]),
        )
        .digest("base64url"),
    );
  }
  if (!includePayloads && payloadKeys.some((key) => Object.hasOwn(row, key)))
    result.payloadOmitted = true;
  if (includePayloads) {
    const payload = Object.fromEntries(
      payloadKeys
        .filter((key) => Object.hasOwn(row, key))
        .map((key) => [key, row[key]]),
    );
    if (Object.keys(payload).length > 0) {
      result.payload = payload;
      try {
        if (
          originalPayloadBytes > remainingBytes ||
          Buffer.byteLength(JSON.stringify(result)) > remainingBytes
        ) {
          delete result.payload;
          result.payloadOmitted = true;
        }
      } catch {
        delete result.payload;
        result.payloadOmitted = true;
      }
    }
  }
  return result;
}

function isBackendPublication(record: RawRecord | LogRecordView): boolean {
  return (
    record.source === "backend" &&
    record.event === "realtime_publication" &&
    (record.direction === undefined || record.direction === "publish")
  );
}

function publicationGroups(records: LogRecordView[]): PublicationTrace[] {
  const groups = new Map<string, PublicationTrace>();
  records.forEach((record, index) => {
    if (!isBackendPublication(record)) return;
    // Missing publication IDs cannot safely be merged into a logical retry group.
    const key =
      publicationIdentities.get(record) ??
      record.publicationId ??
      `missing:${index}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        publicationId: record.publicationId ?? null,
        actorUserId: record.actorUserId ?? record.userId,
        recipientUserId: record.recipientUserId ?? null,
        eventType: record.eventType ?? null,
        attempts: 0,
        failedAttempts: 0,
        providerAccepted: false,
        clientReceiptObserved: false,
      };
      groups.set(key, group);
    }
    group.attempts++;
    if (record.result === "failure") group.failedAttempts++;
    if (record.result === "success") group.providerAccepted = true;
  });
  return [...groups.values()];
}

export class BackendLogStore {
  private readonly file: string;
  private readonly cursorKey = randomBytes(32);
  private readonly archiveStores = new Map<string, BackendLogStore>();
  private readonly maxScanBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxResultBytes: number;

  constructor(file: string, options: BackendLogStoreOptions = {}) {
    this.file = resolve(file);
    const bound = (
      value: number | undefined,
      fallback: number,
      min: number,
      max: number,
    ): number => {
      if (value === undefined) return fallback;
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new LogStoreError("INVALID_ARGUMENT");
      return value;
    };
    this.maxScanBytes = bound(options.maxScanBytes, 32 * MiB, 1, 32 * MiB);
    this.maxRecordBytes = bound(options.maxRecordBytes, MiB, 1, 4 * MiB);
    this.maxResultBytes = bound(options.maxResultBytes, 256 * 1024, 8192, MiB);
  }

  private isArchiveId(id: string): boolean {
    const stem = basename(this.file, ".jsonl").replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    return new RegExp(`^${stem}\\.\\d{8}T\\d{9}Z-[a-f0-9]{8}\\.jsonl$`).test(
      id,
    );
  }

  private archiveStore(id: string): BackendLogStore {
    if (!this.isArchiveId(id)) throw new LogStoreError("INVALID_ARGUMENT");
    let store = this.archiveStores.get(id);
    if (!store) {
      if (this.archiveStores.size >= 128)
        this.archiveStores.delete(this.archiveStores.keys().next().value!);
      store = new BackendLogStore(join(dirname(this.file), "archives", id), {
        maxScanBytes: this.maxScanBytes,
        maxRecordBytes: this.maxRecordBytes,
        maxResultBytes: this.maxResultBytes,
      });
      this.archiveStores.set(id, store);
    }
    return store;
  }

  /** Discover only bounded, fixed-name siblings; never accept tool-provided paths. */
  async listLogArchives(): Promise<ListLogArchivesResult> {
    const result: ListLogArchivesResult = {
      available: false,
      archives: [],
      inspectedEntries: 0,
      unsafeEntries: 0,
      truncated: false,
      warnings: [],
      semantics:
        "Archives are separate immutable captures, listed newest filename first. Pass an exact id as archive to a query. Live and archive queries never combine ranges; inspect every selected capture and coverage independently. Retention can remove archives after listing. At most 1024 directory entries and 128 archives are inspected/returned.",
    };
    const directory = join(dirname(this.file), "archives");
    const checkDirectory = async () => {
      let current = parse(directory).root;
      for (const part of relative(current, directory)
        .split(sep)
        .filter(Boolean)) {
        current = join(current, part);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new LogStoreError("CAPTURE_UNAVAILABLE");
      }
      return lstat(directory);
    };
    try {
      const before = await checkDirectory();
      const entries = await opendir(directory);
      result.available = true;
      for await (const entry of entries) {
        result.inspectedEntries++;
        if (result.inspectedEntries > 1024) {
          result.inspectedEntries = 1024;
          result.truncated = true;
          break;
        }
        if (!this.isArchiveId(entry.name)) continue;
        // Listing must not evict stores holding an active query cursor.
        const store = new BackendLogStore(join(directory, entry.name));
        let file: FileHandle | undefined;
        try {
          file = await store.safeOpen();
          if (!file) continue; // a concurrent retention prune
          const info = await file.stat();
          if (!Number.isSafeInteger(info.size) || info.size < 0)
            throw new Error();
          result.archives.push({
            id: entry.name,
            bytes: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        } catch {
          result.unsafeEntries++;
        } finally {
          await file?.close().catch(() => undefined);
        }
      }
      const after = await checkDirectory();
      if (before.ino !== after.ino || before.dev !== after.dev)
        throw new LogStoreError("CAPTURE_UNAVAILABLE");
      result.archives.sort((a, b) => b.id.localeCompare(a.id));
      if (result.archives.length > 128) {
        result.archives.length = 128;
        result.truncated = true;
      }
      if (result.truncated)
        result.warnings.push(
          "Archive discovery reached its directory or result limit; this is not a complete archive inventory.",
        );
      if (result.unsafeEntries)
        result.warnings.push("Unsafe archive candidates were excluded.");
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        result.warnings.push(
          "Archive directory is unavailable; this reader never creates it.",
        );
        return result;
      }
      throw new LogStoreError("CAPTURE_UNAVAILABLE");
    }
  }

  async searchLogs(args: SearchLogsInput = {}): Promise<SearchLogsResult> {
    validate(args, "s");
    if (args.archive !== undefined)
      return this.archiveStore(args.archive).searchLogs({
        ...args,
        archive: undefined,
      });
    return this.recordQuery(args, "s");
  }

  async traceRequest(args: TraceRequestInput): Promise<TraceRequestResult> {
    validate(args, "t");
    if (args.archive !== undefined)
      return this.archiveStore(args.archive).traceRequest({
        ...args,
        archive: undefined,
      });
    const result = await this.recordQuery(args, "t");
    // Capture order is a stable tie breaker for identical timestamps.
    result.records.reverse();
    result.records.sort((a, b) =>
      timestampOrder(a.timestamp).localeCompare(timestampOrder(b.timestamp)),
    );
    return {
      ...result,
      publications: publicationGroups(result.records),
      semantics:
        "Provider acceptance is not client receipt. Trace includes only this scanned capture range; follow nextCursor for older records. Unlinked client reception records do not establish receipt of a backend publication.",
    };
  }

  async traceEvents(args: TraceEventsInput): Promise<TraceEventsResult> {
    validate(args, "c");
    if (args.archive !== undefined)
      return this.archiveStore(args.archive).traceEvents({
        ...args,
        archive: undefined,
      });
    const result = await this.recordQuery(args, "c");
    result.records.reverse();
    result.records.sort((a, b) =>
      timestampOrder(a.timestamp).localeCompare(timestampOrder(b.timestamp)),
    );
    return {
      ...result,
      semantics:
        "Events match only the explicit source, instance and trace identifiers, plus optional exact filters. A local trace ID is not a cross-service request ID. No associations or client delivery are inferred; inspect coverage and paginate for older records.",
    };
  }

  async errorSummary(
    args: ErrorSummaryInput = {},
  ): Promise<ErrorSummaryResult> {
    validate(args, "e");
    if (args.archive !== undefined)
      return this.archiveStore(args.archive).errorSummary({
        ...args,
        archive: undefined,
      });
    const groups = new Map<string, ErrorGroup>();
    let totalFailures = 0,
      http4xx = 0,
      http5xx = 0,
      httpAborts = 0,
      realtimeFailedAttempts = 0,
      genericFailures = 0,
      groupsOmitted = 0,
      warningRecords = 0,
      errorRecords = 0,
      failedOperations = 0,
      warningOnlyRecords = 0,
      totalErrorsAndFailedOperations = 0;
    const limit = args.limit ?? 20;
    // Bounded groups are gathered in recent-first capture order; totals always cover the full scanned range.
    const scan = await this.scan(args, "e", (record, _line, coverage) => {
      if (!matches(record, args, Buffer.alloc(0))) return true;
      const failedOperation = isHttpRecord(record)
        ? record.result === "failure" ||
          record.result === "failed" ||
          record.result === "aborted" ||
          record.aborted === true ||
          (typeof record.status === "number" &&
            record.status >= 400 &&
            record.status <= 599)
        : isBackendPublication(record)
          ? record.result === "failure"
          : record.result === "failure" || record.result === "failed";
      if (record.level === "warn") warningRecords++;
      if (record.level === "error") errorRecords++;
      if (failedOperation) failedOperations++;
      if (record.level === "warn" && !failedOperation) warningOnlyRecords++;
      if (record.level === "error" || failedOperation)
        totalErrorsAndFailedOperations++;
      let kind: FailureKind | undefined;
      if (isHttpRecord(record)) {
        if (
          typeof record.status === "number" &&
          record.status >= 400 &&
          record.status <= 499
        )
          http4xx++;
        if (
          typeof record.status === "number" &&
          record.status >= 500 &&
          record.status <= 599
        )
          http5xx++;
        if (
          record.aborted === true ||
          record.result === "aborted" ||
          record.phase === "aborted"
        ) {
          httpAborts++;
          kind = "http_aborted";
        } else if (
          typeof record.status === "number" &&
          record.status >= 500 &&
          record.status <= 599
        )
          kind = "http_5xx";
        else if (
          typeof record.status === "number" &&
          record.status >= 400 &&
          record.status <= 499
        )
          kind = "http_4xx";
      } else if (isBackendPublication(record) && record.result === "failure") {
        realtimeFailedAttempts++;
        kind = "realtime_failure";
      }
      if (
        kind === undefined &&
        !isHttpRecord(record) &&
        !isBackendPublication(record)
      ) {
        if (record.level === "error") kind = "log_error";
        else if (record.level === "warn") kind = "log_warning";
        else if (record.result === "failure" || record.result === "failed")
          kind = "operation_failure";
        if (kind !== undefined) genericFailures++;
      }
      if (kind === undefined) return true;
      totalFailures++;
      const view = project(record, false, 0);
      if (view.metadataTruncated) coverage.metadataTruncated++;
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            kind,
            record.source,
            record.category ?? null,
            record.name ?? null,
            typeof record.method === "string" ? record.method : null,
            typeof record.route === "string" ? record.route : null,
            view.status,
            typeof record.eventType === "string" ? record.eventType : null,
          ]),
        )
        .digest("base64url");
      const timestamp = view.timestamp;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        if (timestamp < existing.firstTimestamp)
          existing.firstTimestamp = timestamp;
        if (timestamp > existing.lastTimestamp)
          existing.lastTimestamp = timestamp;
      } else if (groups.size < limit) {
        groups.set(key, {
          kind,
          source: view.source,
          category: view.category ?? null,
          name: view.name ?? null,
          method: view.method ?? null,
          route: view.route ?? null,
          status: view.status ?? null,
          eventType: view.eventType ?? null,
          count: 1,
          firstTimestamp: timestamp,
          lastTimestamp: timestamp,
        });
      } else groupsOmitted++;
      return true;
    });
    const output = {
      ...scan,
      totalFailures,
      warningRecords,
      errorRecords,
      failedOperations,
      warningOnlyRecords,
      totalErrorsAndFailedOperations,
      semantics:
        "warningRecords and errorRecords count severity; failedOperations counts HTTP 4xx/5xx/aborts, failed backend publication attempts and explicit failed generic operations. totalErrorsAndFailedOperations is their deduplicated error-or-failure union. warningOnlyRecords excludes failed operations. Legacy totalFailures/genericFailures include generic warning-only records and retain their original semantics. All counters cover this scanned range only; they can overlap and must not be added together.",
      http4xx,
      http5xx,
      httpAborts,
      realtimeFailedAttempts,
      genericFailures,
      groups: [...groups.values()].sort(
        (a, b) =>
          b.count - a.count || b.lastTimestamp.localeCompare(a.lastTimestamp),
      ),
      groupsOmitted,
    };
    while (
      output.groups.length &&
      Buffer.byteLength(JSON.stringify(output)) > this.maxResultBytes - 512
    ) {
      output.groupsOmitted += output.groups.pop()!.count;
    }
    if (output.groupsOmitted > 0)
      output.warnings.push(
        "Some failures were omitted from returned groups by the group or result byte limit. Totals still describe the scanned range.",
      );
    return output;
  }

  private async recordQuery(
    args: SearchLogsInput | TraceRequestInput | TraceEventsInput,
    operation: "s" | "t" | "c",
  ): Promise<SearchLogsResult> {
    const records: LogRecordView[] = [];
    const limit = args.limit ?? 50;
    // Leave bounded room for coverage, warnings, cursor, and trace publication groups.
    const resultBudget =
      this.maxResultBytes - Math.min(4096, this.maxResultBytes / 2);
    let bytes = 0;
    const scan = await this.scan(
      args,
      operation,
      (record, rawLine, coverage) => {
        if (!matches(record, args, rawLine)) return true;
        const groupReserve =
          operation === "t" && isBackendPublication(record)
            ? Buffer.byteLength(
                JSON.stringify(publicationGroups([project(record, false, 0)])),
              ) + 16
            : 0;
        const view = project(
          record,
          args.includePayloads === true,
          resultBudget - bytes - groupReserve,
        );
        const size = Buffer.byteLength(JSON.stringify(view)) + groupReserve + 1;
        if (size > resultBudget - bytes) {
          // A future metadata extension must never produce an unchanged cursor loop.
          if (records.length === 0) {
            coverage.oversizedLines++;
            return true;
          }
          coverage.resultLimited = true;
          return "retry";
        }
        records.push(view);
        bytes += size;
        if (view.payloadOmitted) coverage.payloadsOmitted++;
        if (view.metadataTruncated) coverage.metadataTruncated++;
        if (records.length === limit) {
          coverage.resultLimited = true;
          return "stop";
        }
        return true;
      },
    );
    if ("source" in args && args.source && records.length === 0)
      scan.warnings.push(
        "No records from the selected source were observed in this scanned range; the source may be disconnected or outside coverage.",
      );
    return { ...scan, records };
  }

  private cursor(data: CursorData): string {
    const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
    const signature = createHmac("sha256", this.cursorKey)
      .update(encoded)
      .digest()
      .subarray(0, 16)
      .toString("base64url");
    return `${encoded}.${signature}`;
  }

  private decodeCursor(
    value: string,
    operation: Operation,
    hash: string,
  ): CursorData {
    try {
      const [encoded, signature] = value.split(".");
      if (!encoded || !signature) throw new Error();
      const expected = createHmac("sha256", this.cursorKey)
        .update(encoded)
        .digest()
        .subarray(0, 16);
      const actual = Buffer.from(signature, "base64url");
      if (
        actual.toString("base64url") !== signature ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const data: unknown = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      if (
        !Array.isArray(data) ||
        data.length !== 8 ||
        data[0] !== 1 ||
        data[1] !== operation ||
        typeof data[2] !== "string" ||
        typeof data[3] !== "string" ||
        !Number.isSafeInteger(data[4]) ||
        data[4] < 0 ||
        typeof data[5] !== "string" ||
        !Number.isSafeInteger(data[6]) ||
        data[6] <= 0 ||
        data[6] > data[4] ||
        data[7] !== hash
      )
        throw new Error();
      return data as CursorData;
    } catch {
      throw new LogStoreError("INVALID_CURSOR");
    }
  }

  private async safeOpen(): Promise<FileHandle | undefined> {
    const checkParents = async () => {
      const parent = dirname(this.file);
      let current = parse(parent).root;
      for (const part of relative(current, parent).split(sep).filter(Boolean)) {
        current = join(current, part);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new LogStoreError("CAPTURE_UNAVAILABLE");
      }
    };
    let file: FileHandle | undefined;
    try {
      await checkParents();
      const target = await lstat(this.file);
      if (
        !target.isFile() ||
        target.isSymbolicLink() ||
        target.nlink !== 1 ||
        (target.mode & 0o444) === 0
      )
        throw new LogStoreError("CAPTURE_UNAVAILABLE");
      file = await open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const actual = await file.stat();
      await checkParents();
      const after = await lstat(this.file);
      if (
        !actual.isFile() ||
        actual.nlink !== 1 ||
        actual.ino !== target.ino ||
        actual.dev !== target.dev ||
        after.ino !== actual.ino ||
        after.dev !== actual.dev ||
        after.isSymbolicLink()
      )
        throw new LogStoreError("CAPTURE_UNAVAILABLE");
      return file;
    } catch (error) {
      await file?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new LogStoreError("CAPTURE_UNAVAILABLE");
    }
  }

  private async read(
    file: FileHandle,
    start: number,
    length: number,
  ): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (bytesRead === 0) throw new LogStoreError("CAPTURE_UNAVAILABLE");
      offset += bytesRead;
    }
    return buffer;
  }

  private async anchor(file: FileHandle, size: number): Promise<string> {
    const length = Math.min(256, size);
    return createHash("sha256")
      .update(await this.read(file, 0, length))
      .update(await this.read(file, Math.max(0, size - length), length))
      .digest("base64url");
  }

  private async scan(
    args:
      | SearchLogsInput
      | TraceRequestInput
      | TraceEventsInput
      | ErrorSummaryInput,
    operation: Operation,
    consume: (
      row: RawRecord,
      line: Buffer,
      coverage: LogCoverage,
    ) => true | "stop" | "retry",
  ): Promise<ScanResult> {
    const hash = queryHash(args);
    const cursor =
      args.cursor === undefined
        ? undefined
        : this.decodeCursor(args.cursor, operation, hash);
    const file = await this.safeOpen();
    if (!file) {
      if (cursor) throw new LogStoreError("INVALID_CURSOR");
      return {
        available: false,
        coverage: emptyCoverage(),
        warnings: [
          "Local capture is not available yet. Start file capture separately; the MCP server never creates it.",
        ],
      };
    }
    try {
      const stat = await file.stat();
      if (!Number.isSafeInteger(stat.size))
        throw new LogStoreError("CAPTURE_UNAVAILABLE");
      const snapshot: Snapshot = {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: cursor?.[4] ?? stat.size,
        anchor: "",
        before: cursor?.[6] ?? stat.size,
      };
      if (
        cursor &&
        (cursor[2] !== snapshot.dev ||
          cursor[3] !== snapshot.ino ||
          stat.size < snapshot.size)
      )
        throw new LogStoreError("INVALID_CURSOR");
      snapshot.anchor = await this.anchor(file, snapshot.size);
      if (cursor && cursor[5] !== snapshot.anchor)
        throw new LogStoreError("INVALID_CURSOR");
      const coverage = emptyCoverage();
      coverage.snapshotBytes = snapshot.size;
      coverage.scannedToByte = snapshot.before;
      // Read backwards only as far as the result needs. A fifty-row query
      // usually consumes one 64 KiB block, rather than allocating/re-reading
      // the complete 32 MiB scan allowance for every cursor page.
      const floor = Math.max(0, snapshot.before - this.maxScanBytes);
      let position = snapshot.before;
      let block: Buffer = Buffer.alloc(0);
      let blockStart = position;
      let offset = -1;
      let before = snapshot.before;
      let recordEnd = snapshot.before;
      let parts: Buffer[] = [];
      let lineBytes = 0;
      let oversized = false;
      let initialized = false;
      let trailing = false;
      const add = (part: Buffer) => {
        lineBytes += part.length;
        if (lineBytes > this.maxRecordBytes) {
          oversized = true;
          parts = [];
        } else if (!oversized && part.length) parts.unshift(part);
      };
      const consumeLine = (lineStart: number): boolean => {
        before = lineStart;
        if (oversized) coverage.oversizedLines++;
        else if (lineBytes) {
          const line = Buffer.concat(parts, lineBytes);
          let row: unknown;
          try {
            row = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(line),
            );
          } catch {
            coverage.malformedLines++;
          }
          if (row !== undefined) {
            if (!isRecord(row)) coverage.invalidRecords++;
            else {
              coverage.scannedRecords++;
              const action = consume(row, line, coverage);
              if (action !== true) {
                if (action === "retry") {
                  before = recordEnd;
                  coverage.scannedRecords--;
                }
                return false;
              }
            }
          }
        }
        parts = [];
        lineBytes = 0;
        oversized = false;
        return true;
      };
      scanning: while (true) {
        if (offset < 0) {
          if (position === floor) {
            if (floor === 0) {
              if (trailing) {
                coverage.skippedBoundaryBytes += lineBytes;
                before = 0;
              } else consumeLine(0);
            } else {
              coverage.skippedBoundaryBytes += lineBytes;
              // Recover a leading fragment on the next cursor page. If one
              // enormous line fills the whole allowance, make bounded progress.
              if (before === snapshot.before) {
                before = floor;
                if (lineBytes) coverage.oversizedLines++;
              }
            }
            break;
          }
          const length = Math.min(64 * 1024, position - floor);
          blockStart = position - length;
          block = await this.read(file, blockStart, length);
          coverage.readBytes += length;
          position = blockStart;
          offset = block.length - 1;
          if (!initialized) {
            initialized = true;
            trailing = block[offset] !== 10;
            coverage.incompleteTrailingLine =
              snapshot.before === snapshot.size && trailing;
            if (!trailing) offset--;
          }
          if (offset < 0) continue;
        }
        const newline = block.lastIndexOf(10, offset);
        if (newline < 0) {
          add(block.subarray(0, offset + 1));
          offset = -1;
          continue;
        }
        add(block.subarray(newline + 1, offset + 1));
        const lineStart = blockStart + newline + 1;
        if (trailing) {
          coverage.skippedBoundaryBytes += lineBytes;
          parts = [];
          lineBytes = 0;
          oversized = false;
          trailing = false;
        } else if (!consumeLine(lineStart)) break scanning;
        recordEnd = lineStart;
        offset = newline - 1;
      }
      coverage.scannedFromByte = before;
      coverage.olderRecordsAvailable = before > 0;
      coverage.partial =
        before > 0 ||
        snapshot.before < snapshot.size ||
        coverage.malformedLines > 0 ||
        coverage.invalidRecords > 0 ||
        coverage.oversizedLines > 0 ||
        coverage.incompleteTrailingLine ||
        coverage.skippedBoundaryBytes > 0;
      const after = await file.stat();
      if (
        after.size < snapshot.size ||
        after.nlink !== 1 ||
        (await this.anchor(file, snapshot.size)) !== snapshot.anchor
      )
        throw new LogStoreError(
          cursor ? "INVALID_CURSOR" : "CAPTURE_UNAVAILABLE",
        );
      const warnings: string[] = [];
      if (coverage.partial)
        warnings.push(
          "Results describe only the reported capture byte range. Missing, incomplete, malformed, oversized, or older records can make this trace or summary partial.",
        );
      if (coverage.payloadsOmitted)
        warnings.push(
          "Payloads were excluded by default, omitted by producers, or exceeded byte limits; metadata is retained. Opt in with includePayloads for available bounded payloads.",
        );
      if (coverage.metadataTruncated)
        warnings.push("Oversized metadata fields were truncated.");
      const nextCursor =
        before > 0
          ? this.cursor([
              1,
              operation,
              snapshot.dev,
              snapshot.ino,
              snapshot.size,
              snapshot.anchor,
              before,
              hash,
            ])
          : undefined;
      return {
        available: true,
        coverage,
        warnings,
        ...(nextCursor ? { nextCursor } : {}),
      };
    } catch (error) {
      if (error instanceof LogStoreError) throw error;
      throw new LogStoreError("CAPTURE_UNAVAILABLE");
    } finally {
      await file.close().catch(() => undefined);
    }
  }
}
