import { messages, type Language } from "./i18n";
import { PRODUCT_LINKS } from "./product-links";

export const pageMetadata = {
  en: {
    title: "Remove Background Music & Keep the Voice | MusicMute",
    description:
      "Remove background music from audio and keep speech or vocals with MusicMute. Import a compatible audio file or supported public link, then play, save or share the voice-only result.",
    imageAlt: "MusicMute: remove background music and keep the voice",
  },
  ar: {
    title: "إزالة الموسيقى من الصوت مع الاحتفاظ بالكلام | ميوزك ميوت",
    description:
      "أزل الموسيقى الخلفية واحتفظ بالكلام أو الغناء مع ميوزك ميوت. استورد ملفاً صوتياً متوافقاً أو رابطاً عاماً مدعوماً، ثم شغّل النتيجة الصوتية واحفظها أو شاركها.",
    imageAlt: "ميوزك ميوت: إزالة الموسيقى الخلفية والاحتفاظ بالصوت",
  },
} satisfies Record<
  Language,
  { title: string; description: string; imageAlt: string }
>;

export function buildStructuredData(language: Language) {
  const site = PRODUCT_LINKS.canonicalSite;
  const url = language === "ar" ? new URL("ar/", site).href : site;
  const metadata = pageMetadata[language];

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${site}#organization`,
        name: "MusicMute",
        url: site,
        logo: new URL("favicon.svg", site).href,
      },
      {
        "@type": "WebSite",
        "@id": `${site}#website`,
        name: "MusicMute",
        url: site,
        inLanguage: ["en", "ar"],
        publisher: { "@id": `${site}#organization` },
      },
      {
        "@type": ["WebPage", "FAQPage"],
        "@id": `${url}#webpage`,
        url,
        name: metadata.title,
        description: metadata.description,
        inLanguage: language,
        isPartOf: { "@id": `${site}#website` },
        about: { "@id": `${PRODUCT_LINKS.webApp}#application` },
        mainEntity: messages[language].faqSection.items.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      },
      {
        "@type": "WebApplication",
        "@id": `${PRODUCT_LINKS.webApp}#application`,
        name: "MusicMute",
        url: PRODUCT_LINKS.webApp,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Web browser",
        browserRequirements:
          "Requires an internet connection and a modern web browser",
        description: messages[language].appsSection.web.body,
        publisher: { "@id": `${site}#organization` },
      },
    ],
  };
}

export function serializeStructuredData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
