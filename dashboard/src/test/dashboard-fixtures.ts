import type {
  AdminRole,
  AdminSession,
  AccountRecoveryRequest,
  AccountRestriction,
  AbuseEvent,
  AlertRecord,
  AuditEvent,
  JobDetail,
  Permission,
  AccountPolicy,
  AccountPolicyOverride,
  AccountUsage,
  RevisionCommand,
  ReleaseDetail,
  UpdatePolicy,
  UserDetail,
} from "../api/contracts";
import { ROLE_DETAILS } from "../features/administrators/role-permissions";
import type {
  WorkerDiagnosticPage,
  WorkerFleetPolicy,
  WorkerInvitation,
  WorkerMachine,
  WorkerMachineDetail,
} from "../features/workers/worker-types";

const NOW = "2026-09-11T00:00:00.000Z";
export const FIXTURE_IDS = {
  job: "000000000000000000000001",
  user: "000000000000000000000010",
  release: "000000000000000000000020",
  publishedRelease: "000000000000000000000021",
  upload: "000000000000000000000030",
  alert: "000000000000000000000040",
  recovery: "000000000000000000000050",
  workerMachine: "5acc2df8-bf20-40ec-ab6f-b64a68cd4aec",
  workerInvitation: "7a155328-7d4f-4102-a99f-63ea3025935f",
  workerInstallation: "d32f392a-88de-4ce3-b1a3-e79890be1547",
  workerAttempt: "10e021b3-799d-48cc-b763-524db4953c3c",
  workerSlot: "4e8a5582-5e24-4fa5-8258-704f7cb2b6d5",
  workerDiagnostic: "b05af08e-03e4-42eb-a694-ed94405130c4",
} as const;

export interface FixtureRequest {
  method: string;
  url: string;
  token?: string | null;
  body?: unknown;
}

export interface FixtureResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const page = <T>(items: T[]) => ({ items, nextCursor: null, asOf: NOW });

const error = (
  status: number,
  code: string,
  message: string,
): FixtureResponse => ({
  status,
  body: { code, message, requestId: "fixture-request" },
});

const hasExactKeys = (value: unknown, keys: string[]): boolean =>
  Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(","),
  );

const hasOnlyKeys = (
  value: unknown,
  required: string[],
  optional: string[],
): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};

const validPolicySelection = (value: unknown): boolean => {
  if (!hasExactKeys(value, ["android", "ios"])) return false;
  const selection = value as Record<string, unknown>;
  return (
    hasExactKeys(selection.android, [
      "minimumBuild",
      "directReleaseId",
      "storeReleaseId",
      "source",
    ]) && hasExactKeys(selection.ios, ["minimumBuild", "storeReleaseId"])
  );
};

const permissionFor = (method: string, path: string): Permission | null => {
  if (path === "/admin/session") return null;
  if (path.startsWith("/admin/access")) return "admin.access.manage";
  if (path.startsWith("/admin/audit")) return "audit.read";
  if (path.startsWith("/admin/exports")) return "exports.read";
  if (path === "/admin/overview") return "overview.read";
  if (path === "/admin/health") return "health.read";
  if (path.startsWith("/admin/alerts"))
    return method === "GET" ? "health.read" : "alerts.manage";
  if (path.startsWith("/admin/settings"))
    return method === "GET" ? "settings.read" : "settings.manage";
  if (path.startsWith("/admin/releases") || path === "/admin/update-policy")
    return method === "GET" ? "releases.read" : "releases.manage";
  if (path.startsWith("/admin/jobs")) {
    if (method === "GET") return "jobs.read";
    if (path.endsWith("/media-grants")) return "media.read";
    return "jobs.manage";
  }
  if (path.startsWith("/admin/account-recovery-requests"))
    return "users.account-recovery.manage";
  if (path.startsWith("/admin/abuse-events")) return "abuse.read";
  if (path.endsWith("/restriction"))
    return method === "GET" ? "abuse.read" : "users.restrictions.manage";
  if (path.startsWith("/admin/users"))
    return method === "GET" ? "users.read" : "users.processing.manage";
  if (path.startsWith("/admin/worker-fleet/machines")) {
    if (path.endsWith("/diagnostics")) return "workers.logs.read";
    return method === "GET" ? "workers.read" : "workers.manage";
  }
  if (path === "/admin/worker-fleet/invitations") return "workers.enroll";
  if (path === "/admin/worker-fleet/policy")
    return method === "GET" ? "workers.read" : "workers.manage";
  if (path.startsWith("/admin/workers/invitations")) return "workers.enroll";
  if (path.startsWith("/admin/workers/machines")) return "workers.manage";
  return null;
};

export const sessionForRole = (role: AdminRole): AdminSession => ({
  uid: `${role}-fixture`,
  verifiedEmail: `${role}-fixture@example.invalid`,
  role,
  permissions: ROLE_DETAILS[role].permissions,
  accessRevision: 1,
  authTimeSec: 1_788_739_200,
  serverTime: NOW,
});

