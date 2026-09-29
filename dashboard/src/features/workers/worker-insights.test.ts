import { describe, expect, it } from "vitest";
import { createDashboardFixture } from "@/test/dashboard-fixtures";
import { presentWorkerMetric, workerReadiness } from "./worker-insights";

describe("worker insights", () => {
  it("distinguishes failed checks, missing values and readable resource units", () => {
    expect(
      presentWorkerMetric({
        name: "storage.free_bytes",
        value: 2_000_000_000,
        unit: "bytes",
      }),
    ).toEqual({ label: "Scratch volume available space", value: "2.0 GB" });
    expect(
      presentWorkerMetric({ name: "check.model", value: 0, unit: "boolean" })
        .value,
    ).toBe("Failed / incomplete");
    expect(
      presentWorkerMetric({
        name: "runtime.uptime_seconds",
        value: NaN,
        unit: "seconds",
      }).value,
    ).toBe("Not reported");
  });
  it("uses server observation time and reports policy/slot blockers", () => {
    const data = createDashboardFixture().workerDetail;
    data.asOf = "2026-09-29T12:00:00Z";
    data.machine.lastSeenAt = "2026-09-29T11:58:00Z";
    data.machine.desiredRevision = data.machine.appliedRevision + 1;
    data.slots = [];
    expect(workerReadiness(data).join(" ")).toMatch(/No recent worker contact/);
    expect(workerReadiness(data).join(" ")).toMatch(/Policy sync is pending/);
    expect(workerReadiness(data).join(" ")).toMatch(/No processing slots/);
  });
  it("does not guess freshness for older servers", () => {
    const data = createDashboardFixture().workerDetail;
    delete data.asOf;
    expect(workerReadiness(data)[0]).toMatch(/freshness is unknown/);
  });
  it("does not expose URLs in unknown metric names or units", () => {
    const result = presentWorkerMetric({
      name: "https://private.invalid?token=secret",
      value: 1,
      unit: "token=secret",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
