import { expect, test } from "@playwright/test";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("v2 policy preserves exact units, readiness and audited read-back", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  await page.goto("/settings");
  await expect(page.getByText(/Expanded admission unavailable/)).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Accept new long jobs" }),
  ).toBeDisabled();
  await page
    .getByLabel("Maximum audio duration (minutes, inclusive)")
    .fill("30");
  await page
    .getByLabel("Maximum prepared audio (decimal MB, inclusive)")
    .fill("100");
  await page.getByLabel("Maximum outstanding jobs", { exact: true }).fill("90");
  await page.getByRole("button", { name: "Review policy changes" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Save media and queue policy",
  });
  await dialog
    .getByLabel("Reason")
    .fill("Reduce reservations while retaining qualified physical limits");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Save policy", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const request = fixture.requests.find(
    (r) => r.method === "PUT" && r.url.endsWith("/processing-v2"),
  );
  expect(request?.body).toMatchObject({
    maxDurationSeconds: 1800,
    maxPreparedAudioBytes: 100000000,
    maxOutstandingJobs: 90,
    expectedRevision: 1,
    qualification: null,
  });
  expect(fixture.mediaPolicy.revision).toBe(2);
  await expect(
    page.getByLabel("Maximum outstanding jobs", { exact: true }),
  ).toHaveValue("90");
});

test("settings readers cannot change expanded policy", async ({ page }) => {
  await setDashboardRole(page, "viewer");
  await installDashboardFixture(page);
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: "Review policy changes" }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Maximum audio duration (minutes, inclusive)"),
  ).toBeDisabled();
});

test("revision conflict preserves draft and requires refreshed review", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  await page.goto("/settings");
  await page.getByLabel("Maximum outstanding jobs", { exact: true }).fill("88");
  fixture.mediaPolicy.revision = 2;
  await page.getByRole("button", { name: "Review policy changes" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Save media and queue policy",
  });
  await dialog.getByLabel("Reason").fill("A deliberate conflict fixture");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Save policy", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("revision changed");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByLabel("Maximum outstanding jobs", { exact: true }),
  ).toHaveValue("88");
  await expect(
    page.getByRole("button", { name: "Use refreshed revision for review" }),
  ).toBeVisible();
});