export class DashboardFixture {
  readonly requests: FixtureRequest[] = [];
  accountUsage: AccountUsage = {
    schemaVersion: 2,
    plan: "standard",
    policyRevision: 1,
    overrideRevision: null,
    effectivePolicySource: "global",
    overrideExpiresAt: null,
    period: {
      key: "2026-09",
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
      nextResetAt: "2026-10-01T00:00:00.000Z",
    },
    processing: {
      limitSeconds: 7_200,
      usedSeconds: 900,
      reservedSeconds: 600,
      releasedSeconds: 0,
      remainingSeconds: 5_700,
    },
    uploads: {
      dailyGrantLimit: 30,
      dailyGrants: 2,
      dailyRemainingGrants: 28,
      dailyResetAt: "2026-09-12T00:00:00.000Z",
      monthlyGrantLimit: 200,
      monthlyGrants: 12,
      monthlyRemainingGrants: 188,
      monthlyByteLimit: 1_000_000_000,
      confirmedBytes: 50_000_000,
      monthlyRemainingBytes: 950_000_000,
      monthlyResetAt: "2026-10-01T00:00:00.000Z",
    },
    storage: {
      limitBytes: 1_000_000_000,
      retainedBytes: 100_000_000,
      remainingBytes: 900_000_000,
    },
    effectiveLimits: {
      maxDurationSeconds: 1_200,
      maxPreparedAudioBytes: 50_000_000,
      maxClientInputAttempts: 5,
      signedUrlTtlSeconds: 600,
    },
    downloads: {
      monthlyGrantLimit: 150,
      monthlyGrants: 10,
      monthlyRemainingGrants: 140,
      monthlyByteLimit: 10_000_000_000,
      estimatedBytes: 500_000_000,
      monthlyRemainingBytes: 9_500_000_000,
      monthlyResetAt: "2026-10-01T00:00:00.000Z",
    },
    usageRevision: 1,
    waitingJobs: 3,
    maxWaitingJobs: 3,
    processingJobs: 1,
    maxProcessingJobs: 1,
    availability: { status: "blocked", reason: "waiting_job_limit" },
    checkedAt: NOW,
    policyOverride: null,
  };
  settings: AccountPolicy = {
    plan: "standard",
    revision: 1,
    acceptNewJobs: true,
    maintenanceMessageEn: "",
    maintenanceMessageAr: null,
    values: {
      monthlyProcessingSeconds: 7_200,
      maxDurationSeconds: 1_200,
      maxPreparedAudioBytes: 50_000_000,
      dailyUploadGrants: 30,
      monthlyUploadGrants: 200,
      monthlyConfirmedUploadBytes: 1_000_000_000,
      maxWaitingJobs: 3,
      maxProcessingJobs: 1,
      maxInfrastructureAttempts: 3,
      maxClientInputAttempts: 5,
      monthlyDownloadGrants: 150,
      monthlyEstimatedDownloadBytes: 10_000_000_000,
      maxRetainedOutputBytes: 1_000_000_000,
      signedUrlTtlSeconds: 600,
      monthlyServiceOutboundBytes: 80_000_000_000,
      deletionGraceHours: 360,
    },
    enforcedFeatures: [
      "processing_minutes",
      "media_limits",
      "upload_limits",
      "download_limits",
      "retained_storage",
      "service_outbound",
    ],
    updatedBy: "owner-fixture",
    updatedAt: NOW,
  };
  policy: UpdatePolicy = {
    revision: 1,
    android: {
      minimumBuild: 10,
      source: "direct_apk",
      directReleaseId: FIXTURE_IDS.publishedRelease,
      storeReleaseId: null,
    },
    ios: { minimumBuild: 10, storeReleaseId: null },
  };
  job: JobDetail = {
    id: FIXTURE_IDS.job,
    userId: FIXTURE_IDS.user,
    status: "processing",
    createdAt: NOW,
    queuedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    elapsedSeconds: 42,
    queuePosition: null,
    revision: 1,
    lastError: null,
    displayName: "Fixture song",
    userEmail: "listener@example.invalid",
    userDisplayName: "Fixture Listener",
    retryOfJobId: null,
    stageTimings: [
      {
        stage: "processing",
        startedAt: NOW,
        finishedAt: null,
        durationSeconds: null,
      },
    ],
    declaredDurationSeconds: 120,
    measuredDurationSeconds: 119.5,
    media: { inputAvailable: true, resultAvailable: true },
  };
  user: UserDetail = {
    id: FIXTURE_IDS.user,
    email: "listener@example.invalid",
    displayName: "Fixture Listener",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    processingCounts: { processing: 1, completed: 2 },
    recentJobIds: [FIXTURE_IDS.job],
    deletion: null,
  };
  restriction: AccountRestriction | null = null;
  abuseEvents: AbuseEvent[] = [];
  recovery: AccountRecoveryRequest = {
    id: FIXTURE_IDS.recovery,
    status: "pending",
    reason: "I changed my mind and need access to my saved vocals.",
    requestedAt: NOW,
    reviewedAt: null,
    reviewReason: null,
    revision: 0,
    deletionRequestId: "fixture-deletion-request",
    deletionRequestedAt: NOW,
    recoverUntil: "2026-09-26T00:00:00.000Z",
    user: {
      id: FIXTURE_IDS.user,
      email: this.user.email,
      displayName: this.user.displayName,
      status: "deleting",
      deletionPhase: "grace_fence",
      deletionFailureCode: null,
    },
  };
  releases: ReleaseDetail[] = [
    {
      id: FIXTURE_IDS.release,
      platform: "android",
      source: "direct_apk",
      versionName: "2.0.0",
      buildNumber: 20,
      changelogEn: "Fixture release",
      storeUrl: null,
      state: "draft",
      artifactState: "verified",
      revision: 1,
      createdAt: NOW,
      publishedAt: null,
      bytes: 1_024,
      sha256Hex: "a".repeat(64),
      signerSha256Hex: "b".repeat(64),
      rejectionCode: null,
      publishedBy: null,
    },
    {
      id: FIXTURE_IDS.publishedRelease,
      platform: "android",
      source: "direct_apk",
      versionName: "1.0.0",
      buildNumber: 10,
      changelogEn: "Current release",
      storeUrl: null,
      state: "published",
      artifactState: "verified",
      revision: 1,
      createdAt: NOW,
      publishedAt: NOW,
      bytes: 1_024,
      sha256Hex: "c".repeat(64),
      signerSha256Hex: "b".repeat(64),
      rejectionCode: null,
      publishedBy: "owner-fixture",
    },
  ];
  alert: AlertRecord = {
    id: FIXTURE_IDS.alert,
    type: "dependency_probe_failed",
    severity: "critical",
    resourceId: "storage",
    state: "active",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    revision: 1,
    message: "The storage dependency needs attention.",
  };
  workerMachine: WorkerMachine = {
    machineId: FIXTURE_IDS.workerMachine,
    status: "active",
    label: "Windows Z440",
    groupId: "mvp",
    policyRevision: 3,
    appliedRevision: 3,
    desiredRevision: 3,
    capabilities: [
      {
        platform: "windows-amd64",
        provider: "directml",
        gpuId: "0",
        recipeIds: ["kim-vocals-v2"],
        maxSlots: 1,
      },
    ],
    hardware: {
      os: "Windows 11 Pro",
      osBuild: "26200",
      architecture: "x64",
      cpu: "Intel Xeon fixture",
      memoryBytes: 34_359_738_368,
      gpus: [
        {
          id: "0",
          name: "Radeon RX 580",
          driverVersion: "fixture-driver",
          memoryBytes: 8_589_934_592,
        },
      ],
    },
    runtime: {
      workerVersion: "0.1.3",
      protocolVersion: 1,
      manifestDigest: "a".repeat(64),
      modelDigest: "b".repeat(64),
      providerRuntimeVersion: "onnxruntime-directml 1.24.4",
    },
    session: {
      sessionId: "a7e20fda-7501-4942-ab8c-955621d13b85",
      incarnation: "bb4e53ba-3c64-474e-9375-1ca345346e3b",
      generation: 1,
      startedAt: NOW,
      lastSeenAt: NOW,
    },
    lastSeenAt: NOW,
    revokedAt: null,
    revision: 4,
    createdAt: NOW,
    updatedAt: NOW,
    currentAttempt: {
      attemptId: FIXTURE_IDS.workerAttempt,
      jobId: FIXTURE_IDS.job,
      state: "running",
      stage: "separating",
      startedAt: NOW,
    },
    recentError: null,
  };
  workerDetail: WorkerMachineDetail = {
    machine: this.workerMachine,
    slots: [
      {
        _id: FIXTURE_IDS.workerSlot,
        gpuId: "0",
        slotIndex: 0,
        state: "busy",
        allowedRecipeIds: this.workerMachine.capabilities[0]!.recipeIds,
        currentAttemptId: FIXTURE_IDS.workerAttempt,
        lastSeenAt: NOW,
        revision: 2,
      },
    ],
    attempts: [
      {
        attemptId: FIXTURE_IDS.workerAttempt,
        jobId: FIXTURE_IDS.job,
        workerId: FIXTURE_IDS.workerSlot,
        state: "running",
        stage: "separating",
        attemptNumber: 1,
        leaseExpiresAt: "2026-09-11T00:01:00.000Z",
        deadlineAt: "2026-09-11T00:15:00.000Z",
        terminalCode: null,
        terminalSummary: null,
        finishedAt: null,
      },
    ],
    diagnostics: [
      {
        id: FIXTURE_IDS.workerDiagnostic,
        kind: "runtime_log",
        sequenceStart: 0,
        sequenceEnd: 1,
        lineCount: 2,
        metricCount: 1,
        createdAt: NOW,
      },
    ],
    installation: {
      id: FIXTURE_IDS.workerInstallation,
      phase: "activated",
      outcomeCode: null,
      reportSummary: "DirectML qualification passed",
      activatedAt: NOW,
    },
    commands: [],
  };
  workerDiagnostics: WorkerDiagnosticPage = {
    items: [
      {
        id: FIXTURE_IDS.workerDiagnostic,
        kind: "runtime_log",
        sequenceStart: 0,
        sequenceEnd: 1,
        lines: [
          "Service healthy",
          "Private upload https://storage.invalid/signed-value credential=fixture-secret",
        ],
        metrics: [{ name: "provider_nodes", value: 896, unit: "nodes" }],
        createdAt: NOW,
      },
    ],
  };
  workerInvitations: WorkerInvitation[] = [
    {
      invitationId: FIXTURE_IDS.workerInvitation,
      state: "consumed",
      createdByUid: "owner-fixture",
      initialPolicyId: null,
      expiresAt: "2026-09-11T00:15:00.000Z",
      consumedAt: NOW,
      revokedAt: null,
      installationSessionId: FIXTURE_IDS.workerInstallation,
      installation: {
        phase: "activated",
        outcomeCode: null,
        reportSummary: "DirectML qualification passed",
        lastSeenAt: NOW,
        machineId: FIXTURE_IDS.workerMachine,
        activatedAt: NOW,
        updatedAt: NOW,
      },
      revision: 1,
    },
  ];
  workerPolicy: WorkerFleetPolicy = {
    revision: 3,
    acceptClaims: true,
    recipes: [
      {
        recipeId: "kim-vocals-v2",
        enabled: true,
        maxSlotsPerMachine: 1,
      },
    ],
    leaseSeconds: 60,
    processingDeadlineSeconds: 900,
    maxAttempts: 3,
    updatedAt: NOW,
  };

