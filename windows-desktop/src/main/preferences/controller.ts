import {
  DEFAULT_PREFERENCES,
  parsePreferencesCommand,
  parsePreferencesPatch,
  resolvedLanguage,
  type DesktopPreferences,
  type PreferencesView,
} from "../../shared/preferences-contracts.js";
export interface PreferencesStore {
  read(): Promise<Buffer | null>;
  write(value: Buffer): Promise<void>;
  quarantine(value: Buffer): Promise<void>;
}
/** Device settings never capture an account, media capability, or worker credential. */
export class PreferencesController {
  private value: PreferencesView;
  private readonly listeners = new Set<(view: PreferencesView) => void>();
  private queue: Promise<void> = Promise.resolve();
  private damaged: Buffer | null = null;
  private disposed = false;
  constructor(
    private readonly store: PreferencesStore,
    private readonly systemLanguage: string,
  ) {
    this.value = {
      state: "loading",
      errorCode: null,
      value: { ...DEFAULT_PREFERENCES },
      resolvedLanguage: resolvedLanguage("system", systemLanguage),
    };
  }
  view(): PreferencesView {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: PreferencesView) => void) {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(
    value: DesktopPreferences,
    state: PreferencesView["state"] = "ready",
    errorCode: string | null = null,
  ) {
    this.value = {
      state,
      errorCode,
      value,
      resolvedLanguage: resolvedLanguage(value.language, this.systemLanguage),
    };
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {}
    }
  }
  execute(input: unknown): Promise<void> {
    const command = parsePreferencesCommand(input);
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error("PREFERENCES_UNAVAILABLE");
        if (command.type === "RESTORE") {
          try {
            const bytes = await this.store.read();
            this.damaged = bytes ? Buffer.from(bytes) : null;
            if (!bytes) {
              this.publish({ ...DEFAULT_PREFERENCES });
              return;
            }
            if (bytes.length > 16384) throw new Error("PREFERENCES_CORRUPT");
            const record = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            ) as Record<string, unknown>;
            if (
              !record ||
              typeof record !== "object" ||
              Array.isArray(record) ||
              (record.version !== 0 && record.version !== 1)
            )
              throw new Error("PREFERENCES_VERSION_UNSUPPORTED");
            const { version, ...patch } = record;
            const parsed = parsePreferencesPatch(patch);
            if (
              version === 1 &&
              Object.keys(parsed).length !==
                Object.keys(DEFAULT_PREFERENCES).length - 1
            )
              throw new Error("PREFERENCES_CORRUPT");
            const value = { ...DEFAULT_PREFERENCES, ...parsed };
            this.damaged = null;
            this.publish(value);
            if (version === 0)
              await this.store.write(Buffer.from(JSON.stringify(value)));
          } catch (error) {
            this.publish(
              { ...DEFAULT_PREFERENCES },
              "error",
              error instanceof Error &&
                error.message === "PREFERENCES_VERSION_UNSUPPORTED"
                ? error.message
                : "PREFERENCES_UNAVAILABLE",
            );
          }
          return;
        }
        if (command.type === "SET" && this.value.state !== "ready")
          throw new Error("PREFERENCES_UNAVAILABLE");
        if (command.type === "RESET" && this.damaged)
          await this.store.quarantine(this.damaged);
        const value =
          command.type === "RESET"
            ? { ...DEFAULT_PREFERENCES }
            : { ...this.value.value, ...command.patch };
        try {
          await this.store.write(Buffer.from(JSON.stringify(value)));
          this.damaged = null;
          this.publish(value);
        } catch {
          this.publish(this.value.value, "error", "PREFERENCES_UNAVAILABLE");
          throw new Error("PREFERENCES_UNAVAILABLE");
        }
      });
    this.queue = next;
    return next;
  }
  async close() {
    await this.queue.catch(() => {});
    this.disposed = true;
    this.listeners.clear();
  }
}
