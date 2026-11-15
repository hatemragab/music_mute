import { describe, expect, it } from "vitest";
import type { AccountPolicyDraft } from "./processing-settings-form";
import { validateAccountPolicy } from "./processing-settings-form";

const valid: AccountPolicyDraft = {
  acceptNewJobs: true,
  linkImportEnabled: false,
  linkImportDisabledCountries: [],
  linkImportDisabledUserIds: [],
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

  it("accepts unique canonical account IDs and rejects duplicates, malformed IDs and excess selections", () => {
    const id = "1234567890abcdef12345678";
    expect(
      validateAccountPolicy({ ...valid, linkImportDisabledUserIds: [id] }),
    ).toEqual([]);
    for (const ids of [
      [id, id],
      [id.toUpperCase()],
      [`${id}\n`],
      ["not-an-account"],
      Array.from({ length: 1_001 }, (_, index) =>
        index.toString(16).padStart(24, "0"),
      ),
    ]) {
      expect(
        validateAccountPolicy({ ...valid, linkImportDisabledUserIds: ids }),
      ).toContain(
        "Choose up to 1,000 unique account IDs for link import visibility.",
      );
    }
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