  async handle(input: FixtureRequest): Promise<FixtureResponse> {
    const method = input.method.toUpperCase();
    const url = new URL(input.url, "http://127.0.0.1");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const request = { ...input, method, url: url.toString() };
    this.requests.push(request);

    const role = input.token?.replace(/-fixture$/, "") as AdminRole | undefined;
    if (!role || !(role in ROLE_DETAILS))
      return error(401, "UNAUTHENTICATED", "Authentication is required.");
    const required = permissionFor(method, path);
    if (required && !ROLE_DETAILS[role].permissions.includes(required))
      return error(403, "FORBIDDEN", "This administrator role is not allowed.");

    if (method === "GET" && path === "/admin/session")
      return { status: 200, body: sessionForRole(role) };
    if (
      path === `/admin/users/${FIXTURE_IDS.user}/account-usage` &&
      method === "GET"
    ) {
      return { status: 200, body: this.accountUsage };
    }
    if (
      path === `/admin/users/${FIXTURE_IDS.user}/account-policy-override` &&
      ["PUT", "DELETE"].includes(method)
    ) {
      const body = input.body as RevisionCommand & {
        values?: AccountPolicyOverride["values"];
        expiresAt?: string | null;
      };
      if (
        body.expectedRevision !==
        (this.accountUsage.policyOverride?.revision ?? 0)
      )
        return error(
          409,
          "REVISION_CONFLICT",
          "Override revision changed; refresh usage and review again.",
        );
      if (!body.reason || !body.operationId)
        return error(
          400,
          "INVALID_REQUEST",
          "Reason and operation ID are required.",
        );
      const clear = method === "DELETE";
      if (
        !clear &&
        (!body.values ||
          Object.keys(body.values).length === 0 ||
          Object.values(body.values).some(
            (value) => !Number.isSafeInteger(value) || value! < 1,
          ) ||
          (body.expiresAt !== null &&
            (!body.expiresAt || Date.parse(body.expiresAt) <= Date.now())))
      )
        return error(
          400,
          "INVALID_REQUEST",
          "A positive replacement and optional future expiry are required.",
        );
      const limit = clear
        ? this.settings.values.monthlyProcessingSeconds
        : (body.values!.monthlyProcessingSeconds ??
          this.settings.values.monthlyProcessingSeconds);
      const nextRevision =
        (this.accountUsage.policyOverride?.revision ?? 0) + 1;
      this.accountUsage = {
        ...this.accountUsage,
        overrideRevision: clear ? null : nextRevision,
        effectivePolicySource: clear ? "global" : "account_override",
        overrideExpiresAt: clear ? null : (body.expiresAt ?? null),
        processing: {
          ...this.accountUsage.processing,
          limitSeconds: limit,
          remainingSeconds: Math.max(
            0,
            limit -
              this.accountUsage.processing.usedSeconds -
              this.accountUsage.processing.reservedSeconds,
          ),
        },
        policyOverride: clear
          ? null
          : {
              revision: nextRevision,
              values: body.values!,
              expiresAt: body.expiresAt ?? null,
              reason: body.reason,
              createdBy: "owner-fixture",
              updatedBy: "owner-fixture",
              createdAt: NOW,
              updatedAt: NOW,
            },
      };
      return { status: 200, body: this.accountUsage };
    }
    if (method === "GET" && path === "/admin/overview")
      return {
        status: 200,
        body: {
          asOf: NOW,
          from: url.searchParams.get("from") ?? NOW,
          to: url.searchParams.get("to") ?? NOW,
          counts: {
            submitted: 4,
            processingActiveUsers: 1,
            completed: 2,
            failed: 1,
            cancelled: 0,
          },
          queue: { waiting: 1, processing: 1, oldestWaitSeconds: 12 },
          timings: {
            meanQueueWaitSeconds: 4.5,
            meanProcessingSeconds: 42,
            sampleCount: { queueWait: 3, processing: 2 },
          },
          series: [
            { start: NOW, submitted: 4, completed: 2, failed: 1, cancelled: 0 },
          ],
          releaseSummary: {
            draft: 1,
            published: 1,
            withdrawn: 0,
            rejectedArtifacts: 0,
          },
        },
      };
    if (path.startsWith("/admin/exports/") && method === "GET") {
      const overview = path.endsWith("overview.csv");
      return {
        status: 200,
        body: overview
          ? "bucketStart,submitted,completed,failed,cancelled\r\n2026-09-11T00:00:00.000Z,4,2,1,0\r\n"
          : `id,userId,status,createdAt,queuedAt,startedAt,finishedAt,elapsedSeconds,errorCode\r\n${FIXTURE_IDS.job},${FIXTURE_IDS.user},processing,${NOW},${NOW},${NOW},,42,\r\n`,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="musicmute-${overview ? "overview" : "jobs"}.csv"`,
        },
      };
    }
    if (path === "/admin/access") {
      if (method === "GET")
        return {
          status: 200,
          body: page([
            {
              uid: "owner-fixture",
              verifiedEmail: "owner-fixture@example.invalid",
              role: "owner",
              active: true,
              revision: 1,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              uid: "support-fixture",
              verifiedEmail: "support-fixture@example.invalid",
              role: "support",
              active: true,
              revision: 1,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ]),
        };
      const body = input.body as { verifiedEmail: string; role: AdminRole };
      return {
        status: 201,
        body: {
          uid: "new-admin-fixture",
          verifiedEmail: body.verifiedEmail,
          role: body.role,
          active: true,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      };
    }
    if (/^\/admin\/access\/[^/]+$/.test(path) && method === "PATCH")
      return {
        status: 200,
        body: {
          uid: path.split("/").at(-1),
          verifiedEmail: "admin@example.invalid",
          role: "viewer",
          active: true,
          revision: 2,
          createdAt: NOW,
          updatedAt: NOW,
        },
      };

    if (path === "/admin/jobs" && method === "GET")
      return { status: 200, body: page([this.job]) };
    if (path === `/admin/jobs/${this.job.id}` && method === "GET")
      return { status: 200, body: this.job };
    if (path === `/admin/jobs/${this.job.id}/cancel` && method === "POST") {
      this.job = {
        ...this.job,
        status: "cancelled",
        finishedAt: NOW,
        revision: this.job.revision + 1,
      };
      return {
        status: 201,
        body: {
          jobId: this.job.id,
          status: this.job.status,
          revision: this.job.revision,
        },
      };
    }
    if (
      path === `/admin/jobs/${this.job.id}/media-grants` &&
      method === "POST"
    ) {
      if (
        !hasExactKeys(input.body, ["asset", "purpose", "operationId", "reason"])
      )
        return error(400, "INVALID_REQUEST", "Invalid media grant request.");
      const body = input.body as { asset: string };
      return {
        status: 201,
        body: {
          url: `https://media.fixture.invalid/${body.asset}`,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          bytes: 1_024,
          contentType: "audio/mpeg",
          filename: `${body.asset}.mp3`,
        },
      };
    }

