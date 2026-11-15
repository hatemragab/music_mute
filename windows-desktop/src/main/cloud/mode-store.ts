import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { ProcessingMode } from "../../shared/usage-contracts.js";
export interface CloudModeStore {
  read(): Promise<ProcessingMode>;
  write(mode: ProcessingMode): Promise<void>;
}
/** Device preference persists separately from the current app account's credential. */
export class VaultCloudModeStore implements CloudModeStore {
  constructor(
    private readonly native: Pick<
      WindowsConsumerNative,
      "vaultRead" | "vaultWrite"
    >,
  ) {}
  async read(): Promise<ProcessingMode> {
    const bytes = await this.native.vaultRead("account", "processing_mode");
    if (!bytes) return "local";
    try {
      if (bytes.length > 256) throw new Error("invalid");
      const row = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as Record<string, unknown>;
      if (
        Object.keys(row).length !== 2 ||
        row.version !== 1 ||
        !["local", "cloud"].includes(String(row.mode))
      )
        throw new Error("invalid");
      return row.mode as ProcessingMode;
    } catch {
      throw new Error("PROCESSING_SELECTION_UNAVAILABLE");
    }
  }
  async write(mode: ProcessingMode): Promise<void> {
    if (!["local", "cloud"].includes(mode))
      throw new Error("PROCESSING_SELECTION_UNAVAILABLE");
    await this.native.vaultWrite(
      "account",
      "processing_mode",
      Buffer.from(JSON.stringify({ version: 1, mode })),
    );
  }
}
