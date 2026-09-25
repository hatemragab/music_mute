import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiagnosticSpool } from "./diagnostic-spool.js";
import type { WorkerControlPlaneClient } from "./control-plane-client.js";

interface Batch {
  sequenceStart: number;
  sequenceEnd: number;
  localEnd: number;
  lines: string[];
}
interface DeliveryState {
  schemaVersion: 1;
  streamId: string;
  localAcknowledged: number;
  remoteAcknowledged: number;
  pending: Batch | null;
}
/** A separate bounded outbox pins exact retry boundaries despite log rotation. */
export class DiagnosticForwarder {
  private inFlight: Promise<void> | null = null;
  private readonly stopping = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private nextAttemptAt = 0;
  constructor(
    private readonly statePath: string,
    private readonly spool: Pick<DiagnosticSpool, "deliveryRecords">,
    private readonly control: Pick<
      WorkerControlPlaneClient,
      "appendDiagnosticLogs"
    > &
      Partial<Pick<WorkerControlPlaneClient, "diagnosticLogCursor">>,
    private readonly identity: { sessionId: string; incarnation: string },
    private readonly report: (code: string) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pump().catch(() => {});
    }, 5000);
    this.timer.unref();
    void this.pump().catch(() => {});
  }
  stop(): void {
    clearInterval(this.timer);
    this.stopping.abort();
  }
  pump(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopping.signal.aborted || Date.now() < this.nextAttemptAt)
      return Promise.resolve();
    this.inFlight = this.deliver()
      .then(() => {
        this.failures = 0;
      })
      .catch((error: unknown) => {
        if (this.stopping.signal.aborted) throw error;
        this.failures++;
        this.nextAttemptAt =
          Date.now() +
          Math.min(300_000, 5000 * 2 ** Math.min(this.failures, 6));
        this.report("diagnostic-delivery-deferred");
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
  private async deliver(): Promise<void> {
    let state = await this.readState();
    if (!state?.pending) {
      let source = await this.spool.deliveryRecords(
        state?.localAcknowledged ?? 0,
      );
      if (state && state.streamId !== source.streamId) {
        // A replacement spool starts its own local sequence. The durable outbox
        // retains the machine-wide remote cursor; pending old-stream data is
        // always acknowledged above this branch before changing streams.
        const expectedStream = source.streamId;
        source = await this.spool.deliveryRecords(0);
        if (source.streamId !== expectedStream)
          throw new Error("Diagnostic stream changed during reconciliation");
        state = { ...state, streamId: source.streamId, localAcknowledged: 0 };
        await this.writeState(state);
      }
      if (!source.records.length) return;
      const remoteCursor = state
        ? state.remoteAcknowledged
        : ((await this.control.diagnosticLogCursor?.(
            this.identity.sessionId,
            this.identity.incarnation,
            AbortSignal.any([
              this.stopping.signal,
              AbortSignal.timeout(10_000),
            ]),
          )) ?? 0);
      state ??= {
        schemaVersion: 1,
        streamId: source.streamId,
        localAcknowledged: 0,
        remoteAcknowledged: remoteCursor,
        pending: null,
      };
      const lines: string[] = [];
      let localEnd = state.localAcknowledged;
      for (const record of source.records) {
        const encoded = JSON.stringify(record);
        const count = Math.ceil(encoded.length / 850);
        if (lines.length + count > 20) break;
        for (let part = 0; part < count; part++) {
          lines.push(
            `${source.streamId}:${record.sequence}:${part + 1}/${count} ${encoded.slice(part * 850, (part + 1) * 850)}`,
          );
        }
        localEnd = record.sequence;
      }
      if (!lines.length)
        throw new Error("Diagnostic record exceeds delivery bound");
      state.pending = {
        sequenceStart: state.remoteAcknowledged + 1,
        sequenceEnd: state.remoteAcknowledged + lines.length,
        localEnd,
        lines,
      };
      await this.writeState(state);
    }
    this.stopping.signal.throwIfAborted();
    const batch = state.pending!;
    const acknowledged = await this.control.appendDiagnosticLogs(
      {
        ...this.identity,
        sequenceStart: batch.sequenceStart,
        sequenceEnd: batch.sequenceEnd,
        lines: batch.lines,
      },
      AbortSignal.any([this.stopping.signal, AbortSignal.timeout(10_000)]),
    );
    if (acknowledged.acknowledgedSequence !== batch.sequenceEnd)
      throw new Error(
        "Diagnostic acknowledgement does not match pending batch",
      );
    await this.writeState({
      ...state,
      localAcknowledged: batch.localEnd,
      remoteAcknowledged: batch.sequenceEnd,
      pending: null,
    });
  }
  private async readState(): Promise<DeliveryState | null> {
    let info;
    try {
      info = await lstat(this.statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 128 * 1024 ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new TypeError("Diagnostic delivery state is unsafe");
    const state = JSON.parse(
      await readFile(this.statePath, "utf8"),
    ) as DeliveryState;
    if (
      !state ||
      state.schemaVersion !== 1 ||
      !/^[a-f0-9-]{36}$/iu.test(state.streamId) ||
      !Number.isSafeInteger(state.localAcknowledged) ||
      state.localAcknowledged < 0 ||
      !Number.isSafeInteger(state.remoteAcknowledged) ||
      state.remoteAcknowledged < 0
    )
      throw new TypeError("Diagnostic delivery state is invalid");
    if (state.pending !== null) {
      const batch = state.pending;
      if (
        !batch ||
        !Array.isArray(batch.lines) ||
        batch.lines.length < 1 ||
        batch.lines.length > 20 ||
        batch.lines.some(
          (line) => typeof line !== "string" || line.length > 1000,
        ) ||
        batch.sequenceStart !== state.remoteAcknowledged + 1 ||
        batch.sequenceEnd !== batch.sequenceStart + batch.lines.length - 1 ||
        !Number.isSafeInteger(batch.localEnd) ||
        batch.localEnd <= state.localAcknowledged
      )
        throw new TypeError("Diagnostic pending batch is invalid");
    }
    return state;
  }
  private async writeState(state: DeliveryState): Promise<void> {
    const encoded = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(encoded) > 128 * 1024)
      throw new TypeError("Diagnostic outbox exceeds its byte limit");
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(encoded);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.statePath);
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.statePath), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
