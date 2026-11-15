import { expect, test } from "@playwright/test";

import {
  createDashboardFixture,
  FIXTURE_IDS,
} from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";
import { E2E_API_ORIGIN } from "./helpers/urls";

const playListing =
  "https://play.google.com/store/apps/details?id=com.hatem.musicmute";

test("records an Android Play version without receiving a binary or editable store URL", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  await installDashboardFixture(page, fixture);
  await page.goto("/releases");
  await page.getByRole("button", { name: "Create draft" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Current release: 2.0.0 (20)")).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Distribution" }),
  ).toHaveText("Google Play");
  await expect(dialog.getByLabel("Store URL")).toHaveCount(0);
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await expect(
    dialog.getByText(/Upload the Android App Bundle in Play Console/),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: "Platform" }).click();
  await page.getByRole("option", { name: "iOS" }).click();
  await expect(dialog.getByLabel("Store URL")).toBeVisible();
  await dialog.getByRole("combobox", { name: "Platform" }).click();
  await page.getByRole("option", { name: "Android" }).click();
  await expect(dialog.getByText("Current release: 2.0.0 (20)")).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Distribution" }),
  ).toHaveText("Google Play");
  await dialog.getByLabel("English changelog").fill("Play release fixture");
  await dialog.getByLabel("Reason").fill("Record the store version");
  await dialog
    .getByRole("button", { name: "Create draft", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.releases[0]).toMatchObject({
    source: "google_play",
    storeUrl: playListing,
    versionName: "2.0.1",
    buildNumber: 21,
    artifactState: null,
  });
});

test("historical direct APK releases remain readable without actions or target selection", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  fixture.releases[0].source = "direct_apk";
  fixture.releases[0].artifactState = "verified";
  await installDashboardFixture(page, fixture);
  await page.goto("/releases");
  await expect(
    page.getByText("Retired direct APK", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "2.0.0 (20)" }).click();
  await expect(page.getByRole("heading", { name: "2.0.0 (20)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit draft" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review policy" })).toHaveCount(
    0,
  );
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.goto(`/update-policy?releaseId=${FIXTURE_IDS.release}`);
  await expect(
    page.getByText(/Retired direct APK. This release is read-only/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish release" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Withdraw with replacement" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Direct release ID")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Select release" }).click();
  await expect(page.getByRole("option", { name: /2.0.0/ })).toHaveCount(0);
  await expect(page.getByRole("option", { name: /1.0.0/ })).toBeVisible();
});

test("compiled backend rejects direct Android draft and APK upload and download routes", async ({
  request,
}) => {
  const headers = {
    authorization: "Bearer owner-fixture",
    "x-forwarded-for": "192.0.2.187",
  };
  const id = "000000000000000000000099";
  const direct = await request.post(`${E2E_API_ORIGIN}/admin/releases`, {
    headers,
    data: {
      platform: "android",
      source: "direct_apk",
      version_name: "3.0.0",
      build_number: 30,
      changelog_en: "Retired channel",
      store_url: null,
      operation_id: crypto.randomUUID(),
      reason: "Verify retired source rejection",
    },
  });
  expect(direct.status()).toBe(400);
  expect((await direct.json()).code).toBe("INVALID_REQUEST");
  const reserve = await request.post(
    `${E2E_API_ORIGIN}/admin/releases/${id}/uploads`,
    {
      headers,
      data: {
        bytes: 1024,
        sha256_hex: "a".repeat(64),
        expected_revision: 0,
        operation_id: crypto.randomUUID(),
      },
    },
  );
  expect(reserve.status()).toBe(400);
  expect(await reserve.json()).not.toHaveProperty("grant");
  const complete = await request.post(
    `${E2E_API_ORIGIN}/admin/releases/${id}/uploads/${id}/completions`,
    { headers, data: { operation_id: crypto.randomUUID() } },
  );
  expect(complete.status()).toBe(400);
  for (const route of ["", "/download-grants", "/download-redirects"]) {
    const url = `${E2E_API_ORIGIN}/app-updates/releases/${id}${route}`;
    const response = route
      ? await request.post(url, { headers, data: {}, maxRedirects: 0 })
      : await request.get(url, { headers, maxRedirects: 0 });
    expect(response.status()).toBe(404);
    expect(response.headers()).not.toHaveProperty("location");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(await response.json()).not.toHaveProperty("url");
  }
});
