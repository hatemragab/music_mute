import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessingUsagePanel } from "./processing-usage-panel";
import {
  validateAllowance,
  suspensionExpiry,
} from "./processing-access-validation";

describe("account processing allowance", () => {
  it("keeps used and unfinished reservations separate", () => {
    render(
      <ProcessingUsagePanel
        usage={{
          revision: 4,
          policyRevision: 2,
          allowanceAudioSeconds: 3600,
          usedAudioSeconds: 900,
          reservedAudioSeconds: 600,
          remainingAudioSeconds: 2100,
          activeJobs: 1,
          maxActiveJobs: 1,
          nextReplenishmentAt: null,
          replenishments: [],
          availability: "busy",
          checkedAt: "2026-09-13T12:00:00Z",
          allowanceOverride: null,
        }}
      />,
    );
    for (const text of ["15 min", "10 min", "35 min"])
      expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText(/holds remain reserved/)).toBeInTheDocument();
  });
  it("validates optional authoritative suspension expiry", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    expect(suspensionExpiry("", now)).toBeUndefined();
    expect(suspensionExpiry("2026-09-14T12:00:00Z", now)).toBe(
      "2026-09-14T12:00:00.000Z",
    );
    expect(() => suspensionExpiry("2026-09-12T12:00:00Z", now)).toThrow();
  });
  it("requires bounded allowance and future expiry", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    expect(validateAllowance(120, "2026-09-14T12:00:00Z", now)).toEqual([]);
    expect(validateAllowance(59, "", now).length).toBeGreaterThan(0);
    expect(
      validateAllowance(120, "2026-09-12T12:00:00Z", now).length,
    ).toBeGreaterThan(0);
  });
});
