import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProcessingUsagePanel } from "./processing-usage-panel";
import {
  restrictionExpiry,
  validateAccountPolicyOverride,
} from "./processing-access-validation";

describe("UTC monthly account processing usage", () => {
  it("separates used, reserved, released, and remaining seconds", () => {
    render(
      <ProcessingUsagePanel
        usage={{
          schemaVersion: 2,
          plan: "standard",
          policyRevision: 2,
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
            releasedSeconds: 300,
            remainingSeconds: 5_700,
          },
          uploads: {
            dailyGrantLimit: 30,
            dailyGrants: 2,
            dailyRemainingGrants: 28,
            dailyResetAt: "2026-09-14T00:00:00.000Z",
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
          usageRevision: 4,
          waitingJobs: 3,
          maxWaitingJobs: 3,
          processingJobs: 1,
          maxProcessingJobs: 1,
          availability: { status: "blocked", reason: "waiting_job_limit" },
          checkedAt: "2026-09-13T12:00:00Z",
          policyOverride: null,
        }}
      />,
    );
    for (const text of ["120 min", "15 min", "10 min", "5 min", "95 min"])
      expect(screen.getByText(text)).toBeInTheDocument();
    for (const text of ["2 / 30", "12 / 200", "10 / 150"])
      expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText(/shared by all installations/)).toBeInTheDocument();
  });

  it("validates optional authoritative restriction expiry", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    expect(restrictionExpiry("", now)).toBeUndefined();
    expect(restrictionExpiry("2026-09-14T12:00:00Z", now)).toBe(
      "2026-09-14T12:00:00.000Z",
    );
    expect(() => restrictionExpiry("2026-09-12T12:00:00Z", now)).toThrow();
  });

  it("allows a positive replacement with optional future expiry", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    const effective = {
      monthlyProcessingSeconds: 7_200,
      dailyUploadGrants: 30,
      monthlyUploadGrants: 200,
    };
    expect(
      validateAccountPolicyOverride(
        { monthlyProcessingSeconds: 14_400 },
        effective,
        "",
        now,
      ),
    ).toEqual([]);
    expect(
      validateAccountPolicyOverride(
        { monthlyProcessingSeconds: 0 },
        effective,
        "",
        now,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateAccountPolicyOverride(
        { monthlyProcessingSeconds: 14_400 },
        effective,
        "2026-09-12T12:00:00Z",
        now,
      ).length,
    ).toBeGreaterThan(0);
  });
});
