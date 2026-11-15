import type {
  ConsumerMutexLease,
  WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
/** Startup/new-role only. Existing control attachment never takes this fence. */
export class SessionPreparationGate {
  private startup: ConsumerMutexLease | null = null;
  constructor(
    private readonly native: Pick<
      WindowsConsumerNative,
      "acquireMutex" | "releaseMutex" | "vaultRead"
    >,
  ) {}
  private async assertNoMutation() {
    const bytes = await this.native.vaultRead("account", "prepare_maintenance");
    try {
      // Any existing WAL, including malformed/retired/unknown state, retains
      // mutation authority until its real owner positively settles and clears it.
      if (bytes !== null) throw new Error("UPDATE_BUSY");
    } finally {
      bytes?.fill(0);
    }
  }
  async beginStartup(): Promise<void> {
    if (this.startup) throw new Error("UPDATE_BUSY");
    const lease = await this.native.acquireMutex("prepare");
    if (!lease) throw new Error("UPDATE_BUSY");
    try {
      await this.assertNoMutation();
      this.startup = lease;
    } catch (error) {
      await this.native.releaseMutex(lease);
      throw error;
    }
  }
  async completeStartup(): Promise<void> {
    if (!this.startup) return;
    await this.native.releaseMutex(this.startup);
    this.startup = null;
  }
  async launch<T>(action: () => Promise<T>): Promise<T> {
    if (this.startup) {
      await this.assertNoMutation();
      return action();
    }
    const lease = await this.native.acquireMutex("prepare");
    if (!lease) throw new Error("UPDATE_BUSY");
    try {
      await this.assertNoMutation();
      return await action();
    } finally {
      await this.native.releaseMutex(lease);
    }
  }
}
