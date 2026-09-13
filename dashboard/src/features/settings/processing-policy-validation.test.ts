import { describe, expect, it } from "vitest";
import { DashboardFixture } from "@/test/dashboard-fixtures";
import {
  emptyQualification,
  validatePolicyDraft,
} from "./processing-policy-validation";

describe("policy command validation", () => {
  it("accepts inclusive 30 minute and 100 decimal MB ceilings", () => {
    const policy = new DashboardFixture().mediaPolicy;
    expect(validatePolicyDraft(policy)).toEqual([]);
    expect(
      validatePolicyDraft({ ...policy, maxDurationSeconds: 1801 }),
    ).not.toEqual([]);
    expect(
      validatePolicyDraft({ ...policy, maxPreparedAudioBytes: 100000001 }),
    ).not.toEqual([]);
    expect(
      validatePolicyDraft({ ...policy, maxActiveJobsPerUser: 2 as 1 }),
    ).not.toEqual([]);
  });
  it("does not invent missing evidence or permit stale qualification", () => {
    const policy = new DashboardFixture().mediaPolicy;
    expect(
      validatePolicyDraft({
        ...policy,
        qualification: { ...emptyQualification },
      }).length,
    ).toBeGreaterThan(5);
    const q = {
      ...emptyQualification,
      evidenceReference: "synthetic-unit-only",
      compatibilityRevision: "test",
      costModelRevision: "test",
      measuredAt: "2026-09-13T00:00:00Z",
      expiresAt: "2026-09-14T00:00:00Z",
      qualifiedWorkerIds: ["test-worker"],
      maxLocalSourceBytes: 1,
      maxSourceDownloadBytes: 1,
      maxPreparationSeconds: 1,
      maxSourceDownloadSeconds: 1,
      maxOutputBytes: 1,
      probeTimeoutSeconds: 1,
      processingTimeoutSeconds: 1,
      maxOutstandingEstimatedWorkerSeconds: 1,
      referenceProcessingSecondsPerAudioSecond: 1,
      fixedJobOverheadSeconds: 0,
    };
    expect(
      validatePolicyDraft(
        { ...policy, qualification: q },
        new Date("2026-09-13T12:00:00Z"),
      ),
    ).toEqual([]);
    expect(
      validatePolicyDraft(
        { ...policy, qualification: q },
        new Date("2026-09-15T12:00:00Z"),
      ),
    ).not.toEqual([]);
    expect(
      validatePolicyDraft(
        { ...policy, qualification: q },
        new Date("2026-09-15T12:00:00Z"),
        q,
      ),
    ).toEqual([]);
    expect(
      validatePolicyDraft(
        {
          ...policy,
          qualification: {
            ...q,
            qualifiedWorkerIds: ["test-worker", "test-worker"],
          },
        },
        new Date("2026-09-13T12:00:00Z"),
      ),
    ).not.toEqual([]);
  });
});