    if (path === "/admin/account-recovery-requests/summary" && method === "GET")
      return {
        status: 200,
        body: {
          pendingCount: this.recovery.status === "pending" ? 1 : 0,
          oldestRequestedAt:
            this.recovery.status === "pending"
              ? this.recovery.requestedAt
              : null,
          highPriority: this.recovery.status === "pending",
          asOf: NOW,
        },
      };
    if (path === "/admin/account-recovery-requests" && method === "GET") {
      const status = url.searchParams.get("status") ?? "pending";
      return {
        status: 200,
        body: page(
          status === "all" || status === this.recovery.status
            ? [this.recovery]
            : [],
        ),
      };
    }
    if (
      path === `/admin/account-recovery-requests/${this.recovery.id}` &&
      method === "GET"
    )
      return { status: 200, body: this.recovery };
    if (
      path.startsWith(
        `/admin/account-recovery-requests/${this.recovery.id}/`,
      ) &&
      method === "POST"
    ) {
      const action = path.split("/").at(-1);
      const body = input.body as { reason: string };
      this.recovery = {
        ...this.recovery,
        status: action === "approve" ? "approved" : "rejected",
        reviewedAt: NOW,
        reviewReason: body.reason,
        revision: this.recovery.revision + 1,
        user: {
          ...this.recovery.user,
          status: action === "approve" ? "active" : "deleting",
        },
      };
      return { status: 201, body: this.recovery };
    }

