import { expect, test } from "@playwright/test";
import { FIXTURE_IDS } from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("owner hides link import for a selected user and removes the exclusion after reload", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  fixture.settings.linkImportEnabled = true;
  fixture.settings.linkImportDisabledCountries = ["US"];
  await page.goto("/settings");
  await page.getByLabel("Hide link import for these users").fill("listener");
  await page.getByRole("button", { name: "Search users", exact: true }).click();
  await page.getByRole("checkbox", { name: /Fixture Listener/ }).check();
  if (process.env.MUSICMUTE_LINK_IMPORT_SCREENSHOT)
    await page
      .getByRole("region", { name: "User link import visibility" })
      .screenshot({ path: process.env.MUSICMUTE_LINK_IMPORT_SCREENSHOT });
  await page.getByRole("button", { name: "Review changes" }).click();
  let dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(`Hidden users: none → ${FIXTURE_IDS.user}`),
  ).toBeVisible();
  await dialog
    .getByLabel("Reason")
    .fill("Hide native links for this selected account");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Save policy" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.settings.linkImportDisabledUserIds).toEqual([
    FIXTURE_IDS.user,
  ]);
  expect(fixture.settings.linkImportEnabled).toBe(true);
  expect(fixture.settings.linkImportDisabledCountries).toEqual(["US"]);

  await page.reload();
  await page
    .getByRole("button", { name: /Remove user Fixture Listener/ })
    .click();
  await page.getByRole("button", { name: "Review changes" }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(`Hidden users: ${FIXTURE_IDS.user} → none`),
  ).toBeVisible();
  await dialog
    .getByLabel("Reason")
    .fill("Restore country and global visibility rules");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Save policy" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.settings.linkImportDisabledUserIds).toEqual([]);
  expect(fixture.settings.linkImportEnabled).toBe(true);
  expect(fixture.settings.linkImportDisabledCountries).toEqual(["US"]);
  expect(fixture.settings.revision).toBe(3);
});
