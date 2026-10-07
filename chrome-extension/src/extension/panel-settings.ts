import { t, createLocalizer, createLanguageSelect } from "./i18n";
import {
  DEFAULT_SETTINGS,
  MAX_DURATION_MINUTES,
  loadSettings,
  saveSettings,
  subscribeSettings,
  type ExtensionSettings,
} from "./settings";

export function createPanelSettings(
  panel: HTMLElement,
  onSettings: (settings: ExtensionSettings) => void,
): {
  button: HTMLButtonElement;
  element: HTMLElement;
  toggle(): void;
  close(): void;
  dispose(): void;
} {
  const localizer = createLocalizer();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "musicmute-panel-settings-button";
  localizer.attribute(button, "title", () => t("Extension settings"));
  localizer.attribute(button, "aria-label", () => t("Extension settings"));
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "musicmute-panel-settings");
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9.5 3-.6 2.3-2 .9-2.1-.6-2.5 4.3 1.6 1.7v2.3l-1.6 1.7 2.5 4.3 2.1-.6 2 .9.6 2.3h5l.6-2.3 2-.9 2.1.6 2.5-4.3-1.6-1.7v-2.3l1.6-1.7-2.5-4.3-2.1.6-2-.9L14.5 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  const element = document.createElement("section");
  element.id = "musicmute-panel-settings";
  localizer.direction(panel);
  element.className = "musicmute-panel-settings";
  element.hidden = true;
  element.setAttribute("aria-labelledby", "musicmute-settings-heading");
  const heading = document.createElement("div");
  heading.className = "musicmute-settings-heading";
  const title = document.createElement("strong");
  title.id = "musicmute-settings-heading";
  localizer.text(title, () => t("Extension settings"));
  const done = document.createElement("button");
  done.type = "button";
  done.className = "musicmute-settings-done";
  localizer.text(done, () => t("Done"));
  heading.append(title, done);

  const transparencyLabel = document.createElement("label");
  transparencyLabel.className = "musicmute-settings-label";
  transparencyLabel.htmlFor = "musicmute-setting-transparency";
  const transparencyText = document.createElement("span");
  localizer.text(transparencyText, () => t("Dialog transparency"));
  transparencyLabel.append(transparencyText);
  const transparencyOutput = document.createElement("output");
  transparencyOutput.setAttribute("for", "musicmute-setting-transparency");
  transparencyLabel.append(transparencyOutput);
  const transparency = document.createElement("input");
  transparency.type = "range";
  transparency.id = "musicmute-setting-transparency";
  transparency.min = "0";
  transparency.max = "80";
  transparency.step = "1";

  const autoLabel = document.createElement("label");
  autoLabel.className = "musicmute-settings-toggle";
  const autoStart = document.createElement("input");
  autoStart.type = "checkbox";
  autoStart.id = "musicmute-setting-autostart";
  const autoText = document.createElement("span");
  localizer.text(autoText, () => t("Auto-start videos"));
  autoLabel.append(autoStart, autoText);

  const durationLabel = document.createElement("label");
  durationLabel.className = "musicmute-settings-label";
  durationLabel.htmlFor = "musicmute-setting-duration";
  localizer.text(durationLabel, () => t("Only videos shorter than"));
  const durationRow = document.createElement("div");
  durationRow.className = "musicmute-settings-duration";
  const duration = document.createElement("input");
  duration.type = "number";
  duration.id = "musicmute-setting-duration";
  duration.min = "1";
  duration.max = String(MAX_DURATION_MINUTES);
  duration.step = "1";
  duration.setAttribute("aria-describedby", "musicmute-settings-duration-hint");
  const minutes = document.createElement("span");
  localizer.text(minutes, () => t("minutes"));
  durationRow.append(duration, minutes);
  const hint = document.createElement("small");
  hint.id = "musicmute-settings-duration-hint";
  localizer.text(hint, () =>
    t("1–{0} minutes. Eligible videos pause until vocals are ready.", [
      MAX_DURATION_MINUTES,
    ]),
  );
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "musicmute-settings-reset";
  localizer.text(reset, () => t("Reset settings"));
  reset.hidden = true;
  const status = document.createElement("p");
  status.className = "musicmute-settings-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  localizer.text(status, () => t("Loading saved settings…"));
  const languageControl = createLanguageSelect(
    localizer,
    "musicmute-setting-language",
    () => {
      localizer.text(status, () =>
        t("Couldn’t save language. Your previous language is still active."),
      );
      status.dataset.error = "true";
    },
  );
  element.append(
    heading,
    languageControl.label,
    languageControl.select,
    transparencyLabel,
    transparency,
    autoLabel,
    durationLabel,
    durationRow,
    hint,
    reset,
    status,
  );

  let disposed = false;
  let loaded = false;
  let committed: ExtensionSettings = { ...DEFAULT_SETTINGS };
  let pending = 0;
  let saveRevision = 0;
  let observedRevision = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const controls = [transparency, autoStart, duration];
  for (const control of controls) control.disabled = true;

  function applyTransparency(value: number): void {
    panel.style.setProperty("--musicmute-panel-alpha", String(1 - value / 100));
    localizer.text(transparencyOutput, () => `${value}%`);
    localizer.attribute(transparency, "aria-valuetext", () =>
      t("{0}% transparent", [value]),
    );
  }

  function render(settings: ExtensionSettings): void {
    transparency.value = String(settings.transparencyPercent);
    autoStart.checked = settings.autoStartEnabled;
    duration.value = String(settings.maxDurationMinutes);
    applyTransparency(settings.transparencyPercent);
  }

  function accept(settings: ExtensionSettings): void {
    if (disposed) return;
    committed = { ...settings };
    loaded = true;
    for (const control of controls) control.disabled = false;
    if (!pending && previewTimer === undefined) render(committed);
    onSettings({ ...committed });
  }

  function close(): void {
    if (disposed || element.hidden) return;
    element.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.focus({ preventScroll: true });
  }

  function toggle(): void {
    if (disposed) return;
    if (!element.hidden) return close();
    element.hidden = false;
    button.setAttribute("aria-expanded", "true");
    (loaded ? transparency : done).focus({ preventScroll: true });
  }

  async function persist(patch: Partial<ExtensionSettings>): Promise<void> {
    if (disposed || !loaded) return;
    const revision = ++saveRevision;
    pending++;
    localizer.text(status, () => t("Saving…"));
    status.dataset.error = "false";
    try {
      const settings = await saveSettings(patch);
      if (disposed) return;
      accept(settings);
      if (revision === saveRevision) {
        localizer.text(status, () => t("Saved on this Chrome profile."));
        status.dataset.error = "false";
        reset.hidden = true;
      }
    } catch (error) {
      if (disposed) return;
      if (revision === saveRevision) {
        const needsReset =
          error instanceof Error && error.message === "SETTINGS_RESET_REQUIRED";
        reset.hidden = !needsReset;
        localizer.text(status, () =>
          needsReset
            ? t(
                "Couldn’t save these settings. Choose Reset settings to restore defaults.",
              )
            : t("Couldn’t save. Your previous settings are still active."),
        );
        status.dataset.error = "true";
      }
    } finally {
      pending--;
      if (!disposed && !pending && previewTimer === undefined)
        render(committed);
    }
  }

  function onTransparencyInput(): void {
    if (!loaded || disposed) return;
    const value = Number(transparency.value);
    if (!Number.isInteger(value) || value < 0 || value > 80) return;
    applyTransparency(value);
    if (previewTimer !== undefined) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      void persist({ transparencyPercent: value });
    }, 200);
  }

  function onTransparencyChange(): void {
    if (previewTimer === undefined) return;
    clearTimeout(previewTimer);
    previewTimer = undefined;
    void persist({ transparencyPercent: Number(transparency.value) });
  }

  function onAutoStartChange(): void {
    void persist({ autoStartEnabled: autoStart.checked });
  }

  function onDurationChange(): void {
    const value = Number(duration.value);
    if (
      duration.value.trim() === "" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_DURATION_MINUTES
    ) {
      localizer.text(status, () =>
        t("Choose a whole number from 1 to {0} minutes.", [
          MAX_DURATION_MINUTES,
        ]),
      );
      status.dataset.error = "true";
      duration.value = String(committed.maxDurationMinutes);
      return;
    }
    void persist({ maxDurationMinutes: value });
  }

  function onButtonClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    toggle();
  }

  function onDoneClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function onResetClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (previewTimer !== undefined) clearTimeout(previewTimer);
    previewTimer = undefined;
    void persist({ ...DEFAULT_SETTINGS });
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (element.hidden) return;
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  render(committed);
  const initialRevision = observedRevision;
  const unsubscribe = subscribeSettings((settings) => {
    observedRevision++;
    accept(settings);
  });
  void loadSettings()
    .then((settings) => {
      if (disposed || observedRevision !== initialRevision) return;
      accept(settings);
      localizer.text(status, () =>
        t("Changes are saved on this Chrome profile."),
      );
    })
    .catch(() => {
      if (disposed || observedRevision !== initialRevision) return;
      accept({ ...DEFAULT_SETTINGS, autoStartEnabled: false });
      localizer.text(status, () =>
        t("Couldn’t load settings. Auto-start is off."),
      );
      status.dataset.error = "true";
    });
  button.addEventListener("click", onButtonClick);
  button.addEventListener("keydown", onKeyDown);
  done.addEventListener("click", onDoneClick);
  reset.addEventListener("click", onResetClick);
  element.addEventListener("keydown", onKeyDown);
  transparency.addEventListener("input", onTransparencyInput);
  transparency.addEventListener("change", onTransparencyChange);
  autoStart.addEventListener("change", onAutoStartChange);
  duration.addEventListener("change", onDurationChange);

  return {
    button,
    element,
    toggle,
    close,
    dispose() {
      if (disposed) return;
      disposed = true;
      languageControl.dispose();
      localizer.dispose();
      if (previewTimer !== undefined) {
        clearTimeout(previewTimer);
        previewTimer = undefined;
        // A player replacement can remove this view during the slider debounce.
        // Retain the user's last change without updating a detached panel.
        void saveSettings({
          transparencyPercent: Number(transparency.value),
        }).catch(() => undefined);
      }
      unsubscribe();
      button.removeEventListener("click", onButtonClick);
      button.removeEventListener("keydown", onKeyDown);
      done.removeEventListener("click", onDoneClick);
      reset.removeEventListener("click", onResetClick);
      element.removeEventListener("keydown", onKeyDown);
      transparency.removeEventListener("input", onTransparencyInput);
      transparency.removeEventListener("change", onTransparencyChange);
      autoStart.removeEventListener("change", onAutoStartChange);
      duration.removeEventListener("change", onDurationChange);
    },
  };
}
