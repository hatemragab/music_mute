export interface PersonalLifecyclePort {
  /** Only work owned by this personal app, never Chrome or fleet work. */
  isBusy(): boolean;
  cancelOwnedWork(): Promise<void>;
  confirmQuit(): Promise<boolean>;
  quit(): void | Promise<void>;
}
export class ShellLifecycle {
  private quitting: Promise<boolean> | undefined;
  constructor(private readonly port: PersonalLifecyclePort) {}
  quitPersonal(current: () => boolean = () => true): Promise<boolean> {
    if (!current()) return Promise.reject(new Error("PERSONAL_OWNER_CHANGED"));
    if (this.quitting) return this.quitting;
    this.quitting = this.performQuit(current).finally(() => {
      this.quitting = undefined;
    });
    return this.quitting;
  }
  private async performQuit(current: () => boolean): Promise<boolean> {
    const assertCurrent = () => {
      if (!current()) throw new Error("PERSONAL_OWNER_CHANGED");
    };
    assertCurrent();
    if (this.port.isBusy()) {
      assertCurrent();
      const confirmed = await this.port.confirmQuit();
      assertCurrent();
      if (!confirmed) return false;
      assertCurrent();
      await this.port.cancelOwnedWork();
      assertCurrent();
      if (this.port.isBusy()) throw new Error("PERSONAL_SHUTDOWN_PENDING");
    }
    assertCurrent();
    await this.port.quit();
    return true;
  }
}
