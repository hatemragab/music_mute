import { expect, test } from "@playwright/test";

test("presents the honest primary journey and stable downloads anchor", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.headers()["content-security-policy"]).toContain(
    "style-src 'self'",
  );

  await expect(
    page.getByRole("heading", { name: "Remove the music. Keep the voice." }),
  ).toBeVisible();
  const appLinks = page.getByRole("link", { name: /open web app/i });
  await expect(appLinks.first()).toHaveAttribute(
    "href",
    "https://app.music-mute.com/",
  );
  await expect(appLinks.first()).toHaveAttribute("target", "_blank");
  await expect(appLinks.first()).toHaveAttribute("rel", "noopener noreferrer");

  await page.getByRole("link", { name: "Apps" }).click();
  await expect(page.locator("#downloads")).toBeInViewport();
  await expect(page.getByText("Release link pending")).toBeVisible();
  await expect(page.getByText("Release in preparation")).toBeVisible();

  await expect(
    page.getByRole("img", {
      name: "MusicMute import and live jobs screen on a phone",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: /MusicMute player with voice-only and original-audio switching/,
    }),
  ).toBeVisible();

  await page
    .locator("summary")
    .filter({ hasText: "How does the listening example stay in sync?" })
    .click();
  await expect(
    page.getByText(/The two public demo files use the same aligned excerpt/),
  ).toBeVisible();

  const firstWaveformBar = page.locator(".waveform span").first();
  await expect(firstWaveformBar).not.toHaveAttribute("style");
  expect(
    await firstWaveformBar.evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).height) > 0,
    ),
  ).toBe(true);
});

test("loads the checked-in original and voice-only audio", async ({ page }) => {
  await page.goto("/");

  const player = page.locator("audio");
  await expect(player).toHaveAttribute("src", "/audio/original.webm");
  await expect
    .poll(() =>
      player.evaluate((element: HTMLAudioElement) => element.duration || 0),
    )
    .toBeGreaterThan(16);
  const originalDuration = await player.evaluate(
    (element: HTMLAudioElement) => element.duration,
  );

  await page.getByRole("tab", { name: "Voice only" }).click();
  await expect(player).toHaveAttribute("src", "/audio/voice-only.mp3");
  await expect
    .poll(() =>
      player.evaluate((element: HTMLAudioElement) => element.duration || 0),
    )
    .toBeGreaterThan(16);
  const voiceDuration = await player.evaluate(
    (element: HTMLAudioElement) => element.duration,
  );

  expect(Math.abs(originalDuration - voiceDuration)).toBeLessThan(0.1);
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("switches the listening demo at the same playback position", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperties(HTMLMediaElement.prototype, {
      currentTime: {
        configurable: true,
        get() {
          return Number(
            (this as HTMLMediaElement).dataset.mockCurrentTime ?? 0,
          );
        },
        set(value: number) {
          (this as HTMLMediaElement).dataset.mockCurrentTime = String(value);
        },
      },
      duration: {
        configurable: true,
        get() {
          return 60;
        },
      },
      ended: {
        configurable: true,
        get() {
          return false;
        },
      },
      paused: {
        configurable: true,
        get() {
          return (this as HTMLMediaElement).dataset.mockPaused !== "false";
        },
      },
    });

    HTMLMediaElement.prototype.pause = function pause() {
      this.dataset.mockPaused = "true";
    };
    HTMLMediaElement.prototype.play = function play() {
      this.dataset.mockPaused = "false";
      return Promise.resolve();
    };
  });
  await page.goto("/");

  const originalTab = page.getByRole("tab", { name: "Original" });
  const voiceTab = page.getByRole("tab", { name: "Voice only" });
  const player = page.locator("audio");

  await expect(originalTab).toHaveAttribute("aria-selected", "true");
  await expect(player).toHaveAttribute("src", "/audio/original.webm");
  await player.evaluate((element) => {
    const audio = element as HTMLAudioElement;
    audio.currentTime = 12.5;
    audio.dataset.mockPaused = "false";
  });

  await originalTab.focus();
  await originalTab.press("ArrowRight");
  await expect(voiceTab).toBeFocused();
  await expect(voiceTab).toHaveAttribute("aria-selected", "true");
  await expect(player).toHaveAttribute("src", "/audio/voice-only.mp3");
  await player.evaluate((element) =>
    element.dispatchEvent(new Event("loadedmetadata")),
  );
  await expect(player).toHaveAttribute("data-mock-current-time", "12.5");
  await expect(player).toHaveAttribute("data-mock-paused", "false");

  await voiceTab.press("Home");
  await expect(originalTab).toBeFocused();
  await expect(originalTab).toHaveAttribute("aria-selected", "true");
});

test("shows a friendly status when the public demo files are unavailable", async ({
  page,
}) => {
  await page.route("**/audio/*", (route) => route.abort());
  await page.goto("/");

  await expect(
    page.getByRole("status").filter({
      hasText: "The listening example is being prepared",
    }),
  ).toBeVisible();
});

test("switches to an addressable persisted Arabic RTL experience", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Apps" }).click();
  await page.getByRole("link", { name: "English. العربية" }).click();

  await expect(page).toHaveURL(/\/ar\/#downloads$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { name: "أزل الموسيقى. واحتفظ بالصوت." }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("musicmute.landing.language.v1"),
      ),
    )
    .toBe("ar");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://music-mute.com/ar/",
  );
  await expect(
    page.locator('link[rel="alternate"][hreflang="en"]'),
  ).toHaveAttribute("href", "https://music-mute.com/");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test.describe("automatic browser-language detection", () => {
  test.use({ locale: "ar-EG" });

  test("does not turn an automatic Arabic choice into a saved override", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("musicmute.landing.language.v1"),
      ),
    ).toBeNull();
  });
});

test("fits a phone viewport and provides keyboard bypass navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});
