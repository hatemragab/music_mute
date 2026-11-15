import type { WorkerRuntime } from "../../../../worker/src/runtime/worker-runtime.js";
type FleetRuntimeSupervisor = ConstructorParameters<typeof WorkerRuntime>[3];
/** Consumer inference idle requires actual bound native whole-role census after shared teardown. */
export class FleetInferenceTracker {
  private idleValue = false;
  constructor(
    private readonly supervisor: FleetRuntimeSupervisor,
    private readonly nativeIdle: () => Promise<boolean>,
  ) {}
  async initialize(): Promise<void> {
    await this.confirmStopped();
  }
  private async confirmStopped(): Promise<void> {
    this.idleValue = false;
    let idle = false;
    try {
      idle = await this.nativeIdle();
    } catch {
      /* Query failure is never stopped proof. */
    }
    if (!idle) throw new Error("FLEET_STOP_UNCONFIRMED");
    this.idleValue = true;
  }
  idle(): boolean {
    return this.idleValue;
  }
  async start(
    ...args: Parameters<FleetRuntimeSupervisor["start"]>
  ): Promise<void> {
    this.idleValue = false;
    await this.supervisor.start(...args);
  }
  async stop(): Promise<void> {
    this.idleValue = false;
    await this.supervisor.stop();
    await this.confirmStopped();
  }
  async restart(
    ...args: Parameters<FleetRuntimeSupervisor["restart"]>
  ): ReturnType<FleetRuntimeSupervisor["restart"]> {
    this.idleValue = false;
    return await this.supervisor.restart(...args);
  }
  child(
    ...args: Parameters<FleetRuntimeSupervisor["child"]>
  ): ReturnType<FleetRuntimeSupervisor["child"]> {
    return this.supervisor.child(...args);
  }
}
