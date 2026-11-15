import { expect, test, type Locator, type Page } from "@playwright/test";

import type {
  AdminUserDevice,
  AdminUserDevicePage,
} from "../src/features/users/user-device-types";
import {
  createDashboardFixture,
  FIXTURE_IDS,
} from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

const DEVICES_PATH = `/admin/users/${FIXTURE_IDS.user}/devices`;
const OBSERVED_AT = "2026-10-09T08:00:00.000Z";

function createDevice(
  overrides: Partial<AdminUserDevice> = {},
): AdminUserDevice {
  return {
    installationId: "76070f9f-5f44-4f4c-9bd8-a451ea97250d",
    platform: "android",
    deviceModel: "Pixel 9 Pro",
    osVersion: "Android 16",
    appVersion: "1.2.3",
    buildNumber: 42,
    metadataRevision: 9,
    firstSeenAt: "2026-09-01T10:00:00.000Z",
    lastSeenAt: OBSERVED_AT,
    lastAuthenticatedAt: "2026-10-08T09:00:00.000Z",
    historyHiddenAt: "2026-10-08T11:00:00.000Z",
    sessionStatus: "signed_out",
    location: {
      country: "EG",
      continent: "AF",
      region: "Cairo Governorate",
      regionCode: "C",
      city: "Cairo",
      postalCode: "11511",
      metroCode: "530",
      timezone: "Africa/Cairo",
      latitude: "30.0444",
      longitude: "31.2357",
      source: "cloudflare",
      observedAt: OBSERVED_AT,
    },
    versionHistory: [
      {
        appVersion: "1.2.2",
        buildNumber: 41,
        metadataRevision: 8,
        observedAt: "2026-10-02T08:00:00.000Z",
      },
      {
        appVersion: "1.2.3",
        buildNumber: 42,
        metadataRevision: 9,
        observedAt: "2026-10-08T08:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function devicePage(
  items: AdminUserDevice[],
  nextCursor: string | null = null,
): AdminUserDevicePage {
  return { items, nextCursor, asOf: OBSERVED_AT };
}

async function installUserDevicesFixture(
  page: Page,
  read: (url: URL) => AdminUserDevicePage,
) {
  const fixture = createDashboardFixture();
  const original = fixture.handle.bind(fixture);
  fixture.handle = async (request) => {
    const response = await original(request);
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === DEVICES_PATH &&
      ![401, 403].includes(response.status)
    ) {
      return { status: 200, body: read(url) };
    }
    return response;
  };
  return installDashboardFixture(page, fixture);
}

function deviceField(container: Locator, label: string) {
  return container
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("..")
    .locator("dd");
}

test("user devices expose recorded details and handle unavailable browser metadata", async ({
  page,
}) => {
  await setDashboardRole(page, "support");
  const device = createDevice();
  const browserDevice = createDevice({
    installationId: "5c7948d1-ac7f-42a1-b2d0-3dd2643c3b14",
    platform: "web",
    deviceModel: null,
    osVersion: "Chrome 142",
    appVersion: "1.1.0",
    buildNumber: 38,
    metadataRevision: 1,
    lastAuthenticatedAt: null,
    historyHiddenAt: null,
    sessionStatus: "unknown",
    location: null,
    versionHistory: [],
  });
  await installUserDevicesFixture(page, () =>
    devicePage([device, browserDevice]),
  );
  await page.goto(`/users/${FIXTURE_IDS.user}`);

  const devices = page.getByRole("region", { name: "Devices", exact: true });
  const android = devices.getByRole("article", { name: "Pixel 9 Pro device" });
  await expect(
    android.getByRole("heading", { name: "Pixel 9 Pro" }),
  ).toBeVisible();
  await expect(deviceField(android, "App version")).toHaveText(
    "Version 1.2.3 · Build 42",
  );
  await expect(deviceField(android, "Country / city")).toContainText(
    "Egypt (EG)",
  );
  await expect(deviceField(android, "Country / city")).toContainText("Cairo");
  await expect(deviceField(android, "Last seen")).toContainText("2026");
  await expect(deviceField(android, "Session")).toHaveText("Signed out");
  await expect(
    android.getByText(device.installationId, { exact: true }),
  ).not.toBeVisible();
  await android.getByText("View device details", { exact: true }).click();

  const details = android.locator("details");
  for (const [label, value] of Object.entries({
    "Installation ID": device.installationId,
    Platform: "Android",
    "Device model": "Pixel 9 Pro",
    "Operating system version": "Android 16",
    "Metadata revision": "9",
    "User history visibility": "Hidden from user history",
    Country: "Egypt (EG)",
    "Continent code": "AF",
    Region: "Cairo Governorate",
    "Region code": "C",
    City: "Cairo",
    "Postal code": "11511",
    "Metro code": "530",
    Timezone: "Africa/Cairo",
    Latitude: "30.0444",
    Longitude: "31.2357",
    "Location source": "Cloudflare",
  })) {
    await expect(deviceField(details, label)).toHaveText(value);
  }
  for (const label of [
    "First seen",
    "Last recorded authentication",
    "History hidden at",
    "Location observed",
  ]) {
    await expect(deviceField(details, label)).toContainText("2026");
  }
  const history = details.getByRole("table", { name: "App version history" });
  await expect(history.locator("tbody tr")).toHaveCount(2);
  await expect(
    history.locator("tbody tr").first().getByRole("cell").nth(0),
  ).toHaveText("1.2.2");
  await expect(
    history.locator("tbody tr").first().getByRole("cell").nth(1),
  ).toHaveText("41");
  await expect(
    history.locator("tbody tr").first().getByRole("cell").nth(2),
  ).toHaveText("8");
  await expect(
    history.locator("tbody tr").last().getByRole("cell").nth(0),
  ).toHaveText("1.2.3");
  await expect(
    history.locator("tbody tr").last().getByRole("cell").nth(3),
  ).toContainText("2026");

  const browser = devices.getByRole("article", { name: "Web device" });
  await expect(
    browser.getByText("Web · Browser-profile installation"),
  ).toBeVisible();
  await expect(deviceField(browser, "Country / city")).toContainText("Unknown");
  await expect(deviceField(browser, "Session")).toHaveText("Unknown");
  await browser.getByText("View device details", { exact: true }).click();
  const browserDetails = browser.locator("details");
  await expect(deviceField(browserDetails, "Device model")).toHaveText(
    "Not available",
  );
  await expect(
    deviceField(browserDetails, "Last recorded authentication"),
  ).toHaveText("Not available");
  await expect(deviceField(browserDetails, "History hidden at")).toHaveText(
    "Not available",
  );
  await expect(
    deviceField(browserDetails, "User history visibility"),
  ).toHaveText("Visible to user");
  await expect(
    browserDetails.getByText("No connection location was recorded."),
  ).toBeVisible();
  await expect(
    browserDetails.getByText("No recorded app version changes."),
  ).toBeVisible();
  await expect(
    devices.getByText(/Last seen does not mean a device is currently online/),
  ).toBeVisible();

  // Keep the sticky shell from covering the section during a tall capture.
  const screenshotStyle =
    'header.sticky, a[href="#main-content"] { opacity: 0 !important; }';
  await devices.screenshot({
    path: "test-results/user-devices-desktop.png",
    style: screenshotStyle,
  });
  await page.setViewportSize({ width: 360, height: 900 });
  await expect(
    android.getByRole("heading", { name: "Pixel 9 Pro" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await devices.screenshot({
    path: "test-results/user-devices-mobile.png",
    style: screenshotStyle,
  });
});

test("device observations update over the shared socket without HTTP status reads", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await page.clock.install();
  let device = createDevice({
    historyHiddenAt: null,
    sessionStatus: "unknown",
  });
  const server = await installUserDevicesFixture(page, () =>
    devicePage([device]),
  );
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === DEVICES_PATH
    ) {
      reads.push(request.url());
    }
  });
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  const devices = page.getByRole("region", { name: "Devices", exact: true });
  const card = devices.getByRole("article", { name: "Pixel 9 Pro device" });
  await expect(deviceField(card, "App version")).toHaveText(
    "Version 1.2.3 · Build 42",
  );
  await expect(deviceField(card, "Session")).toHaveText("Unknown");
  await card.getByText("View device details", { exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(120_000);
  device = {
    ...device,
    appVersion: "1.3.0",
    buildNumber: 50,
    sessionStatus: "signed_out",
    location: {
      ...device.location!,
      country: "US",
      city: "New York",
      timezone: "America/New_York",
    },
  };
  await server.publishRealtime();
  await expect(deviceField(card, "App version")).toHaveText(
    "Version 1.3.0 · Build 50",
  );
  await expect(deviceField(card, "Country / city")).toContainText(
    "United States (US)",
  );
  await expect(deviceField(card, "Country / city")).toContainText("New York");
  await expect(deviceField(card, "Session")).toHaveText("Signed out");
  await expect(deviceField(card.locator("details"), "Timezone")).toHaveText(
    "America/New_York",
  );
  await page.clock.fastForward(61_000);
  await expect(deviceField(card, "App version")).toHaveText(
    "Version 1.3.0 · Build 50",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(30_000);
  expect(server.realtimeTicketCount()).toBe(1);
  expect(server.realtimeConnectionCount()).toBe(1);
  expect(reads).toEqual([]);
  await expect(devices.getByRole("button", { name: /^Refresh$/ })).toHaveCount(
    0,
  );
});

test("device cursor pages request older observations and return to the first page", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const cursor = "000000000000000000000091";
  const older = createDevice({
    installationId: "22509506-e367-4ac7-bd66-19bf7bff1f17",
    platform: "ios",
    deviceModel: "iPhone 17 Pro",
    osVersion: "iOS 26.0",
    historyHiddenAt: null,
  });
  const server = await installUserDevicesFixture(page, (url) =>
    url.searchParams.get("before") === cursor
      ? devicePage([older])
      : devicePage([createDevice()], cursor),
  );
  await page.goto(`/users/${FIXTURE_IDS.user}`);
  const devices = page.getByRole("region", { name: "Devices", exact: true });
  await expect(
    devices.getByRole("article", { name: "Pixel 9 Pro device" }),
  ).toBeVisible();
  await expect(
    devices.getByRole("button", { name: "Previous page" }),
  ).toBeDisabled();
  await devices.getByRole("button", { name: "Next page" }).click();
  await expect(
    devices.getByRole("article", { name: "iPhone 17 Pro device" }),
  ).toBeVisible();
  await expect(
    devices.getByRole("article", { name: "Pixel 9 Pro device" }),
  ).toHaveCount(0);
  await expect(
    devices.getByRole("button", { name: "Next page" }),
  ).toBeDisabled();
  expect(
    server.requests.some(({ url }) => {
      const parsed = new URL(url);
      return (
        parsed.pathname === DEVICES_PATH &&
        parsed.searchParams.get("limit") === "20" &&
        parsed.searchParams.get("before") === cursor
      );
    }),
  ).toBe(true);
  await devices.getByRole("button", { name: "Previous page" }).click();
  await expect(
    devices.getByRole("article", { name: "Pixel 9 Pro device" }),
  ).toBeVisible();
  await expect(
    devices.getByRole("article", { name: "iPhone 17 Pro device" }),
  ).toHaveCount(0);
});
