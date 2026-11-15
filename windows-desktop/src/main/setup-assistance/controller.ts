import {
  parseSetupAssistanceCommand,
  type SetupAssistanceCommand,
  type SetupAssistanceView,
} from "../../shared/setup-assistance-contracts.js";
export interface SetupAssistancePort {
  inspect(
    signal: AbortSignal,
  ): Promise<Pick<SetupAssistanceView, "extension" | "chrome" | "modelFolder">>;
  openChromeExtensions(
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<void>;
  revealExtension(signal: AbortSignal, current: () => boolean): Promise<void>;
  copyExtensionPath(signal: AbortSignal, current: () => boolean): Promise<void>;
  revealModelFolder(signal: AbortSignal, current: () => boolean): Promise<void>;
}
export class SetupAssistanceController {
  private view: SetupAssistanceView = {
    state: "checking",
    busy: false,
    extension: "unavailable",
    chrome: "unavailable",
    modelFolder: "unavailable",
    problem: null,
  };
  private readonly listeners = new Set<(view: SetupAssistanceView) => void>();
  private readonly abort = new AbortController();
  private active: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly port: SetupAssistancePort) {}
  snapshot(): SetupAssistanceView {
    return { ...this.view };
  }
  subscribe(listener: (view: SetupAssistanceView) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(patch: Partial<SetupAssistanceView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners)
      try {
        listener(this.snapshot());
      } catch {}
  }
  private perform(
    work: (signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.closed || this.active)
      return Promise.reject(new Error("SETUP_ASSISTANCE_UNAVAILABLE"));
    const combined = AbortSignal.any([signal, this.abort.signal]);
    const task = Promise.resolve()
      .then(async () => {
        combined.throwIfAborted();
        await work(combined);
        combined.throwIfAborted();
      })
      .catch(() => {
        this.publish({
          state: "error",
          problem: "SETUP_ASSISTANCE_UNAVAILABLE",
        });
        throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
      })
      .finally(() => {
        if (this.active === task) this.active = undefined;
        this.publish({ busy: false });
      });
    this.active = task;
    this.publish({ busy: true, problem: null });
    return task;
  }
  refresh(signal: AbortSignal): Promise<void> {
    return this.perform(async (ownedSignal) => {
      const inspected = await this.port.inspect(ownedSignal);
      this.publish({ ...inspected, state: "ready" });
    }, signal);
  }
  execute(
    raw: SetupAssistanceCommand,
    signal: AbortSignal,
    current: () => boolean = () => true,
  ): Promise<void> {
    let command: SetupAssistanceCommand;
    try {
      command = parseSetupAssistanceCommand(raw);
    } catch {
      return Promise.reject(new Error("INVALID_COMMAND"));
    }
    return this.perform(async (ownedSignal) => {
      if (!current()) throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
      const operations = {
        OPEN_CHROME_EXTENSIONS: this.port.openChromeExtensions.bind(this.port),
        REVEAL_EXTENSION: this.port.revealExtension.bind(this.port),
        COPY_EXTENSION_PATH: this.port.copyExtensionPath.bind(this.port),
        REVEAL_MODEL: this.port.revealModelFolder.bind(this.port),
      };
      await operations[command.type](ownedSignal, current);
      if (!current()) throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
      const inspected = await this.port.inspect(ownedSignal);
      this.publish({ ...inspected, state: "ready" });
    }, signal);
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.active?.catch(() => {});
    this.listeners.clear();
  }
}
