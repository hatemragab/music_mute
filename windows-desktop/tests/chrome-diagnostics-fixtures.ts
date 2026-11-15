import { randomUUID } from "node:crypto";
import {
  diagnosticReport,
  parseDiagnosticRecord,
} from "../src/main/diagnostics/projection.js";
import type { WindowsDiagnosticEvent } from "../src/shared/diagnostics-contracts.js";
import { diagnosticIdentity } from "./diagnostics-fixtures.js";
export function chromeReport(events: WindowsDiagnosticEvent[] = []) {
  return diagnosticReport({
    events,
    identity: diagnosticIdentity,
    now: 1700000000000,
    availability: events.length ? "available" : "no-logs",
    failureCode: null,
    malformed: 0,
    recovered: 0,
    rejected: 0,
    failedWrites: 0,
    retained: 0,
    maximum: 1048576,
    incomplete: false,
    full: true,
  });
}
export function chromeEvent(
  sequence: number,
  severity: "info" | "warning" | "error" = "info",
  version = "0.1.0",
) {
  return parseDiagnosticRecord({
    version: 1,
    session: randomUUID(),
    sequence,
    at: new Date(1700000000000 + sequence).toISOString(),
    identity: { ...diagnosticIdentity, softwareVersion: version },
    subsystem: "runtime",
    event: "resource_sample",
    severity,
    code: severity === "info" ? "OK" : "GPU_UNAVAILABLE",
    phase: null,
    job: null,
    metrics: { rss_bytes: 10000 + sequence },
    rejectedFields: 0,
  });
}
