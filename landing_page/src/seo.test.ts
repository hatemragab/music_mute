import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { messages } from "./i18n";
import { renderPage } from "./prerender";
import {
  buildStructuredData,
  pageMetadata,
  serializeStructuredData,
} from "./seo";

describe("public search documents", () => {
  test.each(["en", "ar"] as const)(
    "%s renders complete content without browser globals",
    (language) => {
      const { markup, structuredData } = renderPage(language);
      expect(markup).toContain('<main id="main-content"');
      expect(markup).toContain(messages[language].hero.lead);
      expect(markup).toContain(messages[language].hero.accent);
      expect(markup).toContain(messages[language].faqSection.items[0].question);
      expect(markup).toContain(`href="${language === "en" ? "/ar/" : "/"}"`);
      expect(markup).toContain(`hrefLang="${language === "en" ? "ar" : "en"}"`);
      expect(JSON.parse(structuredData)).toEqual(buildStructuredData(language));
    },
  );

  test.each(["en", "ar"] as const)(
    "%s metadata matches its stable URL and visible FAQ",
    (language) => {
      const html = readFileSync(
        new URL(
          language === "en" ? "../index.html" : "../ar/index.html",
          import.meta.url,
        ),
        "utf8",
      );
      expect(html).toContain(`data-language-route="${language}"`);
      expect(html).toContain(
        pageMetadata[language].title.replaceAll("&", "&amp;"),
      );
      expect(html).toContain(pageMetadata[language].description);
      expect(html).toContain(
        'name="twitter:card" content="summary_large_image"',
      );
      expect(html).toContain("/social-preview.png");
      const data = buildStructuredData(language);
      const page = data["@graph"].find((entry) =>
        Array.isArray(entry["@type"]),
      );
      expect(page?.mainEntity).toEqual(
        messages[language].faqSection.items.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      );
      expect(JSON.stringify(data)).not.toMatch(
        /aggregateRating|offers|downloadUrl|price/,
      );
    },
  );

  test("escapes HTML script delimiters in structured data", () => {
    const value = { text: "</script><script>alert(1)</script>" };
    const serialized = serializeStructuredData(value);
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual(value);
  });
});
