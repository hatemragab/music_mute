import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import {
  isOfflineVocalsBudget,
  OFFLINE_VOCALS_BUDGET_BYTES,
} from "../../../../chrome-extension/src/shared/storage-policy.js";
import type { HostContext } from "../host-context.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
export class WindowsStorageSettings {
  constructor(private readonly host: HostContext) {}
  async read(): Promise<number> {
    const relative = "storage\\offline-settings.json";
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return OFFLINE_VOCALS_BUDGET_BYTES;
      throw error;
    }
    const value = JSON.parse(
      (await readPrivateBytes(this.host, relative, 1024)).toString("utf8"),
    ) as Record<string, unknown>;
    if (
      !value ||
      Object.keys(value).sort().join() !== "budget_bytes,version" ||
      value.version !== 1 ||
      !isOfflineVocalsBudget(value.budget_bytes)
    )
      throw new Error("STORAGE_SETTINGS_INVALID");
    return value.budget_bytes;
  }
  /** Caller holds the native cache lease. Changing the setting alone never evicts files. */
  async writeOwned(budget: number): Promise<void> {
    if (!isOfflineVocalsBudget(budget))
      throw new Error("STORAGE_LIMIT_INVALID");
    await this.read();
    await writePrivateAtomic(
      this.host,
      "storage\\offline-settings.json",
      Buffer.from(JSON.stringify({ version: 1, budget_bytes: budget })),
    );
  }
}
