import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("signed-out layout stays usable in English and Arabic at target widths", async ({
  page,
}) => {
  await mkdir("test-results/screenshots", { recursive: true });
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.evaluate(() =>
      localStorage.setItem("musicmute.web.language", "en"),
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with Google" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/screenshots/auth-${width}-en.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "العربية" }).click();
    await expect(
      page.getByRole("heading", { name: "تسجيل الدخول" }),
    ).toBeVisible();
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/screenshots/auth-${width}-ar.png`,
      fullPage: true,
    });
  }
});

function wavFixture(): Buffer {
  const samples = 44_100;
  const output = Buffer.alloc(44 + samples * 4);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(2, 22);
  output.writeUInt32LE(44_100, 24);
  output.writeUInt32LE(176_400, 28);
  output.writeUInt16LE(4, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(samples * 4, 40);
  for (let index = 0; index < samples; index++) {
    const sample = Math.round(
      Math.sin((index * 2 * Math.PI * 440) / 44_100) * 8_000,
    );
    output.writeInt16LE(sample, 44 + index * 4);
    output.writeInt16LE(sample, 46 + index * 4);
  }
  return output;
}

test("high-bitrate PCM audio converts to policy-compatible AAC in installed Chrome", async ({
  page,
}) => {
  await page.goto("/tests/audio-probe.html");
  await page.locator("input[type=file]").setInputFiles({
    name: "synthetic.wav",
    mimeType: "audio/wav",
    buffer: wavFixture(),
  });
  await page.getByRole("button", { name: "Prepare selected audio" }).click();
  await expect(page.getByRole("status")).toContainText("m4a; audio/mp4;", {
    timeout: 90_000,
  });
  await expect(page.getByRole("status")).toContainText(
    /output 1\.\d\d seconds/,
  );
});

test("authenticated preview covers responsive home, jobs, library and settings in both directions", async ({
  page,
}) => {
  await mkdir("test-results/screenshots", { recursive: true });
  for (const [width, language] of [
    [390, "ar"],
    [1440, "en"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tests/preview.html");
    await page.evaluate(
      (value) => localStorage.setItem("musicmute.web.language", value),
      language,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name:
          language === "ar" ? "استوديوك أينما كنت" : "Your studio, anywhere",
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/screenshots/home-${width}-${language}.png`,
      fullPage: true,
    });
    const navigation =
      width < 700 ? page.locator(".mobile-nav") : page.locator(".sidebar");
    await navigation
      .getByRole("link", { name: language === "ar" ? "المهام" : "Jobs" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: language === "ar" ? "المهام" : "Jobs",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/screenshots/jobs-${width}-${language}.png`,
      fullPage: true,
    });
    await navigation
      .getByRole("link", { name: language === "ar" ? "المكتبة" : "Library" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: language === "ar" ? "المكتبة" : "Library",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/screenshots/library-${width}-${language}.png`,
      fullPage: true,
    });
    await navigation
      .getByRole("link", { name: language === "ar" ? "الإعدادات" : "Settings" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: language === "ar" ? "الإعدادات" : "Settings",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/screenshots/settings-${width}-${language}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
