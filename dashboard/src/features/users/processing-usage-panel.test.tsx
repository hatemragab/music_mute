import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProcessingUsagePanel } from "./processing-usage-panel";
import {
  suspensionExpiry,
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
          usageRevision: 4,
          activeJobs: 1,
          maxProcessingJobs: 1,
          availability: { status: "blocked", reason: "active_job_limit" },
          checkedAt: "2026-09-13T12:00:00Z",
          policyOverride: null,
        }}
      />,
    );
    for (const text of ["120 min", "15 min", "10 min", "5 min", "95 min"])
      expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText(/shared by all installations/)).toBeInTheDocument();
  });

  it("validates optional authoritative suspension expiry", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    expect(suspensionExpiry("", now)).toBeUndefined();
    expect(suspensionExpiry("2026-09-14T12:00:00Z", now)).toBe(
      "2026-09-14T12:00:00.000Z",
    );
    expect(() => suspensionExpiry("2026-09-12T12:00:00Z", now)).toThrow();
  });

  it("allows a positive replacement with optional future expiry", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    expect(validateAccountPolicyOverride(120, "", now)).toEqual([]);
    expect(validateAccountPolicyOverride(0, "", now).length).toBeGreaterThan(0);
    expect(
      validateAccountPolicyOverride(120, "2026-09-12T12:00:00Z", now).length,
    ).toBeGreaterThan(0);
  });
});
