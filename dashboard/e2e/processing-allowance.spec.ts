import { expect, test } from "@playwright/test";
import { FIXTURE_IDS } from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("account override and clearing require reasons and preserve reservations", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  await expect(page.getByText("95 min", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add account override" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Account processing override",
  });
  await dialog.getByLabel("Monthly successful processing minutes").fill("180");
  const expiry = new Date(Date.now() + 86400_000);
  expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset());
  await dialog
    .getByLabel("Expires at (optional local time)")
    .fill(expiry.toISOString().slice(0, 16));
  await dialog
    .getByLabel("Reason")
    .fill("Authorized temporary synthetic fixture increase");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Save override", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.accountUsage.processing.limitSeconds).toBe(10_800);
  expect(fixture.accountUsage.processing.reservedSeconds).toBe(600);
  await page.getByRole("button", { name: "Clear account override" }).click();
  const revoke = page.getByRole("dialog", {
    name: "Clear account policy override",
  });
  await revoke.getByLabel("Reason").fill("End the synthetic exception");
  await revoke
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await revoke
    .getByRole("button", { name: "Clear override", exact: true })
    .click();
  await expect(revoke).toHaveCount(0);
  expect(fixture.accountUsage.policyOverride).toBeNull();
  expect(fixture.accountUsage.processing.reservedSeconds).toBe(600);
});

test("read-only users cannot create an account override", async ({ page }) => {
  await setDashboardRole(page, "viewer");
  await installDashboardFixture(page);
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  await expect(
    page.getByRole("button", { name: "Add account override" }),
  ).toHaveCount(0);
});
