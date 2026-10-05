import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { MUSICMUTE_DOWNLOADS_URL } from "../src/product-links";

test("signed-out layout stays usable in English and Arabic at target widths", async ({
  page,
}) => {
  await mkdir("test-results/screenshots", { recursive: true });
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const googleButton = page.getByRole("button", {
      name: "Continue with Google",
    });
    await expect(googleButton).toBeVisible();
    await expect(googleButton.locator("svg.google-mark")).toBeVisible();
    const macDownloads = page.getByRole("link", {
      name: "See macOS downloads",
    });
    await expect(macDownloads).toHaveAttribute("href", MUSICMUTE_DOWNLOADS_URL);
    await expect(macDownloads).toHaveAttribute("target", "_blank");
    await expect(macDownloads).toHaveAttribute("rel", "noopener noreferrer");
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
    await expect(
      page.getByRole("link", { name: "عرض تنزيلات macOS" }),
    ).toHaveAttribute("href", MUSICMUTE_DOWNLOADS_URL);
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
    await expect(page.locator("h1")).toBeVisible();
    await page.evaluate(
      (value) => localStorage.setItem("musicmute.web.language", value),
      language,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: language === "ar" ? "ابدأ مقطعًا جديدًا" : "Start a new track",
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
    await page.locator(".section-heading").getByRole("link").click();
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
    await expect(
      page
        .getByRole("button", {
          name: language === "ar" ? "تنزيل مقطع الصوت" : "Download Vocal track",
        })
        .first(),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: language === "ar" ? "تشغيل" : "Play",
        exact: true,
      })
      .first()
      .click();
    const miniPlayer = page.getByRole("complementary", {
      name: language === "ar" ? "المشغل" : "Player",
    });
    await expect(miniPlayer).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await miniPlayer.getByRole("link").first().click();
    await expect(
      page.getByRole("heading", {
        name: language === "ar" ? "المشغل" : "Player",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: language === "ar" ? "إضافة للمفضلة" : "Favorite",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: language === "ar" ? "حفظ الصوت الأصلي" : "Save original audio",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: language === "ar" ? "التفاصيل" : "Details",
      }),
    ).toBeVisible();
    await expect(page.getByText("6abaade2a3f12dc9ed43c129")).toHaveCount(0);
    await expect(
      page.getByText(language === "ar" ? "مقطع بدون عنوان" : "Untitled track"),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/screenshots/player-${width}-${language}.png`,
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

test("YouTube playlist share creates a single-video intent in the browser form", async ({
  page,
}) => {
  await page.goto("/tests/preview.html");
  await page
    .getByRole("textbox", { name: "Public media URL" })
    .fill(
      "https://www.youtube.com/watch?v=e6WT8RwRwt4&list=RDe6WT8RwRwt4&start_radio=1",
    );
  await page
    .getByRole("checkbox", { name: "I have the rights to process this audio" })
    .check();
  await page.getByRole("button", { name: "Start import" }).click();
  // This preview refuses mutations; the saved intent proves local admission/normalization.
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "Request failed",
  );
  const intent = await page.evaluate(() =>
    JSON.parse(
      sessionStorage.getItem("musicmute.web.import.preview-only.request") ||
        "null",
    ),
  );
  expect(intent.fingerprint).toBe(
    "https://www.youtube.com/watch?v=e6WT8RwRwt4:true",
  );
  expect(intent.requestId).toMatch(/^[a-f0-9-]{36}$/);
});

test("unsupported URL is rejected locally in the authenticated browser form", async ({
  page,
}) => {
  await page.goto("/tests/preview.html");
  await page
    .getByRole("textbox", { name: "Public media URL" })
    .fill("https://unknown.example/audio");
  await page
    .getByRole("checkbox", { name: "I have the rights to process this audio" })
    .check();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/media-imports")) requests.push(request.url());
  });
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "not supported",
  );
  expect(requests).toEqual([]);
  await expect(page.getByText(/Supported sites:/)).toContainText("Bandcamp");
});

for (const language of ["en", "ar"] as const) {
  test(`failed import can retry after reload without duplicating uncertain admission (${language})`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: language === "ar" ? 390 : 1440,
      height: 900,
    });
    await page.addInitScript((lang) => {
      localStorage.setItem("musicmute.web.language", lang);
      const key = "musicmute.web.import.preview-only";
      if (!sessionStorage.getItem(key))
        sessionStorage.setItem(
          key,
          JSON.stringify(["4123456789abcdef01234567"]),
        );
    }, language);
    const bodies: Array<{
      url: string;
      trim_enabled: boolean;
      request_id: string;
    }> = [];
    const statusReads: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().includes("/media-imports") &&
        request.method() === "GET"
      )
        statusReads.push(request.url());
    });
    await page.route("http://127.0.0.1:3000/media-imports", async (route) => {
      expect(route.request().method()).toBe("POST");
      bodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: bodies.length === 1 ? 503 : 202,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(
          bodies.length === 1
            ? { code: "SERVICE_UNAVAILABLE" }
            : {
                import_id: "6123456789abcdef01234567",
                status: "queued",
                job_id: null,
                error: null,
              },
        ),
      });
    });
    await page.goto("/tests/preview.html?import-retry");
    const retryName = language === "ar" ? "حاول مرة أخرى" : "Try again";
    const row = page.locator(".import-state");
    await expect(
      row.getByRole("button", { name: retryName, exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/screenshots/import-retry-${language}.png`,
      fullPage: true,
    });
    await row.getByRole("button", { name: retryName, exact: true }).click();
    await expect(row.getByRole("alert")).toHaveCount(2);
    expect(bodies).toHaveLength(1);
    await page.reload();
    await expect(
      row.getByRole("button", { name: retryName, exact: true }),
    ).toBeVisible();
    await row.getByRole("button", { name: retryName, exact: true }).click();
    await expect(
      row.getByRole("link", {
        name: language === "ar" ? "التفاصيل" : "Details",
      }),
    ).toHaveAttribute("href", "/jobs/5123456789abcdef01234567");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      trim_enabled: false,
    });
    expect(bodies[0].request_id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    );
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: retryName, exact: true }),
    ).toHaveCount(0);
    expect(statusReads).toEqual([]);
    expect(
      await page.evaluate(() =>
        JSON.parse(
          sessionStorage.getItem("musicmute.web.import.preview-only") || "null",
        ),
      ),
    ).toEqual(["6123456789abcdef01234567"]);
  });
}
