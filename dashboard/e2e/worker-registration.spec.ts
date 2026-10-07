import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { fromWireCase } from "../src/api/wire-case";
import {
  createDashboardFixture,
  FIXTURE_IDS,
} from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";
import { E2E_API_ORIGIN } from "./helpers/urls";

const label = "Allow this account to register worker machines";

for (const role of ["owner", "support"] as const) {
  test(`${role} approves registration and blocks only new machines`, async ({
    page,
  }) => {
    await setDashboardRole(page, role);
    const fixture = await installDashboardFixture(page);
    const originalMachine = structuredClone(fixture.workerMachine);
    await page.goto(`/users/${FIXTURE_IDS.user}`);
    const toggle = page.getByRole("switch", { name: label });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    let dialog = page.getByRole("dialog", {
      name: "Allow worker registration",
    });
    await expect(
      dialog.getByRole("button", { name: "Reauthenticate with Google" }),
    ).toBeDisabled();
    await dialog
      .getByLabel("Reason")
      .fill("Approve automatic Mac registration");
    await dialog
      .getByRole("button", { name: "Reauthenticate with Google" })
      .click();
    await dialog
      .getByRole("button", { name: "Save registration permission" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(toggle).toBeChecked();
    expect(fixture.user.workerRegistrationAllowed).toBe(true);
    expect(fixture.user.revision).toBe(2);
    expect(fixture.workerMachine).toEqual(originalMachine);

    await toggle.click();
    dialog = page.getByRole("dialog", {
      name: "Block new worker registrations",
    });
    await expect(dialog).toContainText("Existing machines keep running");
    await dialog.getByLabel("Reason").fill("Stop new Mac registrations");
    await dialog
      .getByRole("button", { name: "Reauthenticate with Google" })
      .click();
    await dialog
      .getByRole("button", { name: "Save registration permission" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    expect(fixture.workerMachine).toEqual(originalMachine);
    expect(
      fixture.requests.filter(
        ({ method, url }) =>
          method === "PUT" && url.includes("worker-registration"),
      ),
    ).toHaveLength(2);
    expect(
      fixture.requests.some(({ url }) => url.includes("invitations")),
    ).toBe(false);

    await page
      .getByRole("link", { name: "Manage registered machines" })
      .click();
    await expect(page.getByRole("tab", { name: "Machines" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Policy" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Enrollment" })).toHaveCount(0);
  });
}

for (const role of ["viewer", "release_manager"] as const) {
  test(`${role} cannot forge registration approval`, async ({ page }) => {
    await setDashboardRole(page, role);
    const fixture = await installDashboardFixture(page);
    await page.goto(`/users/${FIXTURE_IDS.user}`);
    await expect(page.getByRole("alert")).toContainText("Not authorized");
    const status = await page.evaluate(
      async ({ origin, role, userId }) => {
        const response = await fetch(
          `${origin}/admin/users/${userId}/worker-registration`,
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${role}-fixture`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              worker_registration_allowed: true,
              expected_revision: 1,
              operation_id: crypto.randomUUID(),
              reason: "Forged approval",
            }),
          },
        );
        return response.status;
      },
      { origin: E2E_API_ORIGIN, role, userId: FIXTURE_IDS.user },
    );
    expect(status).toBe(403);
    expect(fixture.user.workerRegistrationAllowed).toBe(false);
  });
}

test("lost approval response reconciles its receipt and never repeats the write", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  let committed = false;
  await page.route(
    "**/admin/users/*/worker-registration",
    async (route, request) => {
      if (request.method() !== "PUT" || committed) {
        await route.fallback();
        return;
      }
      committed = true;
      await fixture.handle({
        method: "PUT",
        url: request.url(),
        token: "owner-fixture",
        body: fromWireCase(request.postDataJSON()),
      });
      await route.abort("connectionreset");
    },
  );
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  await page.getByRole("switch", { name: label }).click();
  const dialog = page.getByRole("dialog", {
    name: "Allow worker registration",
  });
  await dialog.getByLabel("Reason").fill("Verify receipt recovery");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Save registration permission" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("switch", { name: label })).toBeChecked();
  expect(
    fixture.requests.filter(
      ({ method, url }) =>
        method === "PUT" && url.includes("worker-registration"),
    ),
  ).toHaveLength(1);
  expect(
    fixture.requests.some(({ url }) => url.includes("/admin/operations/")),
  ).toBe(true);
});

test("committed approval with a failed user read stays fenced until its outcome is checked", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  let failedRead = false;
  await page.route(`**/admin/users/${FIXTURE_IDS.user}`, async (route) => {
    if (fixture.user.workerRegistrationAllowed && !failedRead) {
      failedRead = true;
      await route.fulfill({
        status: 429,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Too Many Requests",
          status: 429,
          detail: "Fixture user read is temporarily unavailable.",
          code: "RATE_LIMITED",
        }),
      });
      return;
    }
    await route.fallback();
  });
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  const toggle = page.getByRole("switch", { name: label });
  await toggle.click();
  const dialog = page.getByRole("dialog", {
    name: "Allow worker registration",
  });
  await dialog.getByLabel("Reason").fill("Verify committed read-back failure");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Save registration permission" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  expect(fixture.user.workerRegistrationAllowed).toBe(true);
  await page.getByRole("button", { name: "Check operation outcome" }).click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  expect(
    fixture.requests.filter(
      ({ method, url }) =>
        method === "PUT" && url.includes("worker-registration"),
    ),
  ).toHaveLength(1);
});

test("registration state and machine provenance fit a narrow viewport and remain accessible", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  fixture.user.workerRegistrationAllowed = true;
  fixture.user.status = "disabled";
  fixture.workerMachine.registeredByUserId = FIXTURE_IDS.user;
  await installDashboardFixture(page, fixture);
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  await expect(page.getByRole("switch", { name: label })).toBeChecked();
  await expect(page.getByRole("switch", { name: label })).toBeDisabled();
  await expect(
    page.getByText(/existing machines are unaffected/),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 360);

  await page.goto(`/workers/${FIXTURE_IDS.workerMachine}`);
  await expect(page.getByText("Registered through account")).toBeVisible();
  await expect(
    page.getByRole("link", { name: FIXTURE_IDS.user }),
  ).toHaveAttribute("href", `/users/${FIXTURE_IDS.user}`);
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 360);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const slots = page.getByRole("table", { name: "Worker slots" });
  await slots.focus();
  await expect(slots).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => slots.evaluate((table) => table.parentElement?.scrollLeft ?? 0))
    .toBeGreaterThan(0);
});
