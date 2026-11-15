import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import { FileCapabilities } from "../file-capabilities.js";
import { hashPrivateFile, newPrivateFile } from "../prepare/private-files.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import type { CloudMediaPort } from "./controller.js";
import { WindowsCloudMediaRunner } from "./media-runner.js";
import { downloadCloudOutput, uploadCloudAudio } from "./transfers.js";
import {
  CloudScratchWorkspace,
  type CloudScratchAdmission,
} from "./workspace.js";
import { MediaShutdownPending } from "../prepare/owned-media-operation.js";
import type { FileHandle } from "node:fs/promises";
import type {
  JobMetadata,
  DownloadGrant,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
interface Context {
  requestId: string;
  scope: AccountSessionScope;
  signal: AbortSignal;
  assertCurrent(): void;
}
/** Safe file capabilities and current-user scratch; actual tools execute in an owned native Prepare tree. */
export class WindowsCloudMedia implements CloudMediaPort {
  private readonly runner: WindowsCloudMediaRunner;
  private readonly results = new Map<
    string,
    {
      scope: AccountSessionScope;
      owner: string;
      workspace: CloudScratchWorkspace;
      expiresAt: number;
    }
  >();
  private readonly borrowed = new Set<Promise<void>>();
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly retained = new Set<CloudScratchWorkspace>();
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  activity() {
    const pending = this.pending.size,
      grants = this.results.size,
      borrowed = this.borrowed.size,
      workspaces = this.retained.size;
    const busy =
      pending > 0 ||
      grants > 0 ||
      borrowed > 0 ||
      workspaces > 0 ||
      (!!this.closing && !this.closed);
    return { pending, grants, borrowed, workspaces, busy, idle: !busy };
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
  private track<T>(action: () => Promise<T>, cleanup = false): Promise<T> {
    if (this.disposed && !cleanup)
      return Promise.reject(new Error("CLOUD_UNAVAILABLE"));
    const task = Promise.resolve()
      .then(action)
      .finally(() => {
        this.pending.delete(task);
        this.changed();
      });
    this.pending.add(task);
    this.changed();
    return task;
  }
  private async closeWorkspace(
    workspace: CloudScratchWorkspace,
  ): Promise<void> {
    await workspace.close();
    this.retained.delete(workspace);
    this.changed();
  }
  constructor(
    private readonly options: {
      host: HostContext;
      tools: Pick<WindowsPreparationOperations, "snapshotMediaTools">;
      files: FileCapabilities;
      fileOwner: string | (() => string);
      admission: CloudScratchAdmission;
      fetch?: typeof fetch;
    },
  ) {
    this.runner = new WindowsCloudMediaRunner(options.host, options.tools);
  }
  private fileOwner(): string {
    const owner =
      typeof this.options.fileOwner === "function"
        ? this.options.fileOwner()
        : this.options.fileOwner;
    if (!owner || owner.length > 256 || /[\p{Cc}\p{Cf}]/u.test(owner))
      throw new Error("CLOUD_INPUT_INVALID");
    return owner;
  }
  private work(context: Context) {
    if (!UUID.test(context.requestId)) throw new Error("CLOUD_INPUT_INVALID");
    context.assertCurrent();
    context.signal.throwIfAborted();
    if (this.disposed) throw new Error("CLOUD_UNAVAILABLE");
    return `cloud\\work\\${context.requestId}`;
  }
  prepareFile(
    source: { capability: string; name: string; bytes: number },
    context: Context,
  ) {
    return this.track(() => this.prepareFileOperation(source, context));
  }
  private async prepareFileOperation(
    source: { capability: string; name: string; bytes: number },
    context: Context,
  ) {
    const host = this.options.host,
      work = this.work(context);
    const originalRelative = `${work}\\original-media.bin`,
      preparedRelative = `${work}\\source.m4a`,
      original = await this.options.files.consume(
        source.capability,
        this.fileOwner(),
      );
    let copied = 0;
    let workspace: CloudScratchWorkspace | undefined;
    try {
      try {
        if (
          !Number.isSafeInteger(source.bytes) ||
          source.bytes < 1 ||
          source.bytes > 256 * 1024 ** 2
        )
          throw new Error("CLOUD_INPUT_INVALID");
        workspace = await CloudScratchWorkspace.create(
          host,
          this.options.admission,
          work,
          source.bytes + 100000000 + 65536,
        );
        this.retained.add(workspace);
        this.changed();
        const before = await original.file.stat({ bigint: true });
        if (
          before.size !== BigInt(source.bytes) ||
          original.bytes !== source.bytes
        )
          throw new Error("CLOUD_INPUT_INVALID");
        const output = await newPrivateFile(host, originalRelative);
        try {
          const buffer = Buffer.alloc(65536);
          for (;;) {
            context.assertCurrent();
            context.signal.throwIfAborted();
            const read = await original.file.read(
              buffer,
              0,
              buffer.length,
              copied,
            );
            if (read.bytesRead === 0) break;
            copied += read.bytesRead;
            if (copied > source.bytes) throw new Error("CLOUD_INPUT_INVALID");
            let offset = 0;
            while (offset < read.bytesRead) {
              const written = await output.write(
                buffer,
                offset,
                read.bytesRead - offset,
              );
              if (written.bytesWritten === 0)
                throw new Error("CLOUD_INPUT_INVALID");
              offset += written.bytesWritten;
            }
          }
          await output.sync();
        } finally {
          await output.close();
        }
        const after = await original.file.stat({ bigint: true });
        if (
          copied !== source.bytes ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new Error("CLOUD_INPUT_INVALID");
      } finally {
        await original.file.close();
      }
      const result = await this.runner.run(
        "cloud_prepare",
        context.requestId,
        copied,
        context.signal,
        workspace,
      );
      context.assertCurrent();
      const preparedPath = win32.join(host.personalRoot, preparedRelative);
      if (
        (await hashPrivateFile(
          host,
          preparedRelative,
          result.bytes,
          context.signal,
        )) !== Buffer.from(result.sha256, "base64").toString("hex")
      )
        throw new Error("CLOUD_INPUT_INVALID");
      const input = {
        extension: "m4a",
        content_type: "audio/mp4",
        bytes: result.bytes,
        duration_seconds: result.durationSeconds,
        sha256: result.sha256,
      };
      let closed = false;
      return {
        input,
        source: result.source,
        title:
          original.name.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 200) ||
          "Audio",
        upload: async (
          grant: Parameters<typeof uploadCloudAudio>[2],
          signal: AbortSignal,
        ) => {
          if (closed) throw new Error("CLOUD_INPUT_INVALID");
          context.assertCurrent();
          const file = await host.native.openPrivateFile(
            preparedRelative,
            "read",
            input.bytes,
          );
          if (!file) throw new Error("CLOUD_INPUT_INVALID");
          await uploadCloudAudio({ path: preparedPath, file }, input, grant, {
            signal,
            assertCurrent: context.assertCurrent,
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          });
        },
        close: async () => {
          if (closed) return;
          await this.track(() => this.closeWorkspace(workspace!), true);
          closed = true;
        },
      };
    } catch (error) {
      if (error instanceof MediaShutdownPending) workspace?.markUnsafe();
      if (workspace) await this.closeWorkspace(workspace).catch(() => {});
      throw error;
    }
  }
  download(
    job: JobMetadata,
    grant: DownloadGrant,
    context: Context,
  ): Promise<string> {
    return this.track(() => this.downloadOperation(job, grant, context));
  }
  private async downloadOperation(
    job: JobMetadata,
    grant: DownloadGrant,
    context: Context,
  ): Promise<string> {
    const host = this.options.host,
      work = this.work(context);
    if (!job.output || job.output.bytes < 1 || job.output.bytes > 100000000)
      throw new Error("CLOUD_REPLY_INVALID");
    const workspace = await CloudScratchWorkspace.create(
      host,
      this.options.admission,
      work,
      job.output.bytes + 65536,
    );
    this.retained.add(workspace);
    this.changed();
    const relative = `${work}\\result.mp3`,
      temporary = `${relative}.part`;
    try {
      const file = await newPrivateFile(host, temporary);
      try {
        await downloadCloudOutput(file, job, grant, {
          signal: context.signal,
          assertCurrent: context.assertCurrent,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
      } finally {
        await file.close();
      }
      context.assertCurrent();
      await host.native.validatePath("personal", relative, "absent");
      await rename(
        win32.join(host.personalRoot, temporary),
        win32.join(host.personalRoot, relative),
      );
      const result = await this.runner.run(
        "cloud_probe",
        context.requestId,
        job.output!.bytes,
        context.signal,
        workspace,
      );
      context.assertCurrent();
      if (
        result.bytes !== job.output!.bytes ||
        result.sha256 !== job.output!.sha256 ||
        Math.abs(
          result.durationSeconds -
            (job.output!.duration_seconds ?? job.input.duration_seconds),
        ) > 0.25 ||
        Math.abs(result.durationSeconds - job.input.duration_seconds) > 0.25
      )
        throw new Error("TIMELINE_INCOMPATIBLE");
      const owner = `${this.fileOwner()}:cloud:${createHash("sha256").update(`${context.scope.firebaseUid}:${context.scope.generation}`).digest("hex")}:${context.requestId}`,
        capability = await this.options.files.grant(
          win32.join(host.personalRoot, relative),
          owner,
        );
      context.assertCurrent();
      if (this.results.size >= 32) throw new Error("INPUT_LIMIT_REACHED");
      this.results.set(capability.capability, {
        scope: { ...context.scope },
        owner,
        workspace,
        expiresAt: Date.now() + 15 * 60000,
      });
      this.changed();
      this.scheduleExpiry();
      return capability.capability;
    } catch (error) {
      if (error instanceof MediaShutdownPending) workspace.markUnsafe();
      await this.closeWorkspace(workspace).catch(() => {});
      throw error;
    }
  }
  /** Trusted main broker supplies the current account scope; remembered old-account handles cannot be consumed. */
  consumeResult(capability: string, scope: AccountSessionScope) {
    return this.track(() => this.consumeResultOperation(capability, scope));
  }
  private async consumeResultOperation(
    capability: string,
    scope: AccountSessionScope,
  ) {
    const result = this.results.get(capability);
    if (
      !result ||
      result.scope.firebaseUid !== scope.firebaseUid ||
      result.scope.generation !== scope.generation ||
      result.expiresAt <= Date.now() ||
      this.disposed
    )
      throw new Error("ACCOUNT_CHANGED");
    this.results.delete(capability);
    this.changed();
    this.scheduleExpiry();
    let selected: { file: FileHandle; name: string; bytes: number };
    try {
      selected = await this.options.files.consume(capability, result.owner);
    } catch (error) {
      this.options.files.revokeOwner(result.owner);
      await this.closeWorkspace(result.workspace);
      throw error;
    }
    const originalClose = selected.file.close.bind(selected.file);
    let finish!: () => void,
      closed = false;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.borrowed.add(completion);
    this.changed();
    Object.defineProperty(selected.file, "close", {
      value: async () => {
        if (closed) return;
        await originalClose();
        try {
          await this.track(() => this.closeWorkspace(result.workspace), true);
        } finally {
          closed = true;
          this.borrowed.delete(completion);
          this.changed();
          finish();
        }
      },
    });
    return selected;
  }
  private scheduleExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    if (this.disposed || !this.results.size) return;
    const next = Math.min(
      ...[...this.results.values()].map((value) => value.expiresAt),
    );
    this.expiry = setTimeout(
      () => {
        void this.track(() => this.expireResults(), true).catch(() => {});
      },
      Math.max(1, next - Date.now()),
    );
    this.expiry.unref();
  }
  private async expireResults(
    scope?: AccountSessionScope | null,
  ): Promise<void> {
    for (const [id, result] of this.results)
      if (
        result.expiresAt <= Date.now() ||
        (scope !== undefined &&
          (!scope ||
            scope.firebaseUid !== result.scope.firebaseUid ||
            scope.generation !== result.scope.generation))
      ) {
        this.options.files.revokeOwner(result.owner);
        await this.closeWorkspace(result.workspace);
        this.results.delete(id);
        this.changed();
      }
    this.scheduleExpiry();
  }
  invalidateScope(scope: AccountSessionScope | null): Promise<void> {
    return this.track(() => this.expireResults(scope), true);
  }
  dispose(): Promise<void> {
    if (!this.closing) {
      this.disposed = true;
      if (this.expiry) clearTimeout(this.expiry);
      this.closing = (async () => {
        while (this.pending.size) await Promise.allSettled(this.pending);
        await Promise.allSettled(this.borrowed);
        await this.expireResults(null);
        await Promise.all(
          [...this.retained].map((workspace) => this.closeWorkspace(workspace)),
        );
        this.closed = true;
        this.changed();
        this.listeners.clear();
      })().catch((error) => {
        this.closing = undefined;
        this.changed();
        throw error;
      });
      this.changed();
    }
    return this.closing;
  }
}
