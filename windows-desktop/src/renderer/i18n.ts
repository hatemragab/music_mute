import { useSyncExternalStore } from "react";
import { ARABIC } from "./locales.js";
let language: "en" | "ar" = "en";
const listeners = new Set<() => void>();
export function setLanguage(next: "en" | "ar"): void {
  if (next === language) return;
  language = next;
  for (const listener of listeners) listener();
}
export function useLanguage(): "en" | "ar" {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => language,
    () => "en",
  );
}
/** English source keys fall back safely; dynamic content is interpolated as plain React text. */
export function t(
  key: string,
  values: Record<string, string | number> = {},
): string {
  const translated = language === "ar" ? ARABIC[key] || key : key;
  return translated.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}
export function number(value: number): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(
    value,
  );
}
export function trackCount(count: number): string {
  if (language === "en")
    return `${number(count)} ${count === 1 ? "track" : "tracks"}`;
  const category = new Intl.PluralRules("ar").select(count),
    forms = {
      zero: "لا مسارات",
      one: "مسار واحد",
      two: "مساران",
      few: `${number(count)} مسارات`,
      many: `${number(count)} مسارًا`,
      other: `${number(count)} مسار`,
    };
  return forms[category as keyof typeof forms];
}
