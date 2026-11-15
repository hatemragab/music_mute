import { describe, expect, test } from "vitest";
import { messages, resolveInitialLanguage } from "./i18n";

function allText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allText);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(allText);
  return [];
}

describe("landing page language selection", () => {
  test("uses an addressable language route before saved and browser choices", () => {
    expect(resolveInitialLanguage("ar", "en", ["en-US"])).toBe("ar");
    expect(resolveInitialLanguage("en", "ar", ["ar-EG"])).toBe("en");
  });

  test("uses an explicit saved choice before the browser language", () => {
    expect(resolveInitialLanguage(null, "en", ["ar-EG"])).toBe("en");
    expect(resolveInitialLanguage(null, "ar", ["en-US"])).toBe("ar");
  });

  test("detects Arabic locale variants and otherwise falls back to English", () => {
    expect(resolveInitialLanguage(null, null, ["fr-FR", "ar-SA"])).toBe("ar");
    expect(resolveInitialLanguage(null, null, ["en-US", "ar-EG"])).toBe("en");
    expect(resolveInitialLanguage(null, null, ["en-GB", "fr-FR"])).toBe("en");
    expect(resolveInitialLanguage(null, null, ["arn"])).toBe("en");
    expect(resolveInitialLanguage("auto", "unsupported", [])).toBe("en");
  });

  test("ships complete non-empty English and Arabic copy", () => {
    const english = allText(messages.en);
    const arabic = allText(messages.ar);

    expect(english.length).toBe(arabic.length);
    expect(english.every((value) => value.trim().length > 0)).toBe(true);
    expect(arabic.every((value) => value.trim().length > 0)).toBe(true);
  });

  test("keeps direct platform actions and release boundaries explicit", () => {
    expect(messages.en.hero).toMatchObject({
      platformsLabel: "Available MusicMute platforms",
      webActionDescription: "Import, process, and manage your library",
      chromeActionDescription:
        "Voice-only playback on supported YouTube videos",
      chromeRequirement: expect.stringContaining(
        "MusicMute Local companion installed and prepared",
      ),
      pendingReleases: expect.stringContaining(
        "Mac public download and mobile store links",
      ),
    });
    expect(messages.ar.hero).toMatchObject({
      platformsLabel: "منصات ميوزك ميوت المتاحة",
      webActionDescription: "استورد الصوت وعالجه وأدر مكتبتك",
      chromeActionDescription: "تشغيل الصوت فقط في فيديوهات YouTube المدعومة",
      chromeRequirement: expect.stringContaining("MusicMute Local"),
      pendingReleases: expect.stringContaining("Mac"),
    });
  });
});
