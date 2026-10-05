import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createDashboardFixture } from "../src/test/dashboard-fixtures";
import type {
  MacosRelease,
  MacosUpdateConfiguration,
} from "../src/features/macos-updates/macos-updates-api";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

const publicKey = Buffer.alloc(32, 1).toString("base64");
const defaultConfig: MacosUpdateConfiguration = {
  revision: 1,
  publicEdKey: publicKey,
  feedUrl: "https://api.music-mute.com/macos-updates/appcast.xml",
  downloadBaseUrl: "https://api.music-mute.com/macos-updates/artifacts/",
  configured: true,
  selectedReleaseId: null,
};
const release = (id: string, verified: boolean): MacosRelease => ({
  id,
  versionName: verified ? "0.1.4" : "0.1.5",
  buildNumber: verified ? "4" : "5",
  archiveName: `MusicMute-${verified ? "0.1.4-4" : "0.1.5-5"}-arm64-${"a".repeat(64)}.dmg`,
  bytes: 17_000_000,
  sha256Hex: "a".repeat(64),
  state: "draft",
  artifactState: verified ? "verified" : "awaiting_upload",
  revision: 1,
  createdAt: "2026-10-04T10:00:00Z",
  publishedAt: null,
  downloadUrl: "https://api.music-mute.com/macos-updates/artifacts/fixture.dmg",
});

function macFixture(initialConfig = defaultConfig) {
  const fixture = createDashboardFixture();
  const original = fixture.handle.bind(fixture);
  let config = { ...initialConfig };
  const releases = [release("verified", true), release("awaiting", false)];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  fixture.handle = async (request) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/admin/macos-updates")) return original(request);
    requests.push({ method: request.method, path, body: request.body });
    if (path === "/admin/macos-updates/configuration") {
      if (request.method === "PUT")
        config = {
          ...config,
          publicEdKey: (request.body as { publicEdKey: string }).publicEdKey,
          configured: true,
          selectedReleaseId: null,
          revision: config.revision + 1,
        };
      return { status: 200, body: config };
    }
    if (path === "/admin/macos-updates")
      return {
        status: 200,
        body: {
          items: releases,
          nextCursor: null,
          asOf: "2026-10-04T10:00:00Z",
        },
      };
    if (path.endsWith("/publications")) {
      const item = releases.find((item) => path.includes(`/${item.id}/`))!;
      item.state = "published";
      item.revision++;
      item.publishedAt = "2026-10-04T10:05:00Z";
      config = {
        ...config,
        selectedReleaseId: item.id,
        revision: config.revision + 1,
      };
      return {
        status: 201,
        body: {
          release: item,
          configurationRevision: config.revision,
          operationId: (request.body as { operationId: string }).operationId,
        },
      };
    }
    if (path.endsWith("/withdrawals")) {
      const item = releases.find((item) => path.includes(`/${item.id}/`))!;
      item.state = "withdrawn";
      item.revision++;
      config = {
        ...config,
        selectedReleaseId: null,
        revision: config.revision + 1,
      };
      return {
        status: 201,
        body: {
          release: item,
          configurationRevision: config.revision,
          operationId: (request.body as { operationId: string }).operationId,
        },
      };
    }
    if (path.endsWith("/completions")) {
      const item = releases.find((item) => path.includes(`/${item.id}/`))!;
      item.artifactState = "verified";
      item.revision++;
      return { status: 201, body: item };
    }
    const detail = releases.find(
      (item) => path === `/admin/macos-updates/${item.id}`,
    );
    if (detail) return { status: 200, body: detail };
    return { status: 404, body: { detail: "Fixture route missing" } };
  };
  return { fixture, requests };
}

