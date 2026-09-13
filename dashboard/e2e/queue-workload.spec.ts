import { expect, test } from "@playwright/test";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("queue presents reserved workload and nullable wait truthfully", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await installDashboardFixture(page);
  await page.goto("/jobs");
  await expect(
    page.getByRole("heading", { name: "Queue workload" }),
  ).toBeVisible();
  await expect(page.getByText("31 min", { exact: true })).toBeVisible();
  await expect(page.getByText("32 min", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Unavailable", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/Cancellation stays pending/)).toBeVisible();
  await expect(page.getByLabel("Filter job status")).toBeVisible();
});