    if (path === "/admin/users" && method === "GET")
      return { status: 200, body: page([this.user]) };
    if (path === `/admin/users/${this.user.id}` && method === "GET")
      return { status: 200, body: this.user };
    if (path === `/admin/users/${this.user.id}/restriction` && method === "GET")
      return { status: 200, body: this.restriction };
    if (
      path === `/admin/users/${this.user.id}/restriction` &&
      method === "PUT"
    ) {
      const body = input.body as {
        reasonCode: AccountRestriction["reasonCode"];
        note: string;
        expiresAt?: string;
      };
      this.restriction = {
        id: "000000000000000000000060",
        accountId: this.user.id,
        status: "active",
        reasonCode: body.reasonCode,
        note: body.note,
        startsAt: NOW,
        expiresAt: body.expiresAt ?? null,
        createdBy: `${role}-fixture`,
        updatedBy: `${role}-fixture`,
        updatedAt: NOW,
        revision: (this.restriction?.revision ?? 0) + 1,
      };
      return { status: 200, body: this.restriction };
    }
    if (
      path === `/admin/users/${this.user.id}/restriction` &&
      method === "DELETE"
    ) {
      if (this.restriction)
        this.restriction = {
          ...this.restriction,
          status: "removed",
          revision: this.restriction.revision + 1,
        };
      return { status: 200, body: this.restriction };
    }
    if (path === "/admin/abuse-events" && method === "GET")
      return { status: 200, body: page(this.abuseEvents) };

