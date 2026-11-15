import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import type { WorkerRuntime } from "../../../../worker/src/runtime/worker-runtime.js";
import {
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { HostContext } from "../host-context.js";
import {
  StoreNodeIssuer,
  StorePersonalEngineChild,
} from "../session/store-node-issuer.js";

type RuntimeSupervisor = ConstructorParameters<typeof WorkerRuntime>[3];
const TOKEN = Symbol("store-fleet-machine-supervisor");
function deny(): never {
  throw new Error("FLEET_CONTEXT_INVALID");
}

/** Actual Fleet Node factory. Slots are receiving data; only the retained
 * issuer, fixed native plans and physical keeper can admit a processing child. */
export class StoreFleetMachineSupervisor implements RuntimeSupervisor {
  #host: HostContext;
  #issuer: StoreNodeIssuer;
  #gpu: DirectmlGpuIdentity;
  #slots: readonly { workerId: string; gpuId: string }[];
  #children = new Map<string, StorePersonalEngineChild>();
  #queue = Promise.resolve();
  private constructor(
    token: symbol,
    host: HostContext,
    issuer: StoreNodeIssuer,
    gpu: DirectmlGpuIdentity,
    slots: readonly { workerId: string; gpuId: string }[],
  ) {
    if (token !== TOKEN) deny();
    this.#host = host;
    this.#issuer = issuer;
    this.#gpu = gpu;
    this.#slots = slots;
    Object.freeze(this);
  }
  static async open(
    host: HostContext,
    issuer: StoreNodeIssuer,
    slots: readonly { workerId: string; gpuId: string }[],
    maximum: 1 | 2,
    gpu: DirectmlGpuIdentity,
  ): Promise<StoreFleetMachineSupervisor> {
    if (
      arguments.length !== 5 ||
      !(host instanceof HostContext) ||
      !Array.isArray(slots) ||
      (maximum !== 1 && maximum !== 2) ||
      slots.length < 1 ||
      slots.length > maximum
    )
      deny();
    const role = Object.getOwnPropertyDescriptor(
      StoreNodeIssuer.prototype,
      "nodeRole",
    )!.get!.call(issuer);
    if (role !== "fleet") deny();
    StoreNodeIssuer.prototype.assertNative.call(issuer, host.native);
    const ids = new Set<string>(),
      captured = slots.map((slot) => {
        if (
          !slot ||
          Object.getPrototypeOf(slot) !== Object.prototype ||
          Reflect.ownKeys(slot).length !== 2 ||
          Reflect.ownKeys(slot).some(
            (key) => key !== "workerId" && key !== "gpuId",
          )
        )
          deny();
        const workerId = Object.getOwnPropertyDescriptor(slot, "workerId"),
          gpuId = Object.getOwnPropertyDescriptor(slot, "gpuId");
        if (
          !workerId?.enumerable ||
          !("value" in workerId) ||
          !gpuId?.enumerable ||
          !("value" in gpuId) ||
          typeof workerId.value !== "string" ||
          typeof gpuId.value !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/u.test(workerId.value) ||
          !/^[a-zA-Z0-9_-]{1,128}$/u.test(gpuId.value) ||
          ids.has(workerId.value)
        )
          deny();
        ids.add(workerId.value);
        return Object.freeze({ workerId: workerId.value, gpuId: gpuId.value });
      });
    if (new Set(captured.map((slot) => slot.gpuId)).size !== 1) deny();
    await StoreNodeIssuer.prototype.codeView.call(issuer);
    const actual = resolveQualifiedGpuIdentity(
      gpu,
      await host.native.enumerateGpus(),
    );
    return new StoreFleetMachineSupervisor(
      TOKEN,
      host,
      issuer,
      Object.freeze({ ...actual }),
      Object.freeze(captured),
    );
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#queue.then(operation);
    this.#queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  async #create(
    workerId: string,
    onStage?: (workerId: string, stage: "loading" | "warming") => void,
  ): Promise<StorePersonalEngineChild> {
    const view = await StoreNodeIssuer.prototype.codeView.call(this.#issuer);
    resolveQualifiedGpuIdentity(
      this.#gpu,
      await this.#host.native.enumerateGpus(),
    );
    const sessionId = randomUUID(),
      relative = `fleet\\engine-session\\${sessionId}`;
    const sessionRoot = await this.#host.native.ensurePrivateDirectory(
        "personal",
        relative,
      ),
      fleetRoot = await this.#host.native.ensurePrivateDirectory("fleet"),
      jobsRoot = await this.#host.native.ensurePrivateDirectory(
        "fleet",
        "work",
      );
    if (
      sessionRoot !== win32.join(this.#host.personalRoot, relative) ||
      jobsRoot !== win32.join(fleetRoot, "work")
    )
      deny();
    const config = {
      version: 1,
      sessionId,
      sessionRoot,
      jobsRoot,
      releaseRoot: this.#issuer.workerRoot,
      modelPath: win32.join(this.#host.personalRoot, "models", MODEL.filename),
      sid: this.#host.identity.sid,
      gpuIdentity: this.#gpu,
    };
    const configRelative = `${relative}\\engine-config.json`;
    await StoreNodeIssuer.prototype.writeNewPrivateFile.call(
      this.#issuer,
      this.#host.native,
      configRelative,
      Buffer.from(JSON.stringify(config)),
    );
    const child = await StoreNodeIssuer.prototype.createFleetEngine.call(
      this.#issuer,
      configRelative,
      (stage: "loading" | "warming") => onStage?.(workerId, stage),
    );
    // Retain the actual child before admission, pipes, model loading or warming.
    this.#children.set(workerId, child);
    if (
      (await StoreNodeIssuer.prototype.codeView.call(this.#issuer)).binding
        .inventorySha256 !== view.binding.inventorySha256
    )
      deny();
    await child.start();
    return child;
  }
  start(
    onStage?: (workerId: string, stage: "loading" | "warming") => void,
  ): Promise<void> {
    return this.#serialize(async () => {
      if (this.#children.size) deny();
      try {
        for (const slot of this.#slots)
          await this.#create(slot.workerId, onStage);
      } catch (error) {
        try {
          await this.#stop();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "CHILD_SHUTDOWN_PENDING");
        }
        throw error;
      }
    });
  }
  child(workerId: string): StorePersonalEngineChild {
    const child = this.#children.get(workerId);
    if (!child) throw new Error("Worker slot is not active");
    return child;
  }
  restart(
    workerId: string,
    onStage?: (workerId: string, stage: "loading" | "warming") => void,
  ): Promise<StorePersonalEngineChild> {
    return this.#serialize(async () => {
      if (!this.#slots.some((slot) => slot.workerId === workerId)) deny();
      const original = this.#children.get(workerId);
      if (original) {
        await original.stop();
        this.#children.delete(workerId);
      }
      return this.#create(workerId, onStage);
    });
  }
  async #stop(): Promise<void> {
    const stopped = await Promise.allSettled(
      [...this.#children].map(async ([id, child]) => {
        await child.stop();
        this.#children.delete(id);
      }),
    );
    const failures = stopped.flatMap((row) =>
      row.status === "rejected" ? [row.reason as unknown] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "CHILD_SHUTDOWN_PENDING");
  }
  stop(): Promise<void> {
    return this.#serialize(() => this.#stop());
  }
}
