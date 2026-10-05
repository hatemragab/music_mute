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
  const button = document.createElement("button");
  button.type = "button";
  button.className = "musicmute-panel-settings-button";
  button.title = "Extension settings";
  button.setAttribute("aria-label", "Extension settings");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "musicmute-panel-settings");
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9.5 3-.6 2.3-2 .9-2.1-.6-2.5 4.3 1.6 1.7v2.3l-1.6 1.7 2.5 4.3 2.1-.6 2 .9.6 2.3h5l.6-2.3 2-.9 2.1.6 2.5-4.3-1.6-1.7v-2.3l1.6-1.7-2.5-4.3-2.1.6-2-.9L14.5 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  const element = document.createElement("section");
  element.id = "musicmute-panel-settings";
  element.className = "musicmute-panel-settings";
  element.hidden = true;
  element.setAttribute("aria-labelledby", "musicmute-settings-heading");
  const heading = document.createElement("div");
  heading.className = "musicmute-settings-heading";
  const title = document.createElement("strong");
  title.id = "musicmute-settings-heading";
  title.textContent = "Extension settings";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "musicmute-settings-done";
  done.textContent = "Done";
  heading.append(title, done);

  const transparencyLabel = document.createElement("label");
  transparencyLabel.className = "musicmute-settings-label";
  transparencyLabel.htmlFor = "musicmute-setting-transparency";
  transparencyLabel.textContent = "Dialog transparency";
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
  autoText.textContent = "Auto-start videos";
  autoLabel.append(autoStart, autoText);

  const durationLabel = document.createElement("label");
  durationLabel.className = "musicmute-settings-label";
  durationLabel.htmlFor = "musicmute-setting-duration";
  durationLabel.textContent = "Only videos shorter than";
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
  minutes.textContent = "minutes";
  durationRow.append(duration, minutes);
  const hint = document.createElement("small");
  hint.id = "musicmute-settings-duration-hint";
  hint.textContent = `1–${MAX_DURATION_MINUTES} minutes. Eligible videos pause until vocals are ready.`;
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "musicmute-settings-reset";
  reset.textContent = "Reset settings";
  reset.hidden = true;
  const status = document.createElement("p");
  status.className = "musicmute-settings-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Loading saved settings…";
  element.append(
    heading,
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
    transparencyOutput.textContent = `${value}%`;
    transparency.setAttribute("aria-valuetext", `${value}% transparent`);
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
    status.textContent = "Saving…";
    status.dataset.error = "false";
    try {
      const settings = await saveSettings(patch);
      if (disposed) return;
      accept(settings);
      if (revision === saveRevision) {
        status.textContent = "Saved on this Chrome profile.";
        status.dataset.error = "false";
        reset.hidden = true;
      }
    } catch (error) {
      if (disposed) return;
      if (revision === saveRevision) {
        const needsReset =
          error instanceof Error && error.message === "SETTINGS_RESET_REQUIRED";
        reset.hidden = !needsReset;
        status.textContent = needsReset
          ? "Couldn’t save these settings. Choose Reset settings to restore defaults."
          : "Couldn’t save. Your previous settings are still active.";
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
      status.textContent = `Choose a whole number from 1 to ${MAX_DURATION_MINUTES} minutes.`;
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
      status.textContent = "Changes are saved on this Chrome profile.";
    })
    .catch(() => {
      if (disposed || observedRevision !== initialRevision) return;
      accept({ ...DEFAULT_SETTINGS, autoStartEnabled: false });
      status.textContent = "Couldn’t load settings. Auto-start is off.";
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