    if (path === "/admin/worker-fleet/machines" && method === "GET") {
      const status = url.searchParams.get("status");
      const platform = url.searchParams.get("platform");
      const groupId = url.searchParams.get("groupId");
      const releaseVersion = url.searchParams.get("releaseVersion");
      const matches =
        (!status || this.workerMachine.status === status) &&
        (!platform ||
          this.workerMachine.capabilities.some(
            (capability) => capability.platform === platform,
          )) &&
        (!groupId || this.workerMachine.groupId === groupId) &&
        (!releaseVersion ||
          this.workerMachine.runtime?.workerVersion === releaseVersion);
      return {
        status: 200,
        body: page(matches ? [this.workerMachine] : []),
      };
    }
    if (
      path ===
        `/admin/worker-fleet/machines/${FIXTURE_IDS.workerMachine}/diagnostics` &&
      method === "GET"
    )
      return { status: 200, body: this.workerDiagnostics };
    if (
      path === `/admin/worker-fleet/machines/${FIXTURE_IDS.workerMachine}` &&
      method === "GET"
    )
      return { status: 200, body: this.workerDetail };
    if (
      path.match(
        new RegExp(
          `^/admin/worker-fleet/machines/${FIXTURE_IDS.workerMachine}/(doctor|benchmark)$`,
        ),
      ) &&
      method === "POST"
    )
      return {
        status: 201,
        body: {
          commandId: "c7ed43ba-4f5f-4531-8424-8f69fa87ddde",
          deferred: false,
          replayed: false,
        },
      };
    if (path === "/admin/worker-fleet/invitations" && method === "GET")
      return {
        status: 200,
        body: { items: this.workerInvitations, asOf: NOW },
      };
    if (path === "/admin/workers/invitations" && method === "POST") {
      const body = input.body as {
        expiresInSeconds?: number;
        operationId?: string;
        reason?: string;
      };
      if (
        !body.reason ||
        !body.operationId ||
        !body.expiresInSeconds ||
        body.expiresInSeconds < 300 ||
        body.expiresInSeconds > 86400
      )
        return error(400, "INVALID_REQUEST", "Invalid worker invitation.");
      const invitationId = "0a67996c-84d7-412e-9c0e-e8684519a793";
      const expiresAt = new Date(
        Date.parse(NOW) + body.expiresInSeconds * 1000,
      ).toISOString();
      this.workerInvitations.unshift({
        invitationId,
        state: "active",
        createdByUid: `${role}-fixture`,
        initialPolicyId: null,
        expiresAt,
        consumedAt: null,
        revokedAt: null,
        installationSessionId: null,
        installation: null,
        revision: 0,
      });
      return {
        status: 201,
        body: {
          invitationId,
          revision: 0,
          credential: "fixture-one-use-enrollment-secret",
          expiresAt,
          replayed: false,
        },
      };
    }
    const invitationRevoke = path.match(
      /^\/admin\/workers\/invitations\/([^/]+)\/revoke$/,
    );
    if (invitationRevoke && method === "POST") {
      const invitation = this.workerInvitations.find(
        (item) => item.invitationId === invitationRevoke[1],
      );
      if (!invitation)
        return error(404, "RESOURCE_NOT_FOUND", "Invitation not found.");
      invitation.state = "revoked";
      invitation.revokedAt = NOW;
      invitation.revision += 1;
      return {
        status: 201,
        body: {
          invitationId: invitation.invitationId,
          revision: invitation.revision,
          replayed: false,
        },
      };
    }
    const machineAction = path.match(
      new RegExp(
        `^/admin/workers/machines/${FIXTURE_IDS.workerMachine}/(pause|drain|resume|revoke)$`,
      ),
    );
    if (machineAction && method === "POST") {
      const body = input.body as RevisionCommand;
      if (body.expectedRevision !== this.workerMachine.revision)
        return error(409, "REVISION_CONFLICT", "Worker revision changed.");
      const action = machineAction[1];
      const status =
        action === "pause"
          ? "paused"
          : action === "drain"
            ? "draining"
            : action === "resume"
              ? "active"
              : "revoked";
      this.workerMachine = {
        ...this.workerMachine,
        status,
        revision: this.workerMachine.revision + 1,
        revokedAt: status === "revoked" ? NOW : null,
      };
      this.workerDetail.machine = this.workerMachine;
      return {
        status: 201,
        body: {
          machineId: this.workerMachine.machineId,
          revision: this.workerMachine.revision,
          status,
          replayed: false,
        },
      };
    }
    if (path === "/admin/worker-fleet/policy") {
      if (method === "GET") return { status: 200, body: this.workerPolicy };
      const body = input.body as RevisionCommand & Partial<WorkerFleetPolicy>;
      if (body.expectedRevision !== this.workerPolicy.revision)
        return error(409, "REVISION_CONFLICT", "Policy revision changed.");
      this.workerPolicy = {
        ...this.workerPolicy,
        acceptClaims: body.acceptClaims ?? this.workerPolicy.acceptClaims,
        recipes: body.recipes ?? this.workerPolicy.recipes,
        leaseSeconds: body.leaseSeconds ?? this.workerPolicy.leaseSeconds,
        processingDeadlineSeconds:
          body.processingDeadlineSeconds ??
          this.workerPolicy.processingDeadlineSeconds,
        maxAttempts: body.maxAttempts ?? this.workerPolicy.maxAttempts,
        revision: this.workerPolicy.revision + 1,
        updatedAt: NOW,
      };
      return {
        status: 200,
        body: { revision: this.workerPolicy.revision, replayed: false },
      };
    }

