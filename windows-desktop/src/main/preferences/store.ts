import type { HostContext } from "../host-context.js";
import type { PreferencesStore } from "./controller.js";
export class WindowsPreferencesStore implements PreferencesStore {
  constructor(private readonly host: HostContext) {}
  read() {
    return this.host.native.vaultRead("account", "desktop_preferences");
  }
  async write(bytes: Buffer) {
    if (bytes.length > 16384) throw new Error("PREFERENCES_UNAVAILABLE");
    await this.host.native.vaultWrite("account", "desktop_preferences", bytes);
  }
  async quarantine(bytes: Buffer) {
    const current = await this.read();
    if (!current || !current.equals(bytes))
      throw new Error("PREFERENCES_UNAVAILABLE");
    await this.host.native.vaultWrite(
      "account",
      "desktop_preferences_bad",
      bytes,
    );
  }
}
