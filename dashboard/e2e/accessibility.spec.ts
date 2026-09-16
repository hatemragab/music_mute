import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { FIXTURE_IDS } from "../src/test/dashboard-fixtures";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

const dashboardPages = [
  "/overview",
  "/jobs",
  `/jobs/${FIXTURE_IDS.job}`,
  "/users",
  `/users/${FIXTURE_IDS.user}`,
  "/account-recovery",
  "/releases",
  `/releases/${FIXTURE_IDS.release}`,
  "/update-policy",
  "/settings",
  "/health",
  "/activity",
  "/administrators",
] as const;

test.beforeEach(async ({ page }) => {
  await setDashboardRole(page, "owner");
  await installDashboardFixture(page);
});

test("all dashboard routes fit the supported viewport widths", async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of dashboardPages) {
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
      const overflow = await page.evaluate(() => {
        const clientWidth = document.documentElement.clientWidth;
        return {
          clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          offenders: Array.from(
            document.querySelectorAll<HTMLElement>("body *"),
          )
            .filter(
              (element) =>
                element.getBoundingClientRect().right > clientWidth + 1,
            )
            .slice(0, 5)
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              className: element.className,
              text: element.textContent?.trim().slice(0, 80),
              right: Math.round(element.getBoundingClientRect().right),
            })),
        };
      });
      expect(
        overflow.scrollWidth,
        `${path} overflows at ${width}px: ${JSON.stringify(overflow.offenders)}`,
      ).toBeLessThanOrEqual(overflow.clientWidth);
    }
  }
});

test("keyboard users can skip navigation and retain visible focus", async ({
  page,
}) => {
  await page.goto("/overview");
  await expect(
    page.getByRole("heading", { name: "Operations overview" }),
  ).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();
  await expect(page.locator(":focus-visible")).toBeVisible();
});

test("overview is accessible in both themes with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/overview");

  const chart = page.getByRole("img", {
    name: "Daily submitted, completed, failed and cancelled job counts",
  });
  await expect(chart).toBeVisible();
  await page.getByText("View chart data as a table").click();
  await expect(page.getByRole("table")).toBeVisible();

  const reducedTransition = await page
    .getByRole("link", { name: "Overview", exact: true })
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(reducedTransition)).toBeLessThanOrEqual(0.001);

  const lightResults = await new AxeBuilder({ page }).analyze();
  expect(lightResults.violations).toEqual([]);

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("heading", { name: "Operations overview" }),
  ).toBeVisible();

  const darkResults = await new AxeBuilder({ page }).analyze();
  expect(darkResults.violations).toEqual([]);
});
