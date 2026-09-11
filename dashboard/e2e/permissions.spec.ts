import { expect, test } from "@playwright/test";

import type { AdminRole } from "../src/api/contracts";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

const expectedNavigation: Record<AdminRole, string[]> = {
  owner: [
    "Overview",
    "Workers",
    "Jobs",
    "Users",
    "Account recovery",
    "Releases",
    "Update policy",
    "Settings",
    "Health & alerts",
    "Activity",
    "Administrators",
  ],
  release_manager: ["Overview", "Releases", "Update policy"],
  worker_manager: [
    "Overview",
    "Workers",
    "Jobs",
    "Settings",
    "Health & alerts",
  ],
  support: [
    "Overview",
    "Workers",
    "Jobs",
    "Users",
    "Account recovery",
    "Settings",
  ],
  viewer: [
    "Overview",
    "Workers",
    "Jobs",
    "Releases",
    "Update policy",
    "Settings",
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

  const status = await page.evaluate(async () => {
    const response = await fetch("http://127.0.0.1:3100/api/v1/admin/access", {
      method: "POST",
      headers: {
        authorization: "Bearer support-fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        verifiedEmail: "forged@example.invalid",
        role: "owner",
        reason: "Forged UI request",
        operationId: crypto.randomUUID(),
      }),
    });
    return response.status;
  });
  expect(status).toBe(403);
});
