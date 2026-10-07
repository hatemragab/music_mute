import { expect, test } from "@playwright/test";
import { createDashboardFixture } from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

for (const target of [
  {
    route: "/jobs?status=processing&cursor=page-two",
    path: "/admin/jobs",
    label: "Refresh jobs",
    live: true,
  },
  {
    route: "/workers?status=active&cursor=page-two",
    path: "/admin/worker-fleet/machines",
    label: "Refresh worker fleet",
    live: true,
  },
  {
    route: "/users?status=active&cursor=page-two",
    path: "/admin/users",
    label: "Refresh users",
    live: false,
  },
]) {
  test(`${target.label} waits for new data and keeps filters and pagination`, async ({
    page,
  }) => {
    await setDashboardRole(page, "owner");
    const fixture = createDashboardFixture();
    const original = fixture.handle.bind(fixture);
    let refreshing = false;
    let release: (() => void) | undefined;
    fixture.handle = async (request) => {
      if (
        request.method === "GET" &&
        new URL(request.url).pathname === target.path &&
        refreshing
      ) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          status: 200,
          body: {
            items: [],
            nextCursor: null,
            asOf: "2026-10-06T18:00:00.000Z",
          },
        };
      }
      return original(request);
    };
    const server = await installDashboardFixture(page, fixture);
    const httpReads: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname === target.path
      )
        httpReads.push(request.url());
    });
    await page.goto(target.route);
    await expect(page.getByRole("table")).toBeVisible();
    const button = page.getByRole("button", { name: target.label });
    await expect(button).toBeEnabled();
    refreshing = true;
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("table")).toBeVisible();
    await expect.poll(() => Boolean(release)).toBe(true);
    release!();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-busy", "false");
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
      target.route,
    );
    expect(httpReads).toHaveLength(target.live ? 0 : 2);
    expect(server.realtimeConnectionCount()).toBe(1);
    expect(server.realtimeTicketCount()).toBe(1);
    if (target.live) {
      refreshing = false;
      await server.publishRealtime();
      await expect(page.getByRole("table")).toBeVisible();
    }
    if (target.path === "/admin/worker-fleet/machines") {
      await page.getByRole("tab", { name: "Policy", exact: true }).click();
      await expect(button).toHaveCount(0);
    }
  });
}

test("invalid filters disable manual refresh", async ({ page }) => {
  await setDashboardRole(page, "owner");
  await installDashboardFixture(page);
  await page.goto("/users?query=a");
  await expect(
    page.getByRole("button", { name: "Refresh users" }),
  ).toBeDisabled();
  await page.goto("/jobs?from=2026-10-06&to=2026-10-01");
  await expect(
    page.getByRole("button", { name: "Refresh jobs" }),
  ).toBeDisabled();
});
