export const DIAGNOSTIC_SUBSYSTEMS = [
  "setup",
  "runtime",
  "account",
  "library",
  "chrome",
  "worker",
  "update",
  "lifecycle",
  "personal",
  "player",
] as const;
export type DiagnosticSubsystem = (typeof DIAGNOSTIC_SUBSYSTEMS)[number];
export interface WindowsDiagnosticIdentity {
  softwareVersion: string;
  runtimeScope: "packaged-app" | "development";
  expectedModelSha256: string;
  packageInventorySha256?: string;
}
export interface WindowsDiagnosticEvent {
  version: 1;
  session: string;
  sequence: number;
  at: string;
  identity: WindowsDiagnosticIdentity;
  subsystem: DiagnosticSubsystem;
  event:
    | "started"
    | "progress"
    | "completed"
    | "failed"
    | "cancelled"
    | "resource_sample"
    | "ui_error"
    | "recovered"
    | "diagnostic_rejected";
  severity: "info" | "warning" | "error";
  code: string;
  phase: string | null;
  metrics: Record<string, number | boolean>;
  job: string | null;
  rejectedFields: number;
  verifiedModelSha256?: string;
}
export interface WindowsDiagnosticJob {
  job: string;
  state: "active" | "ready" | "failed" | "cancelled";
  firstAt: string;
  lastAt: string;
  stagesMilliseconds: Record<string, number>;
  peaks: Record<string, number>;
  codes: string[];
  warnings: number;
  incomplete: boolean;
}
export interface WindowsDiagnosticReport {
  version: 1;
  createdAt: string;
  privacy: "local-only-no-media-credentials-urls-paths-account-identifiers";
  availability: "available" | "no-logs" | "unavailable" | "closed";
  failureCode: string | null;
  identity: WindowsDiagnosticIdentity;
  coverage: {
    firstSequence: number | null;
    lastSequence: number | null;
    malformedRecords: number;
    recoveredTailBytes: number;
    rejectedFields: number;
    failedWrites: number;
    retainedBytes: number;
    maxLogBytes: number;
    incompleteHistory: boolean;
    truncated: boolean;
    readOnly: true;
    observationsAreNotLeakOrAudioQualityProof: true;
    unmeasured: string[];
  };
  counts: Record<string, number>;
  peaks: Record<string, number>;
  jobs: WindowsDiagnosticJob[];
  recentErrors: WindowsDiagnosticEvent[];
  recentWarnings: WindowsDiagnosticEvent[];
  recentEvents: WindowsDiagnosticEvent[];
}
export interface WindowsDiagnosticCheck {
  name:
    | "signed-runtime"
    | "native-host"
    | "physical-gpu"
    | "python-lock"
    | "engine-protocol"
    | "media-tools"
    | "model-bytes"
    | "live-inference";
  status: "passed" | "failed" | "warning" | "not-run";
  code: string;
}
export interface WindowsDiagnosticDoctor {
  version: 1;
  checks: WindowsDiagnosticCheck[];
  healthy: boolean;
  inferencePerformed: false;
  networkRequests: 0;
  gpuCount: number;
  directmlAvailable: boolean;
  expectedModelSha256: string;
  verifiedModelSha256: string | null;
}
export type WindowsDiagnosticsCommand =
  | { type: "INSPECT" }
  | { type: "DOCTOR"; full?: boolean }
  | { type: "COPY" }
  | { type: "EXPORT"; destinationCapability: string }
  | { type: "REVEAL_LOGS" }
  | { type: "SHOW_REPORT" }
  | { type: "CLEAR" }
  | { type: "CANCEL" };
export interface WindowsDiagnosticsView {
  busy: boolean;
  report: WindowsDiagnosticReport | null;
  doctor: WindowsDiagnosticDoctor | null;
  exportReceipt: string | null;
  problem: string | null;
}
export const DIAGNOSTIC_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function parseWindowsDiagnosticsCommand(
  value: unknown,
): WindowsDiagnosticsCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DIAGNOSTICS_REQUEST_INVALID");
  const row = value as Record<string, unknown>;
  if (
    row.type === "DOCTOR" &&
    Object.keys(row).every((k) => ["type", "full"].includes(k)) &&
    (row.full === undefined || typeof row.full === "boolean")
  )
    return {
      type: "DOCTOR",
      ...(row.full === undefined ? {} : { full: row.full }),
    };
  if (
    row.type === "EXPORT" &&
    Object.keys(row).sort().join() === "destinationCapability,type" &&
    typeof row.destinationCapability === "string" &&
    DIAGNOSTIC_UUID.test(row.destinationCapability)
  )
    return { type: "EXPORT", destinationCapability: row.destinationCapability };
  if (
    Object.keys(row).join() === "type" &&
    [
      "INSPECT",
      "COPY",
      "REVEAL_LOGS",
      "SHOW_REPORT",
      "CLEAR",
      "CANCEL",
    ].includes(String(row.type))
  )
    return { type: row.type } as WindowsDiagnosticsCommand;
  throw new Error("DIAGNOSTICS_REQUEST_INVALID");
}
