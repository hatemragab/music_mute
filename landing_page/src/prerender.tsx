import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import type { Language } from "./i18n";
import { buildStructuredData, serializeStructuredData } from "./seo";

export function renderPage(language: Language) {
  return {
    markup: renderToString(
      <StrictMode>
        <App language={language} />
      </StrictMode>,
    ),
    structuredData: serializeStructuredData(buildStructuredData(language)),
  };
}
