import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const artwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#203857"/><stop offset=".6" stop-color="#bb8176"/><stop offset="1" stop-color="#efb877"/></linearGradient></defs>
  <path fill="url(#sky)" d="M0 0h640v360H0z"/><circle cx="405" cy="126" r="44" fill="#ffe0a0"/>
  <path fill="#4e5368" d="m0 213 42-15 35 9 48-25 32 23 46-39 24 31 51-16 24 32 43-35 39 30 26-19 63 35 37-16 50 24 43-14 42 22v113H0z"/>
  <path fill="#172533" d="M0 280h34v-65h34v38h36v-82h49v60h28v-33h39v-74h41v101h35v-54h45v80h43v-108h44v66h30v-48h39v87h29v-111h43v133h39v-63h30v153H0z"/>
  <path stroke="#ecc387" stroke-width="5" stroke-dasharray="4 11" opacity=".8" d="M116 192h22m85-47h24m150 15h18m128 4h16M116 210h22m85-47h24m150 15h18m128 4h16M116 228h22m85-47h24m150 15h18m128 4h16"/>
  <path fill="#0d1923" d="M0 321q174-28 324-1t316-8v48H0z"/>
</svg>`;

test("Now playing, mini player, Library and Up Next share safe rounded artwork and recover loading, errors and track switches in English and Arabic", async ({
  page,
}) => {
  await mkdir("test-results/screenshots", { recursive: true });
  await page.addInitScript(() => {
    // Fixture playback sets player state without any media/API/provider request.
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      configurable: true,
      get() {
        return this.getAttribute("data-fixture-src") ?? "";
      },
      set(value: string) {
        this.setAttribute("data-fixture-src", value);
      },
    });
    HTMLMediaElement.prototype.load = () => {};
    HTMLMediaElement.prototype.play = function () {
      this.dispatchEvent(new Event("durationchange"));
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      this.dispatchEvent(new Event("pause"));
    };
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get: () => 190,
    });
  });
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://media.example.invalid/"))
      mediaRequests.push(request.url());
  });
  let imageGate = Promise.resolve();
  let releaseImage = () => {};
  await page.route("https://i.ytimg.com/**", async (route) => {
    if (route.request().url().includes("/jNQXAC9IVRw/")) {
      await imageGate;
      await route.fulfill({ contentType: "image/svg+xml", body: artwork });
    } else await route.abort();
  });

  for (const [width, language] of [
    [1440, "en"],
    [390, "ar"],
  ] as const) {
    imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tests/preview.html?player-thumbnails&lang=${language}`);
    await page.evaluate((value) => {
      localStorage.clear();
      localStorage.setItem("musicmute.web.language", value);
    }, language);
    await page.reload();
    const navigation = page.locator(width < 700 ? ".mobile-nav" : ".sidebar");
    const libraryLink = navigation.getByRole("link", {
      name: language === "ar" ? "المكتبة" : "Library",
      exact: true,
    });
    await libraryLink.click();
    const song = page
      .locator(".library-item")
      .filter({ hasText: "City lights" });
    await expect(song.locator(".library-cover svg")).toBeVisible();
    await song
      .getByRole("button", {
        name: language === "ar" ? "تشغيل" : "Play",
        exact: true,
      })
      .click();
    await expect(page.locator(".mini-cover svg")).toBeVisible();
    await expect(page.locator(".mini-cover img")).not.toHaveClass(/loaded/);
    await page.locator(".mini-meta a").click();
    await expect(page.locator(".player-art svg")).toBeVisible();
    await expect(page.locator(".player-art img")).not.toHaveClass(/loaded/);
    await page.screenshot({
      path: `test-results/screenshots/player-thumbnail-loading-${width}-${language}.png`,
      fullPage: true,
    });
    releaseImage();
    const image = page.locator(".player-art img.loaded");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute(
      "src",
      "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    );
    await expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(image).toHaveAttribute("loading", "eager");
    await expect(page.locator(".player-art svg")).toHaveCount(0);
    await expect(
      page.locator(".queue-track").first().locator("img.loaded"),
    ).toHaveCount(1);
    expect(
      await page
        .locator(".player-art")
        .evaluate((element) => getComputedStyle(element).borderRadius),
    ).toBe("24px");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/screenshots/player-thumbnail-${width}-${language}.png`,
      fullPage: true,
    });

    await page
      .locator(".queue-track")
      .filter({ hasText: "Second take" })
      .click();
    await expect(page.locator(".player-title")).toHaveText("Second take");
    await expect(page.locator(".player-art img")).toHaveCount(0);
    await expect(page.locator(".player-art svg")).toBeVisible();
    await page.screenshot({
      path: `test-results/screenshots/player-thumbnail-error-${width}-${language}.png`,
      fullPage: true,
    });
    await page.locator(".queue-track").first().click();
    await expect(page.locator(".player-art img.loaded")).toHaveAttribute(
      "src",
      "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    );
    await page
      .locator(".queue-track")
      .filter({
        hasText: language === "ar" ? "مقطع بدون عنوان" : "Untitled track",
      })
      .click();
    await expect(page.locator(".player-art img")).toHaveCount(0);
    await expect(page.locator(".player-art svg")).toBeVisible();
    await page.locator(".queue-track").first().click();
    await libraryLink.click();
    await expect(page.locator(".mini-cover img.loaded")).toBeVisible();
    await expect(song.locator(".library-cover img.loaded")).toBeVisible();
    expect(
      await song
        .locator(".library-cover")
        .evaluate((element) => getComputedStyle(element).borderRadius),
    ).toBe("14px");
    expect(
      await page
        .locator(".mini-cover")
        .evaluate((element) => getComputedStyle(element).borderRadius),
    ).toBe("10px");
    await page.screenshot({
      path: `test-results/screenshots/library-player-thumbnail-${width}-${language}.png`,
      fullPage: true,
    });
  }
  expect(mediaRequests).toEqual([]);
});
