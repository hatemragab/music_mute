import {
  validGuestCredential,
  type GuestCredential,
  type GuestCredentialStore,
} from "../../../../chrome-extension/src/companion/guest-credential-model.js";
import type { HostContext } from "../host-context.js";
/** Installation capability is DPAPI-protected by current Windows SID; no Firebase bearer is used. */
export class WindowsGuestCredentialStore implements GuestCredentialStore {
  constructor(private readonly host: HostContext) {}
  async load(): Promise<GuestCredential | null> {
    const bytes = await this.host.native.vaultRead("account", "youtube_guest");
    if (!bytes) return null;
    if (bytes.length > 4096) throw new Error("GUEST_CREDENTIALS_UNAVAILABLE");
    const value: unknown = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(bytes),
    );
    if (!validGuestCredential(value))
      throw new Error("GUEST_CREDENTIALS_UNAVAILABLE");
    return value;
  }
  async save(value: GuestCredential): Promise<void> {
    if (!validGuestCredential(value))
      throw new Error("GUEST_CREDENTIALS_UNAVAILABLE");
    await this.host.native.vaultWrite(
      "account",
      "youtube_guest",
      Buffer.from(JSON.stringify(value)),
    );
  }
}
