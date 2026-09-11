import { describe, expect, it } from "vitest";

import {
  type ProcessingSettingsDraft,
  validateProcessingSettings,
} from "./processing-settings-form";

const valid: ProcessingSettingsDraft = {
  acceptNewJobs: true,
  maintenanceMessageEn: "",
  maintenanceMessageAr: null,
  maxInputBytesExclusive: 30_000_000,
  maxDurationSecondsExclusive: 600,
  maxActiveJobsPerUser: null,
};

describe("validateProcessingSettings", () => {
  it("accepts the documented exclusive ceilings and null as unlimited", () => {
    expect(validateProcessingSettings(valid)).toEqual([]);
  });

  it("rejects out-of-range numbers and requires English maintenance text when paused", () => {
    expect(
      validateProcessingSettings({
        ...valid,
        acceptNewJobs: false,
        maxInputBytesExclusive: 30_000_001,
        maxDurationSecondsExclusive: 0,
        maxActiveJobsPerUser: 0,
      }),
    ).toEqual([
      "Input bytes must be an integer from 2 through 30,000,000.",
      "Duration must be greater than 0 and at most 600 seconds.",
      "Active jobs must be Unlimited or an integer from 1 through 100.",
      "An English maintenance message is required while admissions are paused.",
    ]);
  });
});
