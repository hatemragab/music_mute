export const WORKER_MACHINE_STATUSES = [
  "pending",
  "active",
  "paused",
  "draining",
  "revoked",
] as const;

export type WorkerMachineStatus = (typeof WORKER_MACHINE_STATUSES)[number];
export type WorkerPlatform = "darwin-arm64" | "windows-amd64";
export type WorkerProvider = "coreml" | "directml";

export interface WorkerCapability {
  platform: WorkerPlatform;
  provider: WorkerProvider;
  gpuId: string;
  recipeIds: string[];
  maxSlots: number;
}

export interface WorkerMachine {
  machineId: string;
  status: WorkerMachineStatus;
  label: string;
  groupId: string | null;
  policyRevision: number;
  appliedRevision: number;
  desiredRevision: number;
  capabilities: WorkerCapability[];
  hardware: {
    os: string;
    osBuild: string;
    architecture: string;
    cpu: string;
    memoryBytes: number;
    gpus: Array<{
      id: string;
      name: string;
      driverVersion: string;
      memoryBytes: number | null;
    }>;
  } | null;
  runtime: {
    workerVersion: string;
    protocolVersion: number;
    manifestDigest: string;
    modelDigest: string;
    providerRuntimeVersion: string;
  } | null;
  session: {
    sessionId: string;
    incarnation: string;
    generation: number;
    startedAt: string;
    lastSeenAt: string;
  } | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  currentAttempt?: WorkerAttemptSummary | null;
  recentError?: {
    attemptId: string;
    code: string | null;
    summary: string | null;
    at: string;
  } | null;
}

export interface WorkerAttemptSummary {
  attemptId: string;
  jobId: string;
  state: string;
  stage: string;
  startedAt?: string;
  workerId?: string;
  attemptNumber?: number;
  leaseExpiresAt?: string;
  deadlineAt?: string;
  terminalCode?: string | null;
  terminalSummary?: string | null;
  finishedAt?: string | null;
}

export interface WorkerMachinePage {
  items: WorkerMachine[];
  nextCursor: string | null;
  asOf: string;
}

export interface WorkerSlot {
  _id: string;
  gpuId: string;
  slotIndex: number;
  state: string;
  allowedRecipeIds: string[];
  currentAttemptId: string | null;
  lastSeenAt: string | null;
  revision: number;
}

export interface WorkerCommand {
  commandId: string;
  kind: "doctor" | "benchmark";
  state: "pending" | "succeeded" | "failed";
  checks: string[];
  recipeId: string | null;
  iterations: number | null;
  requestedAt: string;
  expiresAt: string;
  summary: string | null;
  metrics: Array<{ name: string; value: number; unit: string }>;
  completedAt: string | null;
  revision: number;
}

export interface WorkerMachineDetail {
  machine: WorkerMachine;
  slots: WorkerSlot[];
  attempts: WorkerAttemptSummary[];
  diagnostics: Array<{
    id: string;
    kind: string;
    sequenceStart: number;
    sequenceEnd: number;
    lineCount: number;
    metricCount: number;
    createdAt: string;
  }>;
  installation: {
    id: string;
    phase: string;
    outcomeCode: string | null;
    reportSummary: string | null;
    activatedAt: string | null;
  } | null;
  commands: WorkerCommand[];
}

export interface WorkerDiagnosticPage {
  items: Array<{
    id: string;
    kind: string;
    sequenceStart: number;
    sequenceEnd: number;
    lines: string[];
    metrics: Array<{ name: string; value: number; unit: string }>;
    createdAt: string;
  }>;
}

export interface WorkerInvitation {
  invitationId: string;
  state: "active" | "consumed" | "expired" | "revoked";
  createdByUid: string;
  initialPolicyId: string | null;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  installationSessionId: string | null;
  installation: {
    phase: string;
    outcomeCode: string | null;
    reportSummary: string | null;
    lastSeenAt: string | null;
    machineId: string | null;
    activatedAt: string | null;
    updatedAt: string;
  } | null;
  revision: number;
}

export interface WorkerInvitationPage {
  items: WorkerInvitation[];
  asOf: string;
}

export interface WorkerFleetPolicy {
  revision: number;
  acceptClaims: boolean;
  recipes: Array<{
    recipeId: string;
    enabled: boolean;
    maxSlotsPerMachine: number;
  }>;
  leaseSeconds: number;
  processingDeadlineSeconds: number;
  maxAttempts: number;
  updatedAt: string;
}

export interface WorkerInvitationCredential {
  invitationId: string;
  revision: number;
  credential: string | null;
  expiresAt: string | null;
  replayed: boolean;
}
