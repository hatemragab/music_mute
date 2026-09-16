import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "./api-client";
import {
  ADMIN_ROLES,
  ALERT_SEVERITIES,
  JOB_STATUSES,
  PERMISSIONS,
} from "./contracts";
import { NAV_ITEMS } from "@/app/app-shell";
import { requestMediaGrant } from "@/features/jobs/jobs-api";
import {
  getReleaseProposal,
  previewUpdatePolicy,
  publishRelease,
  updateRelease,
  withdrawRelease,
} from "@/features/releases/releases-api";
import {
  decideAccountRecoveryRequest,
  getAccountRecoverySummary,
} from "@/features/account-recovery/account-recovery-api";

const client = () =>
  ({
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
  }) as unknown as ApiClient;

const policy = {
  revision: 7,
  android: {
    minimumBuild: 10,
    source: "direct_apk" as const,
    directReleaseId: "release-android",
    storeReleaseId: null,
  },
  ios: { minimumBuild: 11, storeReleaseId: "release-ios" },
};

describe("dashboard/backend contract alignment", () => {
  it("requests the release proposal for the selected channel", async () => {
    const api = client();

    await getReleaseProposal(api, "android", "direct_apk");

    expect(api.get).toHaveBeenCalledWith(
      "/admin/releases/proposal?platform=android&source=direct_apk",
    );
  });

  it("uses the backend media-grant purpose field", async () => {
    const api = client();

    await requestMediaGrant(api, "job-1", {
      asset: "result",
      purpose: "play",
      operationId: "operation-1",
      reason: "Review the generated vocals",
    });

    expect(api.post).toHaveBeenCalledWith("/admin/jobs/job-1/media-grants", {
      asset: "result",
      purpose: "play",
      operationId: "operation-1",
      reason: "Review the generated vocals",
    });
  });

  it("contains no removed machine administration contract", () => {
    expect(ADMIN_ROLES).toEqual([
      "owner",
      "release_manager",
      "support",
      "viewer",
    ]);
    expect(
      PERMISSIONS.some((permission) => permission.startsWith("workers.")),
    ).toBe(false);
    expect(NAV_ITEMS.map((item) => item.to)).not.toContain("/workers");
  });

  it("removes immutable fields from release edits", async () => {
    const api = client();

    await updateRelease(api, "release-1", {
      platform: "android",
      source: "direct_apk",
      versionName: "2.0.0",
      buildNumber: 20,
      changelogEn: "Safer processing",
      storeUrl: null,
      expectedRevision: 3,
      operationId: "operation-2",
      reason: "Correct release notes",
    });

    expect(api.patch).toHaveBeenCalledWith("/admin/releases/release-1", {
      versionName: "2.0.0",
      buildNumber: 20,
      changelogEn: "Safer processing",
      storeUrl: null,
      expectedRevision: 3,
      operationId: "operation-2",
      reason: "Correct release notes",
    });
  });

  it("strips the response revision from preview and publish selections", async () => {
    const api = client();

    await previewUpdatePolicy(api, policy);
    await publishRelease(api, "release-1", {
      expectedRevision: 7,
      expectedReleaseRevision: 3,
      policy,
      operationId: "operation-3",
      reason: "Publish verified release",
      storeAvailabilityConfirmed: true,
    });

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      "/admin/update-policy/preview",
      {
        android: policy.android,
        ios: policy.ios,
      },
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      "/admin/releases/release-1/publish",
      {
        expectedRevision: 7,
        expectedReleaseRevision: 3,
        policy: { android: policy.android, ios: policy.ios },
        operationId: "operation-3",
        reason: "Publish verified release",
        storeAvailabilityConfirmed: true,
      },
    );
  });

  it("uses replacementPolicy for release withdrawal", async () => {
    const api = client();

    await withdrawRelease(api, "release-1", {
      expectedRevision: 7,
      expectedReleaseRevision: 3,
      replacementPolicy: policy,
      operationId: "operation-4",
      reason: "Withdraw compromised release",
    });

    expect(api.post).toHaveBeenCalledWith(
      "/admin/releases/release-1/withdraw",
      {
        expectedRevision: 7,
        expectedReleaseRevision: 3,
        replacementPolicy: { android: policy.android, ios: policy.ios },
        operationId: "operation-4",
        reason: "Withdraw compromised release",
      },
    );
  });

  it("exposes every backend job status and no invented status", () => {
    expect(JOB_STATUSES).toEqual([
      "awaiting_upload",
      "queued",
      "validating",
      "processing",
      "uploading_result",
      "interrupted",
      "cancel_requested",
      "ready",
      "failed",
      "cancelled",
    ]);
  });

  it("exposes only alert severities accepted by the backend", () => {
    expect(ALERT_SEVERITIES).toEqual(["warning", "critical"]);
  });

  it("uses the dedicated high-priority recovery queue contract", async () => {
    const api = client();
    const request = {
      id: "recovery-1",
      status: "pending" as const,
      reason: null,
      requestedAt: "2026-09-11T00:00:00.000Z",
      reviewedAt: null,
      reviewReason: null,
      revision: 2,
      deletionRequestId: "deletion-1",
      deletionRequestedAt: "2026-09-10T00:00:00.000Z",
      recoverUntil: "2026-12-10T00:00:00.000Z",
      user: {
        id: "user-1",
        email: null,
        displayName: "Listener",
        status: "deleting",
      },
    };
    const command = {
      expectedRevision: 2,
      operationId: "operation-recovery",
      reason: "Verified account owner request",
    };

    await getAccountRecoverySummary(api);
    await decideAccountRecoveryRequest(api, request, "approve", command);

    expect(api.get).toHaveBeenCalledWith(
      "/admin/account-recovery-requests/summary",
    );
    expect(api.post).toHaveBeenCalledWith(
      "/admin/account-recovery-requests/recovery-1/approve",
      command,
    );
  });
});
