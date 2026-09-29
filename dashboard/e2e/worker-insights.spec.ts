import { expect, test } from "@playwright/test";
import {
  createDashboardFixture,
  FIXTURE_IDS,
} from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("owner requests a runtime snapshot and reads bounded command measurements", async ({
  page,
}, testInfo) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  fixture.workerDetail.commands = [];
  let sent: unknown;
  const original = fixture.handle.bind(fixture);
  fixture.handle = async (request) => {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/diagnostic-runs")
    ) {
      sent = request.body;
      fixture.workerDetail.commands = [
        {
          commandId: "c7ed43ba-4f5f-4531-8424-8f69fa87ddde",
          kind: "doctor",
          state: "succeeded",
          checks: ["service", "storage"],
          recipeId: null,
          iterations: null,
          requestedAt: "2026-09-29T10:00:00Z",
          expiresAt: "2026-09-29T11:00:00Z",
          completedAt: "2026-09-29T10:00:03Z",
          summary: "2 worker health checks passed",
          metrics: [
            { name: "storage.free_bytes", value: 2_000_000_000, unit: "bytes" },
            { name: "runtime.uptime_seconds", value: 120, unit: "seconds" },
          ],
          revision: 1,
        },
      ];
      return {
        status: 201,
        body: {
          commandId: fixture.workerDetail.commands[0].commandId,
          deferred: false,
          replayed: false,
        },
      };
    }
    return original(request);
  };
  await installDashboardFixture(page, fixture);
  await page.goto(`/workers/${FIXTURE_IDS.workerMachine}`);
  await expect(
    page.getByRole("region", { name: "Worker readiness" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Runtime snapshot", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Inspect machine capacity");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Request runtime snapshot", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(sent).toMatchObject({
    checks: ["service", "storage"],
    reason: "Inspect machine capacity",
    operationId: expect.any(String),
  });
  await expect(page.getByText("Scratch volume available space")).toBeVisible();
  await expect(page.getByText("2.0 GB", { exact: true })).toBeVisible();
  await expect(page.getByText("Supervisor uptime")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("worker-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("worker-narrow.png"),
    fullPage: false,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("viewer can inspect readiness but cannot request commands", async ({
  page,
}) => {
  await setDashboardRole(page, "viewer");
  await installDashboardFixture(page);
  await page.goto(`/workers/${FIXTURE_IDS.workerMachine}`);
  await expect(
    page.getByRole("region", { name: "Worker readiness" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Runtime snapshot", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Engine checks", exact: true }),
  ).toHaveCount(0);
});

test("an unresolved command disables further submissions without sending twice", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  fixture.workerDetail.commands = [];
  await installDashboardFixture(page, fixture);
  let sends = 0;
  await page.route(
    "**/admin/worker-fleet/machines/*/diagnostic-runs",
    async (route) => {
      sends++;
      await route.abort("failed");
    },
  );
  await page.goto(`/workers/${FIXTURE_IDS.workerMachine}`);
  await page
    .getByRole("button", { name: "Runtime snapshot", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Reason")
    .fill("Inspect runtime after connection loss");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Request runtime snapshot", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Command outcome is unresolved",
  );
  await expect(
    page.getByRole("button", { name: "Runtime snapshot", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Engine checks", exact: true }),
  ).toBeDisabled();
  expect(sends).toBe(1);
});
