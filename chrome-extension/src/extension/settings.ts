import { MVP_MAX_DURATION_SECONDS } from "../shared/protocol";

export const MAX_DURATION_MINUTES = MVP_MAX_DURATION_SECONDS / 60;

export interface ExtensionSettings {
  transparencyPercent: number;
  autoStartEnabled: boolean;
  maxDurationMinutes: number;
}

export const DEFAULT_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  transparencyPercent: 5,
  autoStartEnabled: true,
  maxDurationMinutes: MAX_DURATION_MINUTES,
});

export const SETTINGS_KEY = "musicmute.settings.v1";
const fields = [
  "transparencyPercent",
  "autoStartEnabled",
  "maxDurationMinutes",
] as const;
const fieldKeys = fields.map((field) => `${SETTINGS_KEY}.${field}`);
let writeQueue: Promise<unknown> = Promise.resolve();

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  const validInput = Boolean(
    value && typeof value === "object" && !Array.isArray(value),
  );
  const input = validInput ? (value as Record<string, unknown>) : {};
  return {
    transparencyPercent: boundedInteger(
      input.transparencyPercent,
      DEFAULT_SETTINGS.transparencyPercent,
      0,
      80,
    ),
    autoStartEnabled:
      validInput &&
      (Object.hasOwn(input, "autoStartEnabled")
        ? input.autoStartEnabled === true
        : DEFAULT_SETTINGS.autoStartEnabled),
    maxDurationMinutes: boundedInteger(
      input.maxDurationMinutes,
      DEFAULT_SETTINGS.maxDurationMinutes,
      1,
      MAX_DURATION_MINUTES,
    ),
  };
}

function supportedSchema(stored: Record<string, unknown>): boolean {
  const marker: unknown = stored[SETTINGS_KEY];
  return Boolean(
    marker &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    (marker as Record<string, unknown>).version === 1,
  );
}

function decodeSettings(stored: Record<string, unknown>): ExtensionSettings {
  // A pristine profile may use enabled defaults; latent or unknown data may not.
  if (!supportedSchema(stored))
    return {
      ...DEFAULT_SETTINGS,
      autoStartEnabled: ![SETTINGS_KEY, ...fieldKeys].some((key) =>
        Object.hasOwn(stored, key),
      ),
    };
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const key = `${SETTINGS_KEY}.${field}`;
    if (Object.hasOwn(stored, key)) input[field] = stored[key];
  }
  return normalizeSettings(input);
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, ...fieldKeys]);
  return decodeSettings(stored);
}

// Each field has its own key so simultaneous changes in separate tabs cannot
// replace another field with an older snapshot. The marker declares the schema.
export function saveSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(patch);
  const updates: Record<string, unknown> = {
    [SETTINGS_KEY]: { version: 1 },
  };
  for (const field of fields)
    if (Object.hasOwn(patch, field))
      updates[`${SETTINGS_KEY}.${field}`] = normalized[field];
  const write = writeQueue.then(async () => {
    const stored = await chrome.storage.local.get([SETTINGS_KEY, ...fieldKeys]);
    const previous = decodeSettings(stored);
    if (
      !supportedSchema(stored) &&
      [SETTINGS_KEY, ...fieldKeys].some((key) => Object.hasOwn(stored, key)) &&
      !fields.every((field) => Object.hasOwn(patch, field))
    )
      throw new Error("SETTINGS_RESET_REQUIRED");
    await chrome.storage.local.set(updates);
    const committed = { ...previous };
    for (const field of fields)
      if (Object.hasOwn(patch, field))
        Object.assign(committed, { [field]: normalized[field] });
    // A successful write is committed even if the context disappears before a
    // follow-up read. Do not label that write as a failed save.
    return loadSettings().catch(() => committed);
  });
  writeQueue = write.catch(() => undefined);
  return write;
}

export function subscribeSettings(
  callback: (settings: ExtensionSettings) => void,
): () => void {
  let disposed = false;
  let refreshQueue: Promise<unknown> = Promise.resolve();
  const onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (
      disposed ||
      areaName !== "local" ||
      ![SETTINGS_KEY, ...fieldKeys].some((key) => Object.hasOwn(changes, key))
    )
      return;
    refreshQueue = refreshQueue
      .then(loadSettings)
      .then((settings) => {
        if (!disposed) callback(settings);
      })
      .catch(() => undefined);
  };
  try {
    chrome.storage.onChanged.addListener(onChanged);
  } catch {
    // Loading reports an unavailable/revoked extension context to the settings UI.
  }
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      chrome.storage.onChanged.removeListener(onChanged);
    } catch {
      // A revoked content context has no remaining storage subscription.
    }
  };
}
