import { createHash, randomUUID } from "node:crypto";
import type { HostContext } from "../host-context.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import { newPrivateFile } from "../prepare/private-files.js";
import {
  CloudScratchWorkspace,
  type CloudScratchAdmission,
} from "../cloud/workspace.js";
import {
  MediaShutdownPending,
  runOwnedMediaOperation,
  mediaToolRelease,
} from "../prepare/owned-media-operation.js";
import type { VerifiedPlaybackFile } from "./media-server.js";
import {
  parseSilenceChildResult,
  type SilenceChildConfig,
} from "./silence-child.js";
import type { SilenceRange } from "./silence-analysis.js";
/** Only an already verified/pinned Library descriptor may be copied into this fixed owned analysis scratch. */
export class WindowsSilenceRunner {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly workspaces = new Set<CloudScratchWorkspace>();
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private closing: Promise<void> | undefined;
  private disposed = false;
  activity(): { pending: number; workspaces: number; idle: boolean } {
    return {
      pending: this.pending.size,
      workspaces: this.workspaces.size,
      idle: this.pending.size === 0 && this.workspaces.size === 0,
    };
  }
  subscribeActivity(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }

  constructor(
    private readonly host: HostContext,
    private readonly tools: Pick<
      WindowsPreparationOperations,
      "snapshotMediaTools"
    >,
    private readonly admission: CloudScratchAdmission,
  ) {}
  run(
    file: VerifiedPlaybackFile,
    sha256: string,
    durationSeconds: number,
    signal: AbortSignal,
  ): Promise<SilenceRange[]> {
    if (this.disposed) return Promise.reject(new Error("SILENCE_UNAVAILABLE"));
    const work = Promise.resolve().then(() =>
      this.runOperation(
        file,
        sha256,
        durationSeconds,
        AbortSignal.any([signal, this.lifetime.signal]),
      ),
    );
    this.pending.add(work);
    this.changed();
    const done = () => {
      this.pending.delete(work);
      this.changed();
    };
    void work.then(done, done);
    return work;
  }
  private async runOperation(
    file: VerifiedPlaybackFile,
    sha256: string,
    durationSeconds: number,
    signal: AbortSignal,
  ): Promise<SilenceRange[]> {
    if (
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 7200
    )
      throw new Error("SILENCE_UNAVAILABLE");
    signal.throwIfAborted();
    await file.current();
    const requestId = randomUUID(),
      work = `prepare\\work\\${requestId}`,
      relative = `${work}\\voice.bin`;
    let workspace: CloudScratchWorkspace | undefined,
      failed = false,
      failure: unknown,
      resultRanges!: SilenceRange[];
    try {
      workspace = await CloudScratchWorkspace.create(
        this.host,
        this.admission,
        work,
        file.bytes + 1024 ** 2,
      );
      this.workspaces.add(workspace);
      this.changed();
      signal.throwIfAborted();
      const before = await file.file.stat({ bigint: true });
      if (
        before.size !== BigInt(file.bytes) ||
        !before.isFile() ||
        before.nlink !== 1n ||
        before.ino === 0n
      )
        throw new Error("SILENCE_UNAVAILABLE");
      const output = await newPrivateFile(this.host, relative),
        buffer = Buffer.alloc(65536),
        hash = createHash("sha256");
      let offset = 0;
      try {
        while (offset < file.bytes) {
          signal.throwIfAborted();
          const read = await file.file.read(
            buffer,
            0,
            Math.min(buffer.length, file.bytes - offset),
            offset,
          );
          if (!read.bytesRead) throw new Error("SILENCE_UNAVAILABLE");
          hash.update(buffer.subarray(0, read.bytesRead));
          offset += read.bytesRead;
          let written = 0;
          while (written < read.bytesRead) {
            const write = await output.write(
              buffer,
              written,
              read.bytesRead - written,
            );
            if (!write.bytesWritten) throw new Error("SILENCE_UNAVAILABLE");
            written += write.bytesWritten;
          }
        }
        await output.sync();
      } finally {
        await output.close();
      }
      const after = await file.file.stat({ bigint: true });
      await file.current();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        hash.digest("hex") !== sha256
      )
        throw new Error("SILENCE_UNAVAILABLE");
      const result = await runOwnedMediaOperation<
        SilenceChildConfig,
        ReturnType<typeof parseSilenceChildResult>
      >({
        host: this.host,
        tools: this.tools,
        signal,
        configuration: (verified) => ({
          version: 1,
          operation: "silence_analyze",
          requestId,
          executionId: randomUUID(),
          release: mediaToolRelease(verified),
          sid: this.host.identity.sid,
          manifestSha256: verified.manifestSha256,
          helperSha256: verified.nativeSha256,
          inputBytes: file.bytes,
          inputSha256: sha256,
          durationSeconds,
        }),
        resultRelative: () => `${work}\\silence-map.json`,
        parse: parseSilenceChildResult,
        maxResultBytes: 1024 ** 2,
        beforeLaunch: () => workspace!.beforeLaunch(),
        onOwner: (owner) => workspace!.onOwner(owner),
      });
      signal.throwIfAborted();
      await file.current();
      resultRanges = result.ranges;
    } catch (error) {
      if (error instanceof MediaShutdownPending) workspace?.markUnsafe();
      failed = true;
      failure = error;
    } finally {
      try {
        await workspace?.close();
        if (workspace) this.workspaces.delete(workspace);
        this.changed();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
    return resultRanges;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.lifetime.abort();
    return (this.closing = (async () => {
      await Promise.allSettled(this.pending);
      const results = await Promise.allSettled(
        [...this.workspaces].map(async (workspace) => {
          await workspace.close();
          this.workspaces.delete(workspace);
        }),
      );
      this.changed();
      if (results.some((result) => result.status === "rejected"))
        throw new Error("SILENCE_SHUTDOWN_PENDING");
      this.listeners.clear();
    })().finally(() => {
      if (this.workspaces.size) this.closing = undefined;
    }));
  }
}
