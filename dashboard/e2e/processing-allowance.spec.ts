import { expect, test } from "@playwright/test";
import { FIXTURE_IDS } from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("allowance increase and revocation require reasons and preserve reservations", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  await expect(page.getByText("35 min", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Temporary allowance increase" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Temporary processing allowance",
  });
  await dialog.getByLabel("Total allowance (audio minutes)").fill("120");
  const expiry = new Date(Date.now() + 86400_000);
  expiry.setMinutes(expiry.getMinutes() - expiry.getTimezoneOffset());
  await dialog
    .getByLabel("Expires at (local time)")
    .fill(expiry.toISOString().slice(0, 16));
  await dialog
    .getByLabel("Reason")
    .fill("Authorized temporary synthetic fixture increase");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Save allowance", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.processingUsage.allowanceAudioSeconds).toBe(7200);
  expect(fixture.processingUsage.reservedAudioSeconds).toBe(600);
  await page.getByRole("button", { name: "Revoke allowance override" }).click();
  const revoke = page.getByRole("dialog", {
    name: "Revoke allowance override",
  });
  await revoke.getByLabel("Reason").fill("End the synthetic exception");
  await revoke
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await revoke
    .getByRole("button", { name: "Revoke override", exact: true })
    .click();
  await expect(revoke).toHaveCount(0);
  expect(fixture.processingUsage.allowanceOverride).toBeNull();
  expect(fixture.processingUsage.reservedAudioSeconds).toBe(600);
});

test("read-only users cannot grant allowance", async ({ page }) => {
  await setDashboardRole(page, "viewer");
  await installDashboardFixture(page);
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  await expect(
    page.getByRole("button", { name: "Temporary allowance increase" }),
  ).toHaveCount(0);
});
