import { expect, test } from "@playwright/test";
import { createDashboardFixture } from "../src/test/dashboard-fixtures";
import type { NotificationCampaign } from "../src/features/notifications/notifications-api";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("owner reviews a broadcast and history updates only through the socket", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  const original = fixture.handle.bind(fixture);
  let campaign: NotificationCampaign | null = null;
  let sends = 0;
  fixture.handle = async (request) => {
    if (new URL(request.url).pathname === "/admin/notifications") {
      if (request.method === "POST") {
        sends++;
        const input = request.body as {
          title: string;
          body: string;
          reason: string;
        };
        campaign = {
          ...input,
          id: "000000000000000000000099",
          actorUid: "fixture-owner",
          audience: "all_users",
          state: "queued",
          targetsFrozen: false,
          counts: { pending: 0, sent: 0, failed: 0, invalid: 0, ineligible: 0 },
          createdAt: "2026-09-29T00:00:00Z",
          completedAt: null,
        };
        return { status: 201, body: campaign };
      }
      return {
        status: 200,
        body: { items: campaign ? [campaign] : [], nextCursor: null },
      };
    }
    return original(request);
  };
  const server = await installDashboardFixture(page, fixture);
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().includes("/admin/notifications")
    )
      reads.push(request.url());
  });
  await page.goto("/notifications");
  await expect(
    page.getByRole("heading", { name: "Push notifications", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Scheduled maintenance");
  await page
    .getByLabel("Message", { exact: true })
    .fill("MusicMute will be back shortly. Thank you for your patience.");
  await page.getByRole("button", { name: "Review broadcast" }).click();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("System maintenance notice");
  await page
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await page.getByRole("button", { name: "Send broadcast" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(sends).toBe(1);
  if (!campaign) throw new Error("No campaign submitted");
  const current = campaign as NotificationCampaign;
  current.state = "completed";
  current.targetsFrozen = true;
  current.counts.sent = 24;
  await server.publishRealtime();
  await expect(
    page.getByRole("article").getByText("24", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/notifications-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/notifications-mobile.png",
    fullPage: true,
  });
  expect(reads).toEqual([]);
});
