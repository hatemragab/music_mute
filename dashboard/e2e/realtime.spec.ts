import { expect, test } from "@playwright/test";
import {
  createDashboardFixture,
  FIXTURE_IDS,
} from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("job changes arrive as socket snapshots without HTTP status polling", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  const original = fixture.handle.bind(fixture);
  let title = "Initial pushed title";
  fixture.handle = async (request) => {
    const response = await original(request);
    if (
      new URL(request.url).pathname === `/admin/jobs/${FIXTURE_IDS.job}` &&
      request.method === "GET" &&
      response.status === 200
    ) {
      return {
        ...response,
        body: { ...(response.body as object), displayName: title },
      };
    }
    return response;
  };
  const server = await installDashboardFixture(page, fixture);
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/admin\/(jobs|overview|health|alerts|workers|account-recovery)/.test(
        request.url(),
      )
    )
      reads.push(request.url());
  });
  await page.clock.install();
  await page.goto(`/jobs/${FIXTURE_IDS.job}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  title = "Updated only through WebSocket";
  await server.publishRealtime();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  expect(reads).toEqual([]);
  await expect(page.getByRole("button", { name: /^Refresh$/ })).toHaveCount(0);
});

test("job durations update through the socket and retain clear partial labels", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  const original = fixture.handle.bind(fixture);
  await page.addInitScript(() =>
    localStorage.setItem("musicmute:theme", "dark"),
  );
  let finished = false;
  fixture.handle = async (request) => {
    const response = await original(request);
    if (
      new URL(request.url).pathname === `/admin/jobs/${FIXTURE_IDS.job}` &&
      request.method === "GET" &&
      response.status === 200
    ) {
      return {
        ...response,
        body: {
          ...(response.body as object),
          displayName: "Stage duration preview",
          status: finished ? "ready" : "processing",
          serverStageTimings: {
            totalMs: finished ? 57210 : 41000,
            totalComplete: finished,
            stages: [
              { stage: "source-download", durationMs: 4321, complete: true },
              { stage: "queue", durationMs: 348, complete: true },
              { stage: "input-validation", durationMs: 123, complete: true },
              {
                stage: "separation",
                durationMs: finished ? 42345 : 30000,
                complete: finished,
              },
              ...(finished
                ? [{ stage: "output-upload", durationMs: 5821, complete: true }]
                : []),
            ],
          },
        },
      };
    }
    return response;
  };
  const server = await installDashboardFixture(page, fixture);
  await page.goto(`/jobs/${FIXTURE_IDS.job}`);
  await expect(page.getByText("At least 30 s", { exact: true })).toBeVisible();
  await expect(page.getByText("348 ms", { exact: true })).toBeVisible();
  finished = true;
  await server.publishRealtime();
  await expect(page.getByText("42.34 s", { exact: true })).toBeVisible();
  await expect(page.getByText("5.82 s", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Partial measurement", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Refresh$/ })).toHaveCount(0);
  await page.screenshot({
    path: "test-results/stage-durations-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("42.34 s", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/stage-durations-mobile.png",
    fullPage: true,
  });
});
