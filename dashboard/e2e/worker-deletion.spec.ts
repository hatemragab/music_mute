import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fromWireCase, fromWireUrl } from "../src/api/wire-case";
import {
  createDashboardFixture,
  FIXTURE_IDS,
} from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("owner deletes a revoked known machine and disables its registering account", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const source = createDashboardFixture();
  source.workerMachine.registeredByUserId = source.user.id;
  source.workerMachine.status = "revoked";
  source.user.workerRegistrationAllowed = true;
  const machineRevision = source.workerMachine.revision;
  const fixture = await installDashboardFixture(page, source);
  await page.goto(`/workers/${FIXTURE_IDS.workerMachine}`);
  await page
    .getByRole("button", { name: "Delete machine", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Delete worker machine" });
  await expect(dialog).toContainText("cannot be changed");
  await expect(dialog).toContainText("allowed and will be turned off");
  await expect(dialog).toContainText("Local models and personal history stay");
  await dialog
    .getByLabel("Reason")
    .fill("Retire this synthetic Mac registration");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page).toHaveURL(/\/workers$/);
  await expect(page.getByText("No machines match")).toBeVisible();
  expect(fixture.workerDeleted).toBe(true);
  expect(fixture.user.workerRegistrationAllowed).toBe(false);
  const writes = fixture.requests.filter(
    ({ method, url }) => method === "POST" && url.endsWith("/deletions"),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toMatchObject({
    registrationUserId: fixture.user.id,
    expectedUserRevision: 1,
    expectedRevision: machineRevision,
  });
});
test("legacy deletion requires explicit account selection on a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setDashboardRole(page, "owner");
  const source = createDashboardFixture();
  source.workerMachine.registeredByUserId = null;
  source.user.workerRegistrationAllowed = true;
  const fixture = await installDashboardFixture(page, source);
  await page.goto(`/workers/${FIXTURE_IDS.workerMachine}`);
  await page
    .getByRole("button", { name: "Delete machine", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Delete worker machine" });
  await dialog.getByLabel("Reason").fill("Retire legacy registration");
  await expect(
    dialog.getByRole("button", { name: "Reauthenticate with Google" }),
  ).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "Search registration account" })
    .fill(fixture.user.email!);
  expect(
    fixture.requests.filter(
      ({ url }) => new URL(url).pathname === "/admin/users",
    ),
  ).toHaveLength(0);
  await dialog.getByRole("button", { name: "Search accounts" }).click();
  await dialog
    .getByRole("button", { name: `Select ${fixture.user.email}` })
    .click();
  await expect(dialog).toContainText("allowed and will be turned off");
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
      .violations,
  ).toEqual([]);
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
      .violations,
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page).toHaveURL(/\/workers$/);
  expect(fixture.workerDeleted).toBe(true);
});
for (const role of ["support", "viewer", "release_manager"] as const) {
  test(`${role} cannot delete a machine`, async ({ page }) => {
    await setDashboardRole(page, role);
    await installDashboardFixture(page);
    await page.goto(`/workers/${FIXTURE_IDS.workerMachine}`);
    await expect(
      page.getByRole("button", { name: "Delete machine", exact: true }),
    ).toHaveCount(0);
  });
}
test("lost deletion response remains fenced after the machine disappears", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const source = createDashboardFixture();
  source.workerMachine.registeredByUserId = source.user.id;
  const fixture = await installDashboardFixture(page, source);
  let readsAllowed = false;
  await page.route("**/admin/operations/**", async (route) => {
    if (readsAllowed) await route.fallback();
    else
      await route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        body: JSON.stringify({ code: "SERVICE_UNAVAILABLE" }),
        headers: { "access-control-allow-origin": "http://127.0.0.1:4173" },
      });
  });
  await page.route("**/deletions", async (route) => {
    const request = route.request();
    await fixture.handle({
      method: "POST",
      url: fromWireUrl(request.url()),
      token: "owner-fixture",
      body: fromWireCase(request.postDataJSON()),
    });
    await fixture.publishRealtime();
    await route.abort();
  });
  await page.goto(`/workers/${FIXTURE_IDS.workerMachine}`);
  await page
    .getByRole("button", { name: "Delete machine", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Delete worker machine" });
  await expect(dialog).toContainText("already off and will stay off");
  await dialog.getByLabel("Reason").fill("Delete with synthetic response loss");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(
    page.getByRole("button", { name: "Check deletion outcome" }),
  ).toBeVisible();
  readsAllowed = true;
  await page.getByRole("button", { name: "Check deletion outcome" }).click();
  await expect(page).toHaveURL(/\/workers$/);
  expect(
    fixture.requests.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/deletions"),
    ),
  ).toHaveLength(1);
});