test("owner publishes only verified Mac drafts after reason and fresh authentication", async ({
  page,
}, testInfo) => {
  await setDashboardRole(page, "owner");
  const { fixture, requests } = macFixture();
  await installDashboardFixture(page, fixture);
  await page.goto("/macos-updates");
  await expect(
    page.getByRole("heading", { name: "Mac updates", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Sparkle feed URL", { exact: true }),
  ).toHaveValue(defaultConfig.feedUrl);
  const verified = page.getByRole("row").filter({ hasText: "0.1.4 (4)" });
  const awaiting = page.getByRole("row").filter({ hasText: "0.1.5 (5)" });
  await expect(
    awaiting.getByRole("button", { name: "Publish", exact: true }),
  ).toBeDisabled();
  await verified.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toHaveCount(0);
  await dialog.getByLabel("Reason").fill("Ship notarized signed Mac update");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(verified.getByText("published", { exact: true })).toBeVisible();
  await expect(verified.getByText("In update feed")).toBeVisible();
  const publication = requests.find((request) =>
    request.path.endsWith("/publications"),
  );
  expect(publication?.body).toMatchObject({
    expectedRevision: 1,
    expectedConfigurationRevision: 1,
    reason: "Ship notarized signed Mac update",
    operationId: expect.any(String),
  });
  const reads = requests.filter((request) => request.method === "GET").length;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1200);
  expect(requests.filter((request) => request.method === "GET")).toHaveLength(
    reads,
  );
  await verified.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(dialog).toContainText(
    "Existing immutable archive downloads remain available.",
  );
  await dialog.getByLabel("Reason").fill("Pause Mac rollout");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Withdraw update", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await verified
    .getByRole("button", { name: "Republish", exact: true })
    .click();
  await dialog.getByLabel("Reason").fill("Resume qualified Mac rollout");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(verified.getByText("In update feed")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(
    page.getByRole("heading", { name: "Mac updates", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("macos-updates-desktop.png"),
    fullPage: false,
  });
  await page
    .getByRole("heading", { name: "Mac releases", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("macos-updates-desktop-releases.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(
    page.getByRole("heading", { name: "Mac updates", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("macos-updates-narrow.png"),
    fullPage: false,
  });
  await page
    .getByRole("heading", { name: "Mac releases", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("macos-updates-narrow-releases.png"),
    fullPage: false,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("owner configures and downloads the public packaging configuration", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const { fixture, requests } = macFixture({
    ...defaultConfig,
    publicEdKey: null,
    configured: false,
  });
  await installDashboardFixture(page, fixture);
  await page.goto("/macos-updates");
  const save = page.getByRole("button", {
    name: "Save public key",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await page.getByLabel("Ed25519 public key").fill(publicKey);
  await save.click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Reason")
    .fill("Configure original Sparkle signing identity");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog
    .getByRole("button", { name: "Save public key", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    requests.find((request) => request.method === "PUT")?.body,
  ).toMatchObject({
    publicEdKey: publicKey,
    expectedRevision: 1,
    reason: "Configure original Sparkle signing identity",
    operationId: expect.any(String),
  });
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download build configuration" })
    .click();
  const artifact = await download;
  expect(artifact.suggestedFilename()).toBe("musicmute-macos-updates.json");
  expect(JSON.parse(await readFile((await artifact.path())!, "utf8"))).toEqual({
    schema_version: 1,
    feed_url: defaultConfig.feedUrl,
    download_base_url: defaultConfig.downloadBaseUrl,
    public_ed_key: publicKey,
  });
});

test("viewer can inspect Mac configuration but cannot upload, configure or publish", async ({
  page,
}) => {
  await setDashboardRole(page, "viewer");
  await installDashboardFixture(page, macFixture().fixture);
  await page.goto("/macos-updates");
  await expect(page.getByLabel("Ed25519 public key")).toHaveAttribute(
    "readonly",
  );
  await expect(
    page.getByRole("button", { name: "Save public key", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Prepared DMG")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toHaveCount(0);
});

test("release manager resumes an awaiting draft after reloading the page", async ({
  page,
}) => {
  await setDashboardRole(page, "release_manager");
  await installDashboardFixture(page, macFixture().fixture);
  await page.goto("/macos-updates");
  await page.reload();
  await page
    .getByRole("row")
    .filter({ hasText: "0.1.5 (5)" })
    .getByRole("button", { name: "Resume upload" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Resume 0.1.5 (5)" }),
  ).toBeVisible();
  await expect(page.getByLabel("Prepared DMG")).toBeVisible();
  await expect(page.getByLabel("Signed appcast.xml")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save public key", exact: true }),
  ).toHaveCount(0);
});

test("a lost long verification reads the committed draft before explicitly retrying the same operation", async ({
  page,
}) => {
  await setDashboardRole(page, "release_manager");
  await installDashboardFixture(page, macFixture().fixture);
  const operationIds: string[] = [];
  await page.route(
    "**/admin/macos-updates/awaiting/completions",
    async (route) => {
      operationIds.push(route.request().postDataJSON().operation_id);
      if (operationIds.length === 1) await route.abort("failed");
      else await route.fallback();
    },
  );
  await page.goto("/macos-updates");
  await page
    .getByRole("row")
    .filter({ hasText: "0.1.5 (5)" })
    .getByRole("button", { name: "Verify upload", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check operation outcome", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Retry verification with same operation ID",
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "0.1.5 (5)" })
      .getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
  expect(operationIds).toHaveLength(2);
  expect(operationIds[0]).toBe(operationIds[1]);
});
