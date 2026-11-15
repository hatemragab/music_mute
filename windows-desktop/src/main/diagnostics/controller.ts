import {
  parseWindowsDiagnosticsCommand,
  DIAGNOSTIC_UUID,
  type WindowsDiagnosticsView,
  type WindowsDiagnosticDoctor,
} from "../../shared/diagnostics-contracts.js";
import type { WindowsDiagnosticJournal } from "./journal.js";
export interface DiagnosticsOsPort {
  copy(text: string): Promise<void>;
  export(
    capability: string,
    filename: "MusicMute-diagnostics.json",
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<{ receipt: string }>;
  revealLogs(): Promise<void>;
  showReport(receipt: string): Promise<void>;
}
export class WindowsDiagnosticsController {
  private value: WindowsDiagnosticsView = {
    busy: false,
    report: null,
    doctor: null,
    exportReceipt: null,
    problem: null,
  };
  private readonly listeners = new Set<
    (view: WindowsDiagnosticsView) => void
  >();
  private active: { abort: AbortController; task: Promise<void> } | null = null;
  private disposed = false;
  private readonly activityListeners = new Set<() => void>();
  constructor(
    private readonly journal: Pick<
      WindowsDiagnosticJournal,
      "snapshot" | "clear"
    >,
    private readonly doctor: {
      run(full: boolean, signal: AbortSignal): Promise<WindowsDiagnosticDoctor>;
    },
    private readonly os: DiagnosticsOsPort,
  ) {}
  snapshot() {
    return structuredClone(this.value);
  }
  activity() {
    return { pending: this.active ? 1 : 0, idle: !this.active };
  }
  subscribeActivity(listener: () => void) {
    this.activityListeners.add(listener);
    listener();
    return () => {
      this.activityListeners.delete(listener);
    };
  }
  private activityChanged() {
    for (const listener of this.activityListeners)
      try {
        listener();
      } catch {
        /* OS/CPU teardown owns the operation. */
      }
  }
  subscribe(listener: (view: WindowsDiagnosticsView) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(partial: Partial<WindowsDiagnosticsView>) {
    if (this.disposed) return;
    this.value = { ...this.value, ...partial };
    for (const l of this.listeners)
      try {
        l(this.snapshot());
      } catch {
        /* UI observer cannot alter native cleanup. */
      }
  }
  async initialize() {
    await this.execute({ type: "INSPECT" });
  }
  /** Trusted current-SID Chrome reporter callback; never accepted as a renderer command. */
  acceptLocalReport(receipt: string): void {
    if (this.disposed) throw new Error("DIAGNOSTICS_CLOSED");
    if (typeof receipt !== "string" || !DIAGNOSTIC_UUID.test(receipt))
      throw new Error("DIAGNOSTICS_EXPORT_FAILED");
    this.publish({ exportReceipt: receipt });
  }
  async execute(input: unknown): Promise<void> {
    const command = parseWindowsDiagnosticsCommand(input);
    if (command.type === "CANCEL") {
      const active = this.active;
      active?.abort.abort();
      await active?.task.catch(() => {});
      return;
    }
    if (this.disposed) throw new Error("DIAGNOSTICS_CLOSED");
    if (this.active) throw new Error("DIAGNOSTICS_BUSY");
    const abort = new AbortController();
    const task = Promise.resolve()
      .then(async () => {
        this.publish({ busy: true, problem: null });
        const signal = abort.signal;
        if (command.type === "INSPECT")
          this.publish({ report: await this.journal.snapshot() });
        else if (command.type === "DOCTOR")
          this.publish({
            doctor: await this.doctor.run(command.full === true, signal),
          });
        else if (command.type === "CLEAR") {
          await this.journal.clear();
          this.publish({ report: await this.journal.snapshot() });
        } else if (command.type === "REVEAL_LOGS") await this.os.revealLogs();
        else if (command.type === "SHOW_REPORT") {
          if (!this.value.exportReceipt)
            throw new Error("DIAGNOSTICS_REPORT_MISSING");
          await this.os.showReport(this.value.exportReceipt);
        } else {
          const report = await this.journal.snapshot(true),
            bytes = Buffer.from(
              JSON.stringify({ report, doctor: this.value.doctor }, null, 2),
            );
          if (bytes.length > 2 * 1024 ** 2)
            throw new Error("DIAGNOSTICS_REPORT_TOO_LARGE");
          signal.throwIfAborted();
          if (command.type === "COPY")
            await this.os.copy(bytes.toString("utf8"));
          else {
            const result = await this.os.export(
              command.destinationCapability,
              "MusicMute-diagnostics.json",
              bytes,
              signal,
            );
            if (!DIAGNOSTIC_UUID.test(result.receipt))
              throw new Error("DIAGNOSTICS_EXPORT_FAILED");
            this.publish({ exportReceipt: result.receipt });
          }
        }
        signal.throwIfAborted();
      })
      .catch((error) => {
        const allowed = new Set([
          "DIAGNOSTICS_BUSY",
          "DIAGNOSTICS_CLOSED",
          "DIAGNOSTICS_CLEAR_FAILED",
          "DIAGNOSTICS_REPORT_MISSING",
          "DIAGNOSTICS_REPORT_TOO_LARGE",
          "DIAGNOSTICS_EXPORT_FAILED",
          "DIAGNOSTICS_STORAGE_UNSAFE",
          "DIAGNOSTICS_CONTEXT_INVALID",
          "DIAGNOSTICS_CONFIG_INVALID",
          "DIAGNOSTICS_DOCTOR_INVALID",
          "MEDIA_SHUTDOWN_PENDING",
          "STORAGE_RECOVERY_PENDING",
          "STORAGE_NOT_READY",
        ]);
        const code = error instanceof Error ? error.message : "";
        const problem = abort.signal.aborted
          ? "CANCELLED"
          : allowed.has(code)
            ? code
            : "DIAGNOSTICS_UNAVAILABLE";
        this.publish({ problem });
        throw new Error(problem);
      })
      .finally(() => {
        this.active = null;
        this.activityChanged();
        this.publish({ busy: false });
      });
    this.active = { abort, task };
    this.activityChanged();
    return task;
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.abort.abort();
    await this.active?.task.catch(() => {});
    this.listeners.clear();
    this.activityListeners.clear();
  }
}
