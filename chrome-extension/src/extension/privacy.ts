import { createLocalizer, localizePage } from "./i18n";
const localizer = createLocalizer();
localizePage(document, localizer);
window.addEventListener("pagehide", () => localizer.dispose(), { once: true });
