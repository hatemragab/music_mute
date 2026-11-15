import { randomBytes } from "node:crypto";
import {
  processIdentityToWire,
  sameConsumerProcess,
  type ConsumerOwnedProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";

export type GpuConsumer = "personal" | "fleet" | "prepare";
export interface GpuRequest {
  requestId: string;
  generation: string;
  kind: GpuConsumer;
  owner: ConsumerOwnedProcess;
  peer: ConsumerProcessIdentity;
  gpu: DirectmlGpuIdentity;
}
export interface GpuLease {
  request: GpuRequest;
  nonce: string;
}
export interface GpuPersistentState {
  version: 1;
  sid: string;
  gpuLuid: string;
  active: GpuLease | null;
}
export interface GpuBrokerPorts {
  sid: string;
  sessionId: number;
  gpu: DirectmlGpuIdentity;
  read(): Promise<GpuPersistentState | null>;
  write(value: GpuPersistentState): Promise<void>;
  verifyOwner(request: GpuRequest): Promise<void>;
  /** Prove the exact inference child tree exited, including descendants and cleanup. */
  treeExited(
    owner: ConsumerOwnedProcess,
    peer: ConsumerProcessIdentity,
  ): Promise<boolean>;
  /** Native cross-user/session guard delegated to the verified role's stable helper. */
  acquireGuard(
    luid: string,
    request: GpuRequest,
  ): Promise<{ release(): Promise<void> } | null>;
  legacyConflict(): Promise<boolean>;
  /** Set the fleet child's admission fence and wake its existing serialized scheduler. */
  fenceFleet(pending: boolean): Promise<void>;
}
export interface GpuBrokerView {
  state:
    | "starting"
    | "idle"
    | "fleet"
    | "personal"
    | "prepare"
    | "waiting-for-worker"
    | "recovering"
    | "blocked";
  waiting: number;
  problem: string | null;
}
type Waiting = {
  request: GpuRequest;
  promise: Promise<GpuLease>;
  resolve: (lease: GpuLease) => void;
  reject: (error: Error) => void;
  abort: () => void;
  signal: AbortSignal;
};
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function sameRequest(first: GpuRequest, second: GpuRequest): boolean {
  return (
    first.requestId === second.requestId &&
    first.generation === second.generation &&
    first.kind === second.kind &&
    sameConsumerProcess(first.owner.identity, second.owner.identity) &&
    first.owner.nonce === second.owner.nonce &&
    sameConsumerProcess(first.peer, second.peer) &&
    first.gpu.luid === second.gpu.luid
  );
}
/** One serialized authority per user/physical GPU; the backend scheduler remains unchanged. */
export class WindowsGpuBroker {
  private initialized = false;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private active: GpuLease | null = null;
  private guard: { release(): Promise<void> } | null = null;
  private readonly waiting: Waiting[] = [];
  private readonly completed = new Map<string, string>();
  private readonly listeners = new Set<(view: GpuBrokerView) => void>();
  private value: GpuBrokerView = {
    state: "starting",
    waiting: 0,
    problem: null,
  };
  constructor(private readonly ports: GpuBrokerPorts) {}
  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.initialized) return;
      const previous = await this.ports.read();
      if (
        previous &&
        (previous.version !== 1 ||
          previous.sid !== this.ports.sid ||
          previous.gpuLuid !== this.ports.gpu.luid)
      )
        throw this.block("RESERVATION_INVALID");
      if (previous?.active) {
        await this.validate(previous.active.request, true);
        if (!/^[a-f0-9]{64}$/.test(previous.active.nonce))
          throw this.block("RESERVATION_INVALID");
        // An abandoned kernel mutex alone cannot prove old inference stopped.
        if (
          !(await this.ports.treeExited(
            previous.active.request.owner,
            previous.active.request.peer,
          ))
        ) {
          this.active = previous.active;
          this.value.state = "recovering";
          this.initialized = true;
          this.emit();
          return;
        }
      }
      await this.persist(null);
      this.initialized = true;
      this.value = { state: "idle", waiting: 0, problem: null };
      this.emit();
    });
  }
  async acquire(request: GpuRequest, signal: AbortSignal): Promise<GpuLease> {
    signal.throwIfAborted();
    await this.start();
    let result!: Promise<GpuLease>;
    await this.serialize(async () => {
      this.assertOpen();
      await this.validate(request);
      signal.throwIfAborted();
      if (this.active?.request.requestId === request.requestId) {
        if (!sameRequest(this.active.request, request))
          throw new Error("REQUEST_ID_REUSED");
        result = Promise.resolve(structuredClone(this.active));
        return;
      }
      const duplicate = this.waiting.find(
        (item) => item.request.requestId === request.requestId,
      );
      if (duplicate) {
        if (!sameRequest(duplicate.request, request))
          throw new Error("REQUEST_ID_REUSED");
        result = duplicate.promise;
        return;
      }
      if (this.completed.has(request.requestId))
        throw new Error("REQUEST_ID_REUSED");
      if (this.waiting.length >= 16) throw new Error("GPU_BUSY");
      let waiter!: Waiting;
      result = new Promise<GpuLease>((resolve, reject) => {
        const abort = () => {
          void this.serialize(async () => {
            const index = this.waiting.findIndex(
              (item) => item.request.requestId === request.requestId,
            );
            if (index >= 0) {
              this.waiting.splice(index, 1);
              reject(new Error("GPU_WAIT_CANCELLED"));
              await this.progress();
            }
          }).catch(() => reject(new Error("GPU_COORDINATION_UNAVAILABLE")));
        };
        waiter = {
          request: structuredClone(request),
          promise: undefined as unknown as Promise<GpuLease>,
          resolve,
          reject,
          abort,
          signal,
        };
        signal.addEventListener("abort", abort, { once: true });
      });
      waiter.promise = result;
      this.waiting.push(waiter);
      void result.catch(() => {});
      try {
        await this.progress();
      } catch (error) {
        this.block(
          error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)
            ? error.message
            : "GPU_COORDINATION_UNAVAILABLE",
        );
        throw error;
      }
    });
    return result;
  }
  /** Called by the verified fleet runtime only after accepted work and all inference children finish. */
  release(lease: GpuLease): Promise<void> {
    return this.serialize(async () => {
      this.assertOpen();
      await this.validate(lease.request);
      if (!this.active) {
        if (this.completed.get(lease.request.requestId) === lease.nonce) {
          await this.progress();
          return;
        }
        throw new Error("GPU_LEASE_STALE");
      }
      if (
        this.active.nonce !== lease.nonce ||
        !sameRequest(this.active.request, lease.request)
      )
        throw new Error("GPU_LEASE_STALE");
      if (
        !(await this.ports.treeExited(lease.request.owner, lease.request.peer))
      )
        throw new Error("GPU_CHILDREN_STILL_ACTIVE");
      // Keep the durable ownership record until guard release has actually completed.
      await this.guard?.release();
      this.guard = null;
      await this.persist(null);
      this.active = null;
      this.completed.set(lease.request.requestId, lease.nonce);
      if (this.completed.size > 64)
        this.completed.delete(this.completed.keys().next().value!);
      await this.progress();
    });
  }
  /** Native role cleanup/recovery wakes this method; no status HTTP polling is involved. */
  recover(): Promise<void> {
    return this.serialize(async () => {
      this.assertOpen();
      if (this.active && this.value.state === "recovering") {
        if (
          !(await this.ports.treeExited(
            this.active.request.owner,
            this.active.request.peer,
          ))
        )
          return;
        await this.persist(null);
        this.active = null;
      }
      await this.progress();
    });
  }
  snapshot(): GpuBrokerView {
    return { ...this.value, waiting: this.waiting.length };
  }
  subscribe(listener: (view: GpuBrokerView) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Caller must stop owned role trees before releasing the broker's native helper. */
  close(): Promise<void> {
    return this.serialize(async () => {
      if (this.closed && !this.guard && !this.active) return;
      this.closed = true;
      for (const waiter of this.waiting.splice(0)) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(new Error("GPU_COORDINATION_UNAVAILABLE"));
      }
      if (
        this.active &&
        !(await this.ports.treeExited(
          this.active.request.owner,
          this.active.request.peer,
        ))
      ) {
        this.value.state = "blocked";
        this.value.problem = "GPU_CHILDREN_STILL_ACTIVE";
        this.emit();
        throw new Error("GPU_CHILDREN_STILL_ACTIVE");
      }
      await this.guard?.release();
      this.guard = null;
      await this.persist(null);
      this.active = null;
      this.value.state = "blocked";
      this.value.problem = "GPU_COORDINATION_UNAVAILABLE";
      this.emit();
    });
  }
  private async progress(): Promise<void> {
    if (this.closed) return;
    if (this.active) {
      if (
        this.active.request.kind === "fleet" &&
        this.waiting.some((item) => item.request.kind !== "fleet")
      ) {
        await this.ports.fenceFleet(true);
        this.value.state = "waiting-for-worker";
      }
      this.emit();
      return;
    }
    const next =
      this.waiting.find((item) => item.request.kind !== "fleet") ??
      this.waiting[0];
    if (!next) {
      await this.ports.fenceFleet(false);
      this.value = { state: "idle", waiting: 0, problem: null };
      this.emit();
      return;
    }
    if (next.signal.aborted) {
      this.waiting.splice(this.waiting.indexOf(next), 1);
      next.signal.removeEventListener("abort", next.abort);
      next.reject(new Error("GPU_WAIT_CANCELLED"));
      await this.progress();
      return;
    }
    if (await this.ports.legacyConflict())
      throw this.block("LEGACY_WORKER_CONFLICT");
    await this.validate(next.request);
    await this.ports.fenceFleet(next.request.kind !== "fleet");
    const guard = await this.ports.acquireGuard(
      this.ports.gpu.luid,
      next.request,
    );
    if (!guard) {
      this.value.state = "recovering";
      this.value.problem = "GPU_BUSY";
      this.emit();
      return;
    }
    if (next.signal.aborted) {
      await guard.release();
      await this.progress();
      return;
    }
    const lease = {
      request: structuredClone(next.request),
      nonce: randomBytes(32).toString("hex"),
    };
    try {
      await this.persist(lease);
    } catch (error) {
      await guard.release();
      throw error;
    }
    if (next.signal.aborted) {
      await guard.release();
      await this.persist(null);
      await this.progress();
      return;
    }
    this.guard = guard;
    this.active = lease;
    this.waiting.splice(this.waiting.indexOf(next), 1);
    next.signal.removeEventListener("abort", next.abort);
    this.value = {
      state: next.request.kind,
      waiting: this.waiting.length,
      problem: null,
    };
    next.resolve(structuredClone(lease));
    this.emit();
  }
  private async validate(
    request: GpuRequest,
    historical = false,
  ): Promise<void> {
    processIdentityToWire(request.owner.identity);
    processIdentityToWire(request.peer);
    if (
      !UUID.test(request.requestId) ||
      !UUID.test(request.generation) ||
      !["personal", "fleet", "prepare"].includes(request.kind) ||
      request.owner.role !== request.kind ||
      request.owner.identity.sid !== this.ports.sid ||
      (!historical &&
        request.owner.identity.sessionId !== this.ports.sessionId) ||
      request.peer.sid !== this.ports.sid ||
      (!historical && request.peer.sessionId !== this.ports.sessionId) ||
      !/^[a-f0-9]{64}$/.test(request.owner.nonce)
    )
      throw new Error("GPU_OWNER_DENIED");
    resolveQualifiedGpuIdentity(this.ports.gpu, [request.gpu]);
    if (!historical) await this.ports.verifyOwner(request);
  }
  private async persist(active: GpuLease | null): Promise<void> {
    try {
      await this.ports.write({
        version: 1,
        sid: this.ports.sid,
        gpuLuid: this.ports.gpu.luid,
        active,
      });
    } catch {
      throw this.block("RESERVATION_UNAVAILABLE");
    }
  }
  private block(problem: string): Error {
    this.value.state = "blocked";
    this.value.problem = problem;
    for (const waiter of this.waiting.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new Error(problem));
    }
    this.emit();
    return new Error(problem);
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* Observer cannot grant a reservation. */
      }
    }
  }
  private assertOpen(): void {
    if (!this.initialized || this.closed || this.value.state === "blocked")
      throw new Error("GPU_COORDINATION_UNAVAILABLE");
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
