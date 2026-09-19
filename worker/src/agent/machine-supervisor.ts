import {
  WorkerChildProcess,
  type ChildProcessOptions,
} from "./child-process.js";

export interface WorkerSlotDefinition {
  workerId: string;
  gpuId: string;
  child: ChildProcessOptions;
}

export class MachineSupervisor {
  private readonly children = new Map<string, WorkerChildProcess>();

  constructor(private readonly slots: readonly WorkerSlotDefinition[]) {
    if (slots.length === 0 || slots.length > 16)
      throw new TypeError("Machine supervisor requires 1 to 16 slots");
    if (new Set(slots.map((slot) => slot.workerId)).size !== slots.length)
      throw new TypeError("Machine supervisor worker IDs must be unique");
    if (new Set(slots.map((slot) => slot.gpuId)).size !== slots.length)
      throw new TypeError(
        "Machine supervisor allows only one initial child per GPU",
      );
  }

  async start(): Promise<void> {
    try {
      for (const slot of this.slots) {
        const child = new WorkerChildProcess(slot.child);
        this.children.set(slot.workerId, child);
        await child.start();
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  child(workerId: string): WorkerChildProcess {
    const child = this.children.get(workerId);
    if (!child) throw new Error("Worker slot is not active");
    return child;
  }

  async restart(workerId: string): Promise<WorkerChildProcess> {
    const child = this.child(workerId);
    await child.stop();
    await child.start();
    return child;
  }

  async stop(): Promise<void> {
    await Promise.allSettled(
      [...this.children.values()].map((child) => child.stop()),
    );
    this.children.clear();
  }
}
