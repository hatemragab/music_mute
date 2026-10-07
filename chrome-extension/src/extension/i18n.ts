import { arabic } from "./translations";

export type LanguagePreference = "auto" | "en" | "ar";
export type Language = "en" | "ar";
export const LANGUAGE_KEY = "musicmute.language.v1";
export function normalizeLanguage(value: unknown): LanguagePreference {
  return value === "ar" || value === "en" ? value : "auto";
}
export function resolveLanguage(
  preference: LanguagePreference,
  uiLanguage: string,
): Language {
  return preference === "auto"
    ? /^ar(?:[-_]|$)/i.test(uiLanguage)
      ? "ar"
      : "en"
    : preference;
}
function chromeLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return "en";
  }
}
let preference: LanguagePreference = "auto";
export function language(): Language {
  return resolveLanguage(preference, chromeLanguage());
}
export function t(
  key: keyof typeof arabic,
  values: readonly (string | number)[] = [],
): string {
  const template = language() === "ar" ? arabic[key] : key;
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    String(values[Number(index)] ?? placeholder),
  );
}
const listeners = new Set<() => void>();
let revision = 0;
let watching = false;
let writeQueue: Promise<unknown> = Promise.resolve();
function notify(): void {
  for (const listener of listeners) listener();
}
function changed(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): void {
  if (area !== "local" || !Object.hasOwn(changes, LANGUAGE_KEY)) return;
  revision++;
  preference = normalizeLanguage(changes[LANGUAGE_KEY]?.newValue);
  notify();
}
export function subscribeLanguage(callback: () => void): () => void {
  listeners.add(callback);
  if (!watching) {
    watching = true;
    const initialRevision = revision;
    try {
      chrome.storage.onChanged.addListener(changed);
      void chrome.storage.local
        .get(LANGUAGE_KEY)
        .then((stored) => {
          if (revision !== initialRevision || !watching) return;
          preference = normalizeLanguage(stored[LANGUAGE_KEY]);
          notify();
        })
        .catch(() => undefined);
    } catch {
      /* A revoked extension context retains the current language. */
    }
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size) return;
    watching = false;
    revision++;
    try {
      chrome.storage.onChanged.removeListener(changed);
    } catch {
      /* Context retired. */
    }
  };
}
export function languagePreference(): LanguagePreference {
  return preference;
}
export function saveLanguage(value: unknown): Promise<void> {
  const next = normalizeLanguage(value);
  const write = writeQueue.then(async () => {
    await chrome.storage.local.set({ [LANGUAGE_KEY]: next });
    preference = next;
    revision++;
    notify();
  });
  writeQueue = write.catch(() => undefined);
  return write;
}

/** Bind render functions so a language change updates existing UI without remounting it. */
export function createLocalizer() {
  const bindings = new Map<Element, Map<string, () => string>>();
  function apply(
    element: Element,
    attribute: string,
    render: () => string,
  ): void {
    if (attribute === "textContent") element.textContent = render();
    else element.setAttribute(attribute, render());
  }
  function bind(
    element: Element,
    attribute: string,
    render: () => string,
  ): void {
    let fields = bindings.get(element);
    if (!fields) {
      fields = new Map();
      bindings.set(element, fields);
    }
    fields.set(attribute, render);
    apply(element, attribute, render);
  }
  const unsubscribe = subscribeLanguage(() => {
    for (const [element, fields] of bindings)
      for (const [attribute, render] of fields)
        apply(element, attribute, render);
  });
  return {
    text: (element: Element, render: () => string) =>
      bind(element, "textContent", render),
    attribute: bind,
    direction(element: Element) {
      bind(element, "lang", language);
      bind(element, "dir", () => (language() === "ar" ? "rtl" : "ltr"));
    },
    clear() {
      bindings.clear();
    },
    dispose() {
      bindings.clear();
      unsubscribe();
    },
  };
}

export function createLanguageSelect(
  localizer: ReturnType<typeof createLocalizer>,
  id: string,
  onError: () => void,
) {
  const label = document.createElement("label");
  label.htmlFor = id;
  localizer.text(label, () => t("Language"));
  const select = document.createElement("select");
  select.id = id;
  for (const [value, name] of [
    ["auto", "Automatic (Chrome language)"],
    ["ar", "العربية"],
    ["en", "English"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    localizer.text(option, () =>
      value === "auto" ? t("Automatic (Chrome language)") : name,
    );
    select.append(option);
  }
  const render = () => {
    select.value = languagePreference();
  };
  render();
  const unsubscribe = subscribeLanguage(render);
  let disposed = false;
  const onChange = () => {
    select.disabled = true;
    void saveLanguage(select.value)
      .catch(() => {
        if (!disposed) {
          render();
          onError();
        }
      })
      .finally(() => {
        if (!disposed) select.disabled = false;
      });
  };
  select.addEventListener("change", onChange);
  return {
    label,
    select,
    dispose() {
      disposed = true;
      unsubscribe();
      select.removeEventListener("change", onChange);
    },
  };
}

export function localizePage(
  document: Document,
  localizer: ReturnType<typeof createLocalizer>,
): void {
  localizer.direction(document.documentElement);
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key && Object.hasOwn(arabic, key))
      localizer.text(element, () => t(key as keyof typeof arabic));
  }
}

export function localizedStage(stage: string): string {
  if (language() === "en")
    return stage.replaceAll("_", " ").replaceAll("-", " ");
  if (stage.startsWith("cloud_")) return t("processing with MusicMute cloud");
  switch (stage) {
    case "metadata":
      return t("Getting the audio");
    case "downloading":
    case "shared-original-download":
      return t("Getting the audio");
    case "cache-check":
    case "shared-cache-lookup":
    case "shared-cache-waiting":
    case "shared-cache-download":
    case "account-restore":
      return t("Checking saved vocals");
    case "input_validation":
    case "validating":
      return t("Checking the vocals");
    case "waiting-for-worker":
      return t("Waiting for the background worker");
    default:
      return t("Separating vocals");
  }
}
