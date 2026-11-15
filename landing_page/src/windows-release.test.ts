import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";
import { messages, type Language } from "./i18n";

afterEach(() => vi.unstubAllGlobals());

describe("pending Windows public release", () => {
  test.each(["en", "ar"] as const)(
    "%s renders an accessible pending card with support requirements and no installer action",
    (language: Language) => {
      vi.stubGlobal("document", {
        documentElement: { dataset: { languageRoute: language } },
      });
      vi.stubGlobal("window", { localStorage: { getItem: () => null } });
      vi.stubGlobal("navigator", { languages: [language] });
      const html = renderToStaticMarkup(createElement(App));
      const card = html.match(
        /<article[^>]*aria-labelledby="windows-app-title"[^>]*>[\s\S]*?<\/article>/u,
      )?.[0];
      expect(card).toBeDefined();
      expect(card).toContain('id="windows-app-title"');
      expect(card).toContain(messages[language].appsSection.windows.title);
      expect(card).toContain(messages[language].appsSection.windows.status);
      for (const requirement of [
        "Windows 10 22H2",
        "19045",
        "Windows 11",
        "x64",
      ])
        expect(card).toContain(requirement);
      expect(card).toContain(language === "en" ? "GPU" : "معالج رسومات");
      expect(card).toContain(language === "en" ? "preparation" : "التجهيز");
      expect(card).toContain("Chrome");
      expect(card).not.toMatch(/<(?:a|button)\b|href=|download=/u);
      expect(card).not.toContain("status-live");
      expect(messages[language].appsSection.windows).not.toHaveProperty(
        "action",
      );
      expect(messages[language].appsSection.windows).not.toHaveProperty("url");
      expect(messages[language].appsSection.releaseNote).toContain("Windows");
      // Existing verified product actions and the Mac dependency remain separate.
      expect(html).toContain('href="https://app.music-mute.com/"');
      expect(html).toContain(
        "https://chromewebstore.google.com/detail/musicmute-local/",
      );
      expect(html).toContain(messages[language].appsSection.desktop.title);
      expect(messages[language].appsSection.chrome.body).toContain("Mac");
    },
  );
});