    if (path === "/admin/releases/proposal" && method === "GET") {
      const platform = url.searchParams.get("platform");
      const source = url.searchParams.get("source");
      if (!(
        (platform === "android" &&
          (source === "direct_apk" || source === "google_play")) ||
        (platform === "ios" && source === "app_store")
      ))
        return error(400, "INVALID_REQUEST", "Invalid release channel.");
      const current = this.releases
        .filter(
          (release) =>
            release.platform === platform && release.source === source,
        )
        .sort((left, right) => right.buildNumber - left.buildNumber)[0] ?? {
        versionName: "0.1.0",
        buildNumber: 1,
      };
      const version = current.versionName.split(".").map(Number);
      while (version.length < 3) version.push(0);
      return {
        status: 200,
        body: {
          platform,
          source,
          current: {
            versionName: current.versionName,
            buildNumber: current.buildNumber,
          },
          suggested: {
            versionName: `${version[0]}.${version[1]}.${version[2]! + 1}`,
            buildNumber: current.buildNumber + 1,
          },
        },
      };
    }
    if (path === "/admin/releases" && method === "GET")
      return { status: 200, body: page(this.releases) };
    if (path === "/admin/releases" && method === "POST") {
      const body = input.body as Omit<ReleaseDetail, "id">;
      const created = {
        ...this.releases[0],
        ...body,
        id: "000000000000000000000099",
        revision: 1,
      };
      this.releases.unshift(created);
      return { status: 201, body: created };
    }
    const releaseMatch = path.match(/^\/admin\/releases\/([^/]+)$/);
    if (releaseMatch) {
      const release = this.releases.find(({ id }) => id === releaseMatch[1]);
      if (!release) return error(404, "NOT_FOUND", "Release was not found.");
      if (method === "GET") return { status: 200, body: release };
      if (method === "PATCH") {
        if (
          !hasOnlyKeys(
            input.body,
            ["expectedRevision", "operationId", "reason"],
            ["versionName", "buildNumber", "changelogEn", "storeUrl"],
          )
        )
          return error(400, "INVALID_REQUEST", "Invalid release edit request.");
        Object.assign(release, input.body, { revision: release.revision + 1 });
        return { status: 200, body: release };
      }
    }
    if (
      path === `/admin/releases/${FIXTURE_IDS.release}/uploads` &&
      method === "POST"
    ) {
      this.releases[0].artifactState = "awaiting_upload";
      return {
        status: 201,
        body: {
          uploadId: FIXTURE_IDS.upload,
          grant: {
            method: "PUT",
            url: "https://upload.fixture.invalid",
            headers: {
              "Content-Type": "application/vnd.android.package-archive",
              "x-amz-checksum-sha256":
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
              "If-None-Match": "*",
            },
            expiresAt: "2026-09-11T00:05:00.000Z",
          },
          expectedBytes: 1024,
          expectedSha256: "a".repeat(64),
        },
      };
    }
    if (path.includes(`/uploads/${FIXTURE_IDS.upload}`)) {
      this.releases[0].artifactState = "verified";
      return {
        status: method === "GET" ? 200 : 201,
        body: { artifactState: "verified", checkedAt: NOW },
      };
    }
    if (path === "/admin/update-policy" && method === "GET")
      return { status: 200, body: this.policy };
    if (path === "/admin/update-policy/preview" && method === "POST") {
      if (!validPolicySelection(input.body))
        return error(400, "INVALID_REQUEST", "Invalid policy selection.");
      return {
        status: 201,
        body: {
          currentRevision: this.policy.revision,
          valid: true,
          errors: [],
          examples: [
            {
              platform: "android",
              distribution: "direct_apk",
              installedBuild: 9,
              decision: "required",
              targetBuild: 20,
            },
          ],
        },
      };
    }
    const publication = path.match(
      /^\/admin\/releases\/([^/]+)\/(publish|withdraw)$/,
    );
    if (publication && method === "POST") {
      const release = this.releases.find(({ id }) => id === publication[1]);
      if (!release) return error(404, "NOT_FOUND", "Release was not found.");
      const operation = publication[2] as "publish" | "withdraw";
      const policyField =
        operation === "publish" ? "policy" : "replacementPolicy";
      const keys = [
        "expectedRevision",
        "expectedReleaseRevision",
        policyField,
        "operationId",
        "reason",
        ...(operation === "publish" ? ["storeAvailabilityConfirmed"] : []),
      ];
      if (!hasExactKeys(input.body, keys))
        return error(400, "INVALID_REQUEST", "Invalid publication request.");
      const body = input.body as Record<string, unknown>;
      if (!validPolicySelection(body[policyField]))
        return error(400, "INVALID_REQUEST", "Invalid policy selection.");
      release.state = operation === "publish" ? "published" : "withdrawn";
      release.revision += 1;
      this.policy = {
        ...(body[policyField] as Omit<UpdatePolicy, "revision">),
        revision: this.policy.revision + 1,
      };
      return {
        status: 201,
        body: {
          release,
          policyRevision: this.policy.revision,
          operationId: body.operationId,
        },
      };
    }

