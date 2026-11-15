import { watch, type FSWatcher } from "node:fs";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
/** Native Windows directory notifications wake durable commands, never HTTP status polling. */
export class WindowsOutboxWatcher {
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private starting: Promise<void> | undefined;
  constructor(
    private readonly host: HostContext,
    private readonly pending: () => void,
    private readonly unavailable: (code: string) => void = () => {},
    private readonly root: "outbox" | "personal\\results" = "outbox",
  ) {}
  start(): Promise<void> {
    if (this.closed || this.watcher) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async open(): Promise<void> {
    await this.host.directory(this.root);
    await this.host.native.validatePath("personal", this.root, "directory");
    if (this.closed) return;
    const watcher = watch(
      win32.join(this.host.personalRoot, this.root),
      { recursive: true },
      (_event, filename) => {
        if (
          this.closed ||
          (filename !== null &&
            !(this.root === "outbox"
              ? String(filename).replaceAll("/", "\\").endsWith("\\record.json")
              : /^[a-f0-9-]{36}(?:\\pair\.json)?$/i.test(
                  String(filename).replaceAll("/", "\\"),
                )))
        )
          return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          if (!this.closed) this.pending();
        }, 100);
        this.debounce.unref?.();
      },
    );
    watcher.on("error", () => {
      watcher.close();
      if (this.watcher === watcher) this.watcher = undefined;
      if (!this.closed) this.unavailable("OUTBOX_WATCH_UNAVAILABLE");
    });
    if (this.closed) {
      watcher.close();
      return;
    }
    this.watcher = watcher;
    this.pending();
  }
  close(): void {
    this.closed = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
