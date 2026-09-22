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

  constructor(
    private readonly slots: readonly WorkerSlotDefinition[],
    validatedMaxWorkersPerGpu: 1 | 2 = 1,
  ) {
    if (slots.length === 0 || slots.length > 16)
      throw new TypeError("Machine supervisor requires 1 to 16 slots");
    if (new Set(slots.map((slot) => slot.workerId)).size !== slots.length)
      throw new TypeError("Machine supervisor worker IDs must be unique");
    const perGpu = new Map<string, number>();
    for (const slot of slots) {
      const count = (perGpu.get(slot.gpuId) ?? 0) + 1;
      if (count > validatedMaxWorkersPerGpu)
        throw new TypeError(
          "Machine supervisor exceeds validated GPU capacity",
        );
      perGpu.set(slot.gpuId, count);
    }
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
    const slot = this.slots.find(
      (candidate) => candidate.workerId === workerId,
    );
    if (!slot) throw new Error("Worker slot is not configured");

    const previous = this.children.get(workerId);
    if (previous) await previous.stop();

    // A terminated process can reject its active request before Node has
    // delivered the exit event that clears WorkerChildProcess.child. Reusing
    // that wrapper races with the exit handler and can leave the slot
    // permanently unavailable. A restart is a new process incarnation, so it
    // must also use a fresh lifecycle wrapper.
    const replacement = new WorkerChildProcess(slot.child);
    this.children.set(workerId, replacement);
    try {
      await replacement.start();
      return replacement;
    } catch (error) {
      await replacement.stop();
      if (this.children.get(workerId) === replacement)
        this.children.delete(workerId);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(
      [...this.children.values()].map((child) => child.stop()),
    );
    this.children.clear();
  }
}
