import type { CloudView } from "../../shared/cloud-contracts.js";
import type { ProcessingMode } from "../../shared/usage-contracts.js";
import type { CloudModeStore } from "./mode-store.js";

/** Missing public account configuration must not replace the saved processing choice. */
export class UnconfiguredCloudPreference {
  private mode: ProcessingMode = "cloud";
  private selectionKnown = false;
  private readonly listeners = new Set<(view: CloudView) => void>();
  constructor(
    private readonly store: CloudModeStore,
    private readonly localReady: () => boolean,
  ) {}
  view(): CloudView {
    const ready =
      this.selectionKnown && this.mode === "local" && this.localReady();
    return {
      mode: this.mode,
      ready,
      reason: !this.selectionKnown
        ? "PROCESSING_SELECTION_UNAVAILABLE"
        : this.mode === "cloud"
          ? "CONFIGURATION_REQUIRED"
          : ready
            ? null
            : "PREPARE_REQUIRED",
      signInRequired: false,
      linkImportVisible: true,
      connection: "unavailable",
      busy: false,
      phase: "idle",
      confirmation: null,
      job: null,
      errorCode: this.selectionKnown
        ? null
        : "PROCESSING_SELECTION_UNAVAILABLE",
      resultCapability: null,
    };
  }
  subscribe(listener: (view: CloudView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  refresh(): void {
    for (const listener of this.listeners) listener(this.view());
  }
  async restore(): Promise<void> {
    try {
      this.mode = await this.store.read();
      this.selectionKnown = true;
    } catch {
      // Unknown/corrupt choice cannot authorize a silent local request.
      this.selectionKnown = false;
    }
    this.refresh();
  }
  async setMode(mode: ProcessingMode): Promise<void> {
    if (mode !== "local" && mode !== "cloud")
      throw new Error("INVALID_REQUEST");
    await this.store.write(mode);
    this.mode = mode;
    this.selectionKnown = true;
    this.refresh();
  }
}
