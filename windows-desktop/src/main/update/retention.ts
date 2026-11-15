import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
export class ConsumerBackupRetention {
  constructor(
    private readonly native: Pick<
      WindowsConsumerNative,
      "vaultRead" | "vaultWrite"
    >,
  ) {}
  async read(): Promise<string[]> {
    const bytes = await this.native.vaultRead(
      "account",
      "consumer_update_backups",
    );
    if (!bytes) return [];
    try {
      if (bytes.length > 4096) throw new Error("UPDATE_STATE_INVALID");
      const v = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as { version: number; identities: string[] };
      if (
        !v ||
        Object.keys(v).sort().join() !== "identities,version" ||
        v.version !== 1 ||
        !Array.isArray(v.identities) ||
        v.identities.length > 3 ||
        v.identities.some(
          (id) => typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id),
        ) ||
        new Set(v.identities).size !== v.identities.length
      )
        throw new Error("UPDATE_STATE_INVALID");
      return [...v.identities];
    } finally {
      bytes.fill(0);
    }
  }
  /** Caller holds Prepare: persist the bounded reservation BEFORE any backup packets/blobs. */
  async reserve(identity: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(identity))
      throw new Error("UPDATE_STATE_INVALID");
    const ids = await this.read();
    if (ids.includes(identity)) return;
    if (ids.length >= 3) throw new Error("UPDATE_CLEANUP_PENDING");
    await this.write([identity, ...ids]);
  }
  async write(identities: string[]): Promise<void> {
    if (
      identities.length > 3 ||
      identities.some((id) => !/^[a-f0-9]{64}$/u.test(id)) ||
      new Set(identities).size !== identities.length
    )
      throw new Error("UPDATE_STATE_INVALID");
    await this.native.vaultWrite(
      "account",
      "consumer_update_backups",
      Buffer.from(JSON.stringify({ version: 1, identities })),
    );
  }
}
