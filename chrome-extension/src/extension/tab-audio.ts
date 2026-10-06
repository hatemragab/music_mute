const KEY = "musicmute.tab.audio.v1";
interface Lease {
  tabId: number;
  previousMuted: boolean;
  owner: string;
}
/** Serialize browser mute changes; keep restoration metadata in browser memory. */
export class TabAudio {
  private pending = Promise.resolve();
  private applied = new Map<number, { lease: Lease; suppress: boolean }>();
  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async read(tabId: number): Promise<Lease | null> {
    const value = (await chrome.storage.session.get(KEY + tabId))[
      KEY + tabId
    ] as Partial<Lease> | undefined;
    return value &&
      Number.isSafeInteger(value.tabId) &&
      Number(value.tabId) >= 0 &&
      typeof value.previousMuted === "boolean" &&
      typeof value.owner === "string"
      ? {
          tabId: value.tabId!,
          previousMuted: value.previousMuted,
          owner: value.owner,
        }
      : null;
  }
  async has(tabId: number): Promise<boolean> {
    return this.run(async () => (await this.read(tabId)) !== null);
  }
  async set(tabId: number, owner: string, suppress: boolean): Promise<boolean> {
    return this.run(async () => {
      const cached = this.applied.get(tabId);
      if (cached?.lease.owner === owner && cached.suppress === suppress)
        return cached.lease.previousMuted;
      let lease = await this.read(tabId);
      const tab = await chrome.tabs.get(tabId);
      if (!lease) {
        lease = { tabId, owner, previousMuted: tab.mutedInfo?.muted === true };
      }
      if (
        tab.mutedInfo &&
        !(
          tab.mutedInfo.reason === "extension" &&
          tab.mutedInfo.extensionId === chrome.runtime.id
        )
      )
        lease.previousMuted = tab.mutedInfo.muted;
      lease.owner = owner;
      await chrome.storage.session.set({ [KEY + tabId]: lease });
      const muted = suppress || lease.previousMuted;
      if (tab.mutedInfo?.muted !== muted)
        await chrome.tabs.update(tabId, { muted });
      this.applied.set(tabId, { lease, suppress });
      return lease.previousMuted;
    });
  }
  async release(tabId: number, owner?: string): Promise<void> {
    return this.run(async () => {
      const lease = await this.read(tabId);
      if (
        !lease ||
        lease.tabId !== tabId ||
        (owner !== undefined && lease.owner !== owner)
      )
        return;
      this.applied.delete(tabId);
      try {
        const tab = await chrome.tabs.get(tabId);
        // A later user/other-extension mute choice belongs to them.
        if (
          tab.mutedInfo?.reason === "extension" &&
          tab.mutedInfo.extensionId === chrome.runtime.id
        )
          await chrome.tabs.update(tabId, { muted: lease.previousMuted });
      } catch {
        /* Tab already closed. */
      }
      await chrome.storage.session.set({ [KEY + tabId]: null });
    });
  }
}
