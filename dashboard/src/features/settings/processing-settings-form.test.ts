import { describe, expect, it } from "vitest";
import type { AccountPolicyDraft } from "./processing-settings-form";
import { validateAccountPolicy } from "./processing-settings-form";

const valid: AccountPolicyDraft = {
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
};

describe("validateAccountPolicy", () => {
  it("accepts the documented standard launch policy", () => {
    expect(validateAccountPolicy(valid)).toEqual([]);
  });

  it("rejects unsafe numeric relationships and requires pause copy", () => {
    expect(
      validateAccountPolicy({
        ...valid,
        acceptNewJobs: false,
        values: {
          ...valid.values,
          monthlyProcessingSeconds: 0,
          signedUrlTtlSeconds: 601,
          dailyUploadGrants: 201,
          monthlyServiceOutboundBytes: 1,
        },
      }),
    ).toEqual([
      "Successful processing seconds / UTC month has an invalid value.",
      "Signed URL validity seconds has an invalid value.",
      "Monthly upload grants cannot be lower than daily grants.",
      "The service outbound ceiling cannot be below the account download estimate.",
      "An English maintenance message is required while admissions are paused.",
    ]);
  });
});
