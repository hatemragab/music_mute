import { describe, expect, it } from "vitest";

import { DASHBOARD_POLL_INTERVAL_MS } from "./polling";

describe("dashboard polling intervals", () => {
  it("schedules no endpoint more than three times per minute", () => {
    for (const interval of Object.values(DASHBOARD_POLL_INTERVAL_MS)) {
      expect(interval).toBeGreaterThanOrEqual(20_000);
    }
  });
});
