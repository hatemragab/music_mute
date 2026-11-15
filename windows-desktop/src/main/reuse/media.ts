import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import { newPrivateFile } from "../prepare/private-files.js";
import {
  runOwnedMediaOperation,
  mediaToolRelease,
  MediaShutdownPending,
} from "../prepare/owned-media-operation.js";
import { parseCloudMediaResult } from "../cloud/media-runner.js";
import type { CloudMediaChildConfig } from "../cloud/media-child.js";
import { downloadCloudArtifact } from "../cloud/transfers.js";
import type {
  CommunityDelivery,
  CommunityArtifact,
} from "../../../../chrome-extension/src/companion/youtube-community-client.js";
import { CloudScratchWorkspace } from "../cloud/workspace.js";
import type {
  ReuseCopyArtifact,
  ReuseAdmissionPort,
} from "./guest-adoption.js";
export class WindowsReuseMedia {
  private readonly work = new WeakMap<
    FileHandle,
    {
      requestId: string;
      original: ReuseCopyArtifact;
      vocals?: ReuseCopyArtifact;
      workspace: CloudScratchWorkspace;
    }
  >();
  constructor(
    private readonly options: {
      host: HostContext;
      tools: Pick<WindowsPreparationOperations, "snapshotMediaTools">;
      admission: ReuseAdmissionPort;
      fetch?: typeof fetch;
    },
  ) {}
  async download(
    delivery: CommunityDelivery,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) {
    const downloaded = await this.downloadSelected(
      delivery.original,
      delivery.vocals,
      signal,
      assertCurrent,
    );
    if (!downloaded.vocals) {
      await downloaded.close();
      throw new Error("REUSE_ARTIFACT_INVALID");
    }
    return { ...downloaded, vocals: downloaded.vocals };
  }
  async downloadOriginal(
    original: CommunityArtifact,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) {
    return this.downloadSelected(original, undefined, signal, assertCurrent);
  }
  private async downloadSelected(
    originalArtifact: CommunityArtifact,
    vocalArtifact: CommunityArtifact | undefined,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) {
    const { host } = this.options,
      requestId = randomUUID(),
      root = `cloud\\work\\${requestId}`,
      opened: FileHandle[] = [];
    let workspace: CloudScratchWorkspace | undefined;
    const cleanup = async () => {
      await Promise.allSettled(opened.map((file) => file.close()));
      await workspace?.close();
    };
    try {
      signal.throwIfAborted();
      assertCurrent();
      const admission = this.options.admission;
      if (
        !admission.beginWrite ||
        !admission.trackWorkspace ||
        !admission.reserveScratch
      )
        throw new Error("STORAGE_NOT_READY");
      workspace = await CloudScratchWorkspace.create(
        host,
        {
          beginWrite: admission.beginWrite,
          protectTree: (relative, purpose) =>
            admission.protectTree(relative, purpose),
          trackWorkspace: admission.trackWorkspace,
          reserveScratch: admission.reserveScratch,
        },
        root,
        originalArtifact.declaration.bytes +
          (vocalArtifact?.declaration.bytes ?? 0) +
          100000000 +
          65536,
      );
      const download = async (
        kind: "original" | "vocals",
        name: string,
      ): Promise<ReuseCopyArtifact> => {
        const selected = kind === "original" ? originalArtifact : vocalArtifact;
        if (!selected) throw new Error("REUSE_ARTIFACT_INVALID");
        const item = selected.declaration,
          file = await newPrivateFile(host, `${root}\\${name}`);
        try {
          await downloadCloudArtifact(
            file,
            {
              bytes: item.bytes,
              sha256: Buffer.from(item.sha256, "hex").toString("base64"),
              content_type: item.content_type,
            },
            selected.grant,
            {
              signal,
              assertCurrent,
              ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
            },
          );
        } finally {
          await file.close();
        }
        await host.native.validatePath("personal", `${root}\\${name}`, "file");
        const readonly = await open(
          win32.join(host.personalRoot, root, name),
          "r",
        );
        opened.push(readonly);
        return {
          file: readonly,
          extension: item.extension,
          declaration: {
            id: randomUUID(),
            kind,
            name: "YouTube",
            bytes: item.bytes,
            sha256: item.sha256,
            durationSeconds: item.duration_seconds,
            contentType: item.content_type,
          },
        };
      };
      const original = await download("original", "original-media.bin"),
        vocals = vocalArtifact
          ? await download("vocals", "result.mp3")
          : undefined;
      this.work.set(original.file, {
        requestId,
        original,
        ...(vocals ? { vocals } : {}),
        workspace,
      });
      return {
        original,
        vocals,
        close: cleanup,
        markUnsafe: () => {
          workspace?.markUnsafe();
        },
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  async validate(
    original: ReuseCopyArtifact,
    vocals: ReuseCopyArtifact,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<void> {
    const work = this.work.get(original.file);
    if (!work || work.original !== original || work.vocals !== vocals)
      throw new Error("REUSE_ARTIFACT_INVALID");
    await this.validateWork(
      work,
      ["cloud_prepare", "cloud_probe"],
      signal,
      assertCurrent,
    );
  }
  async validateOriginal(
    original: ReuseCopyArtifact,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<void> {
    const work = this.work.get(original.file);
    if (!work || work.original !== original || work.vocals)
      throw new Error("REUSE_ARTIFACT_INVALID");
    await this.validateWork(work, ["cloud_prepare"], signal, assertCurrent);
  }
  private async validateWork(
    work: NonNullable<ReturnType<WindowsReuseMedia["work"]["get"]>>,
    operations: readonly ("cloud_prepare" | "cloud_probe")[],
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<void> {
    for (const operation of operations) {
      assertCurrent();
      signal.throwIfAborted();
      const inputBytes =
        operation === "cloud_prepare"
          ? work.original.declaration.bytes
          : work.vocals!.declaration.bytes;
      const result = await runOwnedMediaOperation<
        CloudMediaChildConfig,
        ReturnType<typeof parseCloudMediaResult>
      >({
        host: this.options.host,
        tools: this.options.tools,
        signal,
        configuration: (verified) => ({
          version: 1,
          operation,
          requestId: work.requestId,
          executionId: randomUUID(),
          release: mediaToolRelease(verified),
          sid: this.options.host.identity.sid,
          manifestSha256: verified.manifestSha256,
          helperSha256: verified.nativeSha256,
          inputBytes,
        }),
        resultRelative: () =>
          `cloud\\work\\${work.requestId}\\media-result.json`,
        parse: parseCloudMediaResult,
        maxResultBytes: 4096,
        beforeLaunch: () => work.workspace.beforeLaunch(),
        onOwner: (owner) => work.workspace.onOwner(owner),
      });
      assertCurrent();
      const item =
        operation === "cloud_prepare"
          ? work.original.declaration
          : work.vocals!.declaration;
      if (
        Math.abs(result.durationSeconds - item.durationSeconds) > 0.25 ||
        result.source !== "audio_file" ||
        (operation === "cloud_probe" &&
          (result.bytes !== item.bytes ||
            Buffer.from(result.sha256, "base64").toString("hex") !==
              item.sha256))
      )
        throw new Error("TIMELINE_INCOMPATIBLE");
    }
  }
  static shutdownPending(error: unknown): boolean {
    return error instanceof MediaShutdownPending;
  }
}
