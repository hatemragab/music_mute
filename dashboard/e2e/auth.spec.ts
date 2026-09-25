import { expect, test } from "@playwright/test";

import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("Google admission requires a backend-approved administrator session", async ({
  page,
}) => {
  await setDashboardRole(page, null);
  await installDashboardFixture(page);
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "MusicMute Operations" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(
    page.getByRole("heading", { name: "Operations overview" }),
  ).toBeVisible();
  await expect(page.getByText("owner-fixture@example.invalid")).toBeVisible();
});

test("backend denial never renders privileged navigation", async ({ page }) => {
  await setDashboardRole(page, "owner");
  await installDashboardFixture(page);
  await page.route("**/admin/session", async (route) => {
    await route.fulfill({
      status: 403,
      headers: {
        "content-type": "application/problem+json",
        "access-control-allow-origin": "http://127.0.0.1:4173",
      },
      body: JSON.stringify({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "Denied by fixture",
        code: "FORBIDDEN",
        request_id: "fixture-request",
      }),
    });
  });
  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText("Access denied");
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }),
  ).toHaveCount(0);
});

test("sign out removes the browser session and privileged shell", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await installDashboardFixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Operations overview" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "MusicMute Operations" }),
  ).toBeVisible();
  await expect(
    page.evaluate(() => sessionStorage.getItem("musicmute:e2e-role")),
  ).resolves.toBeNull();
});
