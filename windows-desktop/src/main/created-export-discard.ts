import type {
  ConsumerAccountAppPin,
  WindowsConsumerNative,
} from "../../../worker/src/platform/windows/consumer-native.js";
import type {
  CreatedExportDiscardPort,
  CreatedExportDiscardRequest,
} from "./save-destinations.js";

type ExportNative = Pick<
  WindowsConsumerNative,
  | "processIdentity"
  | "discardCreatedExport"
  | "acknowledgeCreatedExportDiscard"
  | "close"
  | "validateExportDestination"
>;

/** Main-only export cleanup. Every operation uses the fixed signed app helper;
 * its actual exit is awaited and unknown helper cleanup remains retained. */
export class WindowsCreatedExportDiscards {
  private readonly retired = new Set<ExportNative>();
  private readonly active = new Set<Promise<unknown>>();
  private recovery: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(
    private readonly options: {
      openNative(): Promise<ExportNative>;
      appPin(): Promise<ConsumerAccountAppPin>;
      creatorPid: number;
    },
  ) {}
  activity() {
    return {
      pending: this.active.size,
      retained: this.retired.size,
      idle: this.active.size === 0 && this.retired.size === 0,
    };
  }
  recoverCleanup(): Promise<void> {
    if (this.recovery) return this.recovery;
    const task = Promise.allSettled(
      [...this.retired].map(async (native) => {
        await native.close();
        this.retired.delete(native);
      }),
    )
      .then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new Error("EXPORT_UNAVAILABLE");
      })
      .finally(() => {
        if (this.recovery === task) this.recovery = undefined;
      });
    this.recovery = task;
    return task;
  }
  private run<T>(
    work: (native: ExportNative, pin: ConsumerAccountAppPin) => Promise<T>,
    approvedPin?: ConsumerAccountAppPin,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("EXPORT_UNAVAILABLE"));
    const task = this.tail
      .then(async () => {
        await this.recoverCleanup();
        if (this.closed) throw new Error("EXPORT_UNAVAILABLE");
        const pin =
          approvedPin ?? Object.freeze({ ...(await this.options.appPin()) });
        if (this.closed) throw new Error("EXPORT_UNAVAILABLE");
        const native = await this.options.openNative();
        try {
          if (this.closed) throw new Error("EXPORT_UNAVAILABLE");
          return await work(native, pin);
        } finally {
          this.retired.add(native);
          await native.close();
          this.retired.delete(native);
        }
      })
      .finally(() => {
        this.active.delete(task);
      });
    this.tail = task.then(
      () => {},
      () => {},
    );
    this.active.add(task);
    return task;
  }
  readonly discard: CreatedExportDiscardPort = (
    request: Readonly<CreatedExportDiscardRequest>,
  ) =>
    this.run(async (native, pin) => {
      const creator = await native.processIdentity(this.options.creatorPid);
      if (!creator) throw new Error("EXPORT_UNAVAILABLE");
      const result = await native.discardCreatedExport(
        { ...request, creator },
        pin,
      );
      if (result.state === "pending") return { state: "pending" as const };
      const { requestId, nonce } = result;
      return {
        state: "completed" as const,
        // The positive certificate authorizes retiring receipt metadata only.
        // A retry never repeats deletion or probes an absent path as success.
        acknowledge: () =>
          this.run(
            (ackNative) =>
              ackNative.acknowledgeCreatedExportDiscard(requestId, nonce, pin),
            pin,
          ),
      };
    });
  validateDestination = (path: string): Promise<void> =>
    this.run((native, pin) => native.validateExportDestination(path, pin));
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.active);
    await this.recoverCleanup();
    if (!this.activity().idle) throw new Error("EXPORT_UNAVAILABLE");
  }
}
