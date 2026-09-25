import { expect, test } from "@playwright/test";

import type { AdminRole } from "../src/api/contracts";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";
import { E2E_API_ORIGIN } from "./helpers/urls";

const expectedNavigation: Record<AdminRole, string[]> = {
  owner: [
    "Overview",
    "Jobs",
    "Users",
    "Abuse events",
    "Account recovery",
    "Releases",
    "Update policy",
    "Settings",
    "Worker fleet",
    "Health & alerts",
    "Activity",
    "Administrators",
  ],
  release_manager: ["Overview", "Releases", "Update policy"],
  support: [
    "Overview",
    "Jobs",
    "Users",
    "Abuse events",
    "Account recovery",
    "Settings",
    "Worker fleet",
  ],
  viewer: [
    "Overview",
    "Jobs",
    "Releases",
    "Update policy",
    "Settings",
    "Worker fleet",
  ],
};

for (const [role, links] of Object.entries(expectedNavigation) as Array<
  [AdminRole, string[]]
>) {
  test(`${role} sees only approved navigation`, async ({ page }) => {
    await setDashboardRole(page, role);
    await installDashboardFixture(page);
    await page.goto("/");
    const navigation = page
      .getByRole("navigation", { name: "Primary navigation" })
      .first();
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("link")).toHaveCount(links.length);
    for (const link of links) {
      const item =
        link === "Account recovery"
          ? navigation.getByRole("link", { name: /^Account recovery/ })
          : navigation.getByRole("link", { name: link, exact: true });
      await expect(item).toBeVisible();
    }
  });
}

test("direct route and forged API request remain forbidden to support", async ({
  page,
}) => {
  await setDashboardRole(page, "support");
  await installDashboardFixture(page);
  await page.goto("/administrators");
  await expect(page.getByRole("alert")).toContainText("Not authorized");

  const status = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer support-fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        verified_email: "forged@example.invalid",
        role: "owner",
        reason: "Forged UI request",
        operation_id: crypto.randomUUID(),
      }),
    });
    return response.status;
  }, `${E2E_API_ORIGIN}/admin/access`);
  expect(status).toBe(403);
});
