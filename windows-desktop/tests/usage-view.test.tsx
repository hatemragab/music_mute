// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { UsagePanel } from "../src/renderer/usage-view.js";
import { setLanguage } from "../src/renderer/i18n.js";
import { parseUsage } from "../src/main/usage/presentation.js";
import { processingUsage } from "./realtime-fixtures.js";
import type { AccountUsageView } from "../src/shared/usage-contracts.js";
const current = (patch: Partial<AccountUsageView> = {}): AccountUsageView => ({
  connection: "live",
  authenticated: true,
  libraryReady: false,
  usageState: "current",
  usage: parseUsage(processingUsage()),
  policyState: "unavailable",
  policy: null,
  errorCode: null,
  ...patch,
});
afterEach(() => {
  cleanup();
  setLanguage("en");
});
it("shows actual usage quantities, reset and accessible percent separately from Library readiness", () => {
  render(<UsagePanel view={current()} />);
  expect(screen.getByText("100 seconds")).toBeTruthy();
  expect(screen.getByText("1,000 seconds")).toBeTruthy();
  expect(screen.getByText("14 min 40 sec")).toBeTruthy();
  expect(screen.getByLabelText("10% of the cloud allowance used")).toBeTruthy();
  expect(screen.getByText(/Library synchronization/)).toBeTruthy();
  expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-11-01T00:00:00.000Z",
  );
  expect(screen.queryByRole("button")).toBeNull();
});
it("distinguishes signed-out, loading, unavailable, stale and overdue reset without claiming a client reset", () => {
  const { rerender } = render(
    <UsagePanel view={current({ authenticated: false })} />,
  );
  expect(
    screen.getByText("Sign in to view your cloud allowance."),
  ).toBeTruthy();
  expect(screen.queryByText("100 seconds")).toBeNull();
  rerender(
    <UsagePanel view={current({ usageState: "loading", usage: null })} />,
  );
  expect(screen.getByText("Loading cloud usage…")).toBeTruthy();
  rerender(
    <UsagePanel view={current({ usageState: "unavailable", usage: null })} />,
  );
  expect(screen.getByText(/Local processing remains available/)).toBeTruthy();
  rerender(
    <UsagePanel
      view={current({
        connection: "reconnecting",
        usageState: "stale",
        usage: {
          ...parseUsage(processingUsage()),
          resetOverdue: true,
          availability: "blocked",
        },
      })}
    />,
  );
  expect(screen.getByText(/Showing previous usage/)).toBeTruthy();
  expect(screen.getByText(/Waiting for current account data/)).toBeTruthy();
  expect(screen.getByText("Reconnecting…")).toBeTruthy();
});
it("localizes Arabic labels, quantities and RTL with zero allowance and no hidden command controls", () => {
  setLanguage("ar");
  const usage = {
    ...parseUsage(processingUsage()),
    usedSeconds: 0,
    remainingSeconds: 0,
    limitSeconds: 0,
    usedPercent: 0,
  };
  render(<UsagePanel view={current({ usage })} />);
  expect(
    screen
      .getByRole("region", { name: "استخدام المعالجة السحابية" })
      .getAttribute("dir"),
  ).toBe("rtl");
  expect(screen.getByText("المتبقي")).toBeTruthy();
  expect(screen.getByLabelText(/من الحصة السحابية مستخدم/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
