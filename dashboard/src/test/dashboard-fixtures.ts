import type {
  AdminRole,
  AdminSession,
  AccountRecoveryRequest,
  AlertRecord,
  AuditEvent,
  JobDetail,
  Permission,
  ProcessingSettings,
  ProcessingUsage,
  RevisionCommand,
  ReleaseDetail,
  UpdatePolicy,
  UserDetail,
} from "../api/contracts";
import { ROLE_DETAILS } from "../features/administrators/role-permissions";

const NOW = "2026-09-11T00:00:00.000Z";
export const FIXTURE_IDS = {
  job: "000000000000000000000001",
  user: "000000000000000000000010",
  release: "000000000000000000000020",
  publishedRelease: "000000000000000000000021",
  upload: "000000000000000000000030",
  alert: "000000000000000000000040",
  recovery: "000000000000000000000050",
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
  if (path.startsWith("/admin/users"))
    return method === "GET" ? "users.read" : "users.processing.manage";
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
  processingUsage: ProcessingUsage = {
    revision: 1,
    policyRevision: 1,
    allowanceAudioSeconds: 3600,
    usedAudioSeconds: 900,
    reservedAudioSeconds: 600,
    remainingAudioSeconds: 2100,
    activeJobs: 1,
    maxActiveJobs: 1,
    nextReplenishmentAt: null,
    replenishments: [],
    availability: "available",
    checkedAt: NOW,
    allowanceOverride: null,
  };
  settings: ProcessingSettings = {
    revision: 1,
    acceptNewJobs: true,
    maintenanceMessageEn: "",
    maintenanceMessageAr: null,
    maxInputBytesExclusive: 30_000_000,
    maxDurationSecondsExclusive: 600,
    maxActiveJobsPerUser: null,
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
    processingSuspended: false,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    processingCounts: { processing: 1, completed: 2 },
    recentJobIds: [FIXTURE_IDS.job],
    suspension: null,
    deletion: null,
  };
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
    recoverUntil: "2026-12-11T00:00:00.000Z",
    user: {
      id: FIXTURE_IDS.user,
      email: this.user.email,
      displayName: this.user.displayName,
      status: "deleting",
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
      path === `/admin/users/${FIXTURE_IDS.user}/processing-usage` &&
      method === "GET"
    ) {
      return {
        status: 200,
        body: { ...this.processingUsage, revision: this.user.revision },
      };
    }
    if (
      (path === `/admin/users/${FIXTURE_IDS.user}/processing-allowance` &&
        method === "PUT") ||
      (path === `/admin/users/${FIXTURE_IDS.user}/clear-processing-allowance` &&
        method === "POST")
    ) {
      const body = input.body as RevisionCommand & {
        allowanceAudioSeconds?: number;
        expiresAt?: string;
      };
      if (body.expectedRevision !== this.user.revision)
        return error(
          409,
          "REVISION_CONFLICT",
          "Account revision changed; refresh usage and review again.",
        );
      if (!body.reason || !body.operationId)
        return error(
          400,
          "INVALID_REQUEST",
          "Reason and operation ID are required.",
        );
      const clear = path.endsWith("clear-processing-allowance");
      if (
        !clear &&
        (!body.allowanceAudioSeconds ||
          !body.expiresAt ||
          body.allowanceAudioSeconds < 3600 ||
          body.allowanceAudioSeconds > 86400 ||
          Date.parse(body.expiresAt) <= Date.now())
      )
        return error(
          400,
          "INVALID_REQUEST",
          "Bounded allowance and future expiry are required.",
        );
      this.user = { ...this.user, revision: this.user.revision + 1 };
      this.processingUsage = {
        ...this.processingUsage,
        revision: this.user.revision,
        allowanceAudioSeconds: clear ? 3600 : body.allowanceAudioSeconds!,
        remainingAudioSeconds:
          (clear ? 3600 : body.allowanceAudioSeconds!) -
          this.processingUsage.usedAudioSeconds -
          this.processingUsage.reservedAudioSeconds,
        allowanceOverride: clear
          ? null
          : {
              allowanceAudioSeconds: body.allowanceAudioSeconds!,
              expiresAt: body.expiresAt!,
            },
      };
      return {
        status: 200,
        body: {
          revision: this.user.revision,
          allowanceOverride: this.processingUsage.allowanceOverride,
        },
      };
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
    if (path.startsWith(`/admin/users/${this.user.id}/`) && method === "POST") {
      const suspended = path.endsWith("suspend-processing");
      this.user = {
        ...this.user,
        processingSuspended: suspended,
        revision: this.user.revision + 1,
        suspension: suspended
          ? {
              reason: "Fixture support action",
              actorUid: `${role}-fixture`,
              at: NOW,
            }
          : null,
      };
      return { status: 201, body: this.user };
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

    if (path === "/admin/settings/processing") {
      if (method === "GET") return { status: 200, body: this.settings };
      this.settings = {
        ...this.settings,
        ...(input.body as Partial<ProcessingSettings>),
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