    if (path === "/admin/settings/account-policy") {
      if (method === "GET") return { status: 200, body: this.settings };
      const body = input.body as Record<string, unknown>;
      const values = Object.fromEntries(
        Object.keys(this.settings.values).map((key) => [
          key,
          body[key] ??
            this.settings.values[key as keyof typeof this.settings.values],
        ]),
      ) as unknown as AccountPolicy["values"];
      this.settings = {
        ...this.settings,
        acceptNewJobs: Boolean(body.acceptNewJobs),
        maintenanceMessageEn: String(body.maintenanceMessageEn ?? ""),
        maintenanceMessageAr:
          typeof body.maintenanceMessageAr === "string"
            ? body.maintenanceMessageAr
            : null,
        values,
        revision: this.settings.revision + 1,
        updatedAt: NOW,
      };
      return { status: 200, body: this.settings };
    }
    if (path === "/admin/health" && method === "GET")
      return {
        status: 200,
        body: {
          status: "degraded",
          asOf: NOW,
          components: [
            {
              name: "storage",
              status: "unavailable",
              checkedAt: NOW,
              code: "DEPENDENCY_UNAVAILABLE",
            },
            { name: "mongodb", status: "healthy", checkedAt: NOW, code: null },
          ],
          activeAlertCount: this.alert.state === "active" ? 1 : 0,
        },
      };
    if (path === "/admin/alerts" && method === "GET")
      return { status: 200, body: page([this.alert]) };
    if (
      path === `/admin/alerts/${this.alert.id}/acknowledge` &&
      method === "POST"
    ) {
      this.alert = {
        ...this.alert,
        acknowledgedAt: NOW,
        acknowledgedBy: `${role}-fixture`,
        revision: this.alert.revision + 1,
      };
      return { status: 201, body: this.alert };
    }
    if (path === "/admin/audit" && method === "GET") {
      const event: AuditEvent = {
        id: "audit-fixture",
        actorUid: "owner-fixture",
        action: "jobs.cancel",
        resourceType: "job",
        resourceId: this.job.id,
        operationId: "00000000-0000-4000-8000-000000000001",
        reason: "Fixture audit event",
        at: NOW,
        previousRevision: 1,
        nextRevision: 2,
        outcome: "succeeded",
      };
      return { status: 200, body: page([event]) };
    }

    return error(
      404,
      "NOT_FOUND",
      `No dashboard fixture handles ${method} ${path}.`,
    );
  }
}

export const createDashboardFixture = () => new DashboardFixture();
