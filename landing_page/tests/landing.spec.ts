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
  const hero = page.locator(".hero");
  const platformNavigation = hero.getByRole("navigation", {
    name: "Available MusicMute platforms",
  });
  const heroActions = platformNavigation.locator(".hero-direct-action");
  const heroWebLink = heroActions.nth(0);
  const heroChromeLink = heroActions.nth(1);
  await expect(
    page.locator(".site-header").getByRole("link", { name: /open web app/i }),
  ).toHaveCount(0);
  await expect(heroActions).toHaveCount(2);
  await expect(heroWebLink).toContainText("Open web app");
  await expect(heroWebLink).toHaveAttribute(
    "href",
    "https://app.music-mute.com/",
  );
  await expect(heroWebLink).toHaveAttribute("target", "_blank");
  await expect(heroWebLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(heroChromeLink).toContainText("Add to Chrome");
  await expect(heroChromeLink).toHaveAttribute(
    "href",
    "https://chromewebstore.google.com/detail/musicmute-local/acmgefmmndomcpdlgnafkjbgobinllep",
  );
  await expect(heroChromeLink).toHaveAttribute("target", "_blank");
  await expect(heroChromeLink).toHaveAttribute("rel", "noopener noreferrer");
  const webActionBox = await heroWebLink.boundingBox();
  const chromeActionBox = await heroChromeLink.boundingBox();
  expect(webActionBox).not.toBeNull();
  expect(chromeActionBox).not.toBeNull();
  expect(Math.abs(webActionBox!.y - chromeActionBox!.y)).toBeLessThanOrEqual(1);
  await expect(hero.locator(".hero-availability-notes p")).toHaveText([
    "Chrome requires the separate MusicMute Local companion installed and prepared on a supported Apple silicon Mac.",
    "Mac public download and mobile store links will appear after release verification.",
  ]);

  await page.getByRole("link", { name: "Apps" }).click();
  const downloads = page.locator("#downloads");
  await expect(downloads).toBeInViewport();
  await expect(downloads.locator(".app-card")).toHaveCount(5);
  await expect(page.getByText("Release link pending")).toBeVisible();
  await expect(page.getByText("Public release pending").first()).toBeVisible();
  const chromeLink = downloads.getByRole("link", { name: "Add to Chrome" });
  const chromeCard = chromeLink.locator("xpath=ancestor::article");
  await expect(chromeCard.getByText("Available now")).toBeVisible();
  await expect(chromeLink).toHaveAttribute(
    "href",
    "https://chromewebstore.google.com/detail/musicmute-local/acmgefmmndomcpdlgnafkjbgobinllep",
  );
  await expect(chromeLink).toHaveAttribute("target", "_blank");
  await expect(chromeLink).toHaveAttribute("rel", "noopener noreferrer");

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
  const arabicHero = page.locator(".hero");
  const arabicActions = arabicHero
    .getByRole("navigation", { name: "منصات ميوزك ميوت المتاحة" })
    .locator(".hero-direct-action");
  await expect(arabicActions).toHaveCount(2);
  await expect(arabicActions.nth(0)).toContainText("افتح تطبيق الويب");
  await expect(arabicActions.nth(0)).toHaveAttribute(
    "href",
    "https://app.music-mute.com/",
  );
  await expect(arabicActions.nth(1)).toContainText("إضافة إلى Chrome");
  await expect(arabicActions.nth(1)).toHaveAttribute(
    "href",
    "https://chromewebstore.google.com/detail/musicmute-local/acmgefmmndomcpdlgnafkjbgobinllep",
  );
  for (const action of [arabicActions.nth(0), arabicActions.nth(1)]) {
    await expect(action).toHaveAttribute("target", "_blank");
    await expect(action).toHaveAttribute("rel", "noopener noreferrer");
  }
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
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test.describe("stable language URLs", () => {
  test.use({ locale: "ar-EG" });

  test("keeps the English URL English for an Arabic browser", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("musicmute.landing.language.v1"),
      ),
    ).toBeNull();
  });
});

test("hydrates the pre-rendered page without replacing its content or reporting errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() =>
    localStorage.setItem("musicmute.landing.language.v1", "ar"),
  );
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("tab", { name: "Voice only" }).click();
  await expect(page.locator("audio")).toHaveAttribute(
    "src",
    "/audio/voice-only.mp3",
  );
  expect(errors).toEqual([]);
});

test.describe("content without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  for (const [path, language, heading] of [
    ["/", "en", "Remove the music. Keep the voice."],
    ["/ar/", "ar", "أزل الموسيقى. واحتفظ بالصوت."],
  ]) {
    test(`renders ${language} product copy, navigation and questions`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      const languageLink = page.locator(".language-button");
      await expect(languageLink).toHaveAttribute(
        "href",
        language === "en" ? "/ar/" : "/",
      );
      await page.locator("summary").first().click();
      await expect(page.locator("details").first()).toHaveAttribute("open", "");
      await languageLink.click();
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        language === "en" ? "ar" : "en",
      );
    });
  }
});

test("fits a phone viewport and provides keyboard bypass navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const directActions = page.locator(".hero-direct-action");
  await expect(directActions).toHaveCount(2);
  const firstActionBox = await directActions.nth(0).boundingBox();
  const secondActionBox = await directActions.nth(1).boundingBox();
  expect(firstActionBox).not.toBeNull();
  expect(secondActionBox).not.toBeNull();
  expect(secondActionBox!.y).toBeGreaterThanOrEqual(
    firstActionBox!.y + firstActionBox!.height,
  );
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
