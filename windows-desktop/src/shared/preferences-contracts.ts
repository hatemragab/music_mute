export const TEXT_SCALES = {
  system: 1,
  compact: 0.85,
  small: 0.92,
  standard: 1,
  large: 1.15,
  extraLarge: 1.3,
  accessibility: 1.55,
} as const;
export interface DesktopPreferences {
  version: 1;
  appearance: "system" | "light" | "dark";
  accent: "orange" | "mint" | "blue" | "purple";
  textSize: keyof typeof TEXT_SCALES;
  language: "system" | "en" | "ar";
  importSource: "file" | "youtube";
  expandPlayer: boolean;
  restoreLastPage: boolean;
  volume: number;
  muted: boolean;
  lastAudibleVolume: number;
  playbackRate: number;
}
export const DEFAULT_PREFERENCES: DesktopPreferences = {
  version: 1,
  appearance: "system",
  accent: "orange",
  textSize: "system",
  language: "system",
  importSource: "file",
  expandPlayer: false,
  restoreLastPage: true,
  volume: 0.8,
  muted: false,
  lastAudibleVolume: 0.8,
  playbackRate: 1,
};
export interface PreferencesView {
  state: "loading" | "ready" | "error";
  errorCode: string | null;
  value: DesktopPreferences;
  resolvedLanguage: "en" | "ar";
}
export type PreferencesPatch = Partial<Omit<DesktopPreferences, "version">>;
export type PreferencesCommand =
  | { type: "SET"; patch: PreferencesPatch }
  | { type: "RESET"; confirmed: true }
  | { type: "RESTORE" };
export function parsePreferencesPatch(value: unknown): PreferencesPatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PREFERENCES_INVALID");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length < 1 ||
    Object.keys(row).some(
      (key) => key === "version" || !Object.hasOwn(DEFAULT_PREFERENCES, key),
    )
  )
    throw new Error("PREFERENCES_INVALID");
  const choices: Record<string, readonly string[]> = {
    appearance: ["system", "light", "dark"],
    accent: ["orange", "mint", "blue", "purple"],
    textSize: Object.keys(TEXT_SCALES),
    language: ["system", "en", "ar"],
    importSource: ["file", "youtube"],
  };
  for (const [key, entry] of Object.entries(row)) {
    if (choices[key]) {
      if (typeof entry !== "string" || !choices[key]!.includes(entry))
        throw new Error("PREFERENCES_INVALID");
    } else if (["expandPlayer", "restoreLastPage", "muted"].includes(key)) {
      if (typeof entry !== "boolean") throw new Error("PREFERENCES_INVALID");
    } else if (
      typeof entry !== "number" ||
      !Number.isFinite(entry) ||
      entry <
        (key === "playbackRate"
          ? 0.25
          : key === "lastAudibleVolume"
            ? 0.01
            : 0) ||
      entry > (key === "playbackRate" ? 3 : 1)
    )
      throw new Error("PREFERENCES_INVALID");
  }
  return structuredClone(row) as PreferencesPatch;
}
export function parsePreferencesCommand(value: unknown): PreferencesCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PREFERENCES_INVALID");
  const row = value as Record<string, unknown>,
    keys = Object.keys(row).sort().join();
  if (row.type === "RESTORE" && keys === "type") return { type: "RESTORE" };
  if (
    row.type === "RESET" &&
    keys === "confirmed,type" &&
    row.confirmed === true
  )
    return { type: "RESET", confirmed: true };
  if (row.type === "SET" && keys === "patch,type")
    return { type: "SET", patch: parsePreferencesPatch(row.patch) };
  throw new Error("PREFERENCES_INVALID");
}
export function resolvedLanguage(
  preference: DesktopPreferences["language"],
  system: string,
): "en" | "ar" {
  return preference === "ar" ||
    (preference === "system" && /^ar(?:-|_|$)/i.test(system))
    ? "ar"
    : "en";
}
