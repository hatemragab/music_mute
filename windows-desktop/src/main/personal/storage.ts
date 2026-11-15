import { createHash, randomUUID } from "node:crypto";
import { lstat, rename, rm, rmdir, statfs, unlink } from "node:fs/promises";
import { win32 } from "node:path";
import type { FileCapabilities } from "../file-capabilities.js";
import type { HostContext } from "../host-context.js";
import {
  hashPrivateFile,
  newPrivateFile,
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  PERSONAL_FORMATS,
  PERSONAL_MAX_BYTES,
  PERSONAL_MAX_SECONDS,
  PERSONAL_UUID,
  type PersonalArtifact,
} from "../../shared/personal-contracts.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import {
  PersonalFailure,
  type PersonalStoragePort,
  type PersonalStoredInput,
  type PersonalStoredResult,
  type PersonalRequestReceipt,
} from "./controller.js";
import { acquireLibraryCacheLease } from "../library/cache-lease.js";
import { LibraryPins } from "../library/pins.js";
import {
  personalTimelineFromEngine,
  type PersonalTimeline,
} from "./timeline.js";
import {
  createReuseReceipt,
  parseCompletionReceipt,
  parseReuseSource,
} from "../reuse/receipts.js";
import {
  WindowsStorageWriteJournal,
  storageBirth,
  type StorageWrite,
  type StorageWriteLease,
} from "../storage/write-journal.js";
import { parsePersonalPair } from "../reuse/pair.js";

interface InputReceipt {
  version: 1;
  capability: string;
  ownerId: string;
  scope: SessionAccountScope | null;
  relative: string;
  name: string;
  bytes: number;
  sha256: string;
  expiresAt: number;
}
const key = (id: string) => `personal_input_${id}`;
const safeName = (name: string) =>
  name.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 255) || "Local file";
function fail(): never {
  throw new PersonalFailure("OUTPUT_INVALID");
}
/** Trusted desktop-side staging; the selected source descriptor is read-only and is never removed. */
export async function stagePersonalFile(
  host: HostContext,
  capabilities: FileCapabilities,
  capability: string,
  capabilityOwner: string,
  ownerId: string,
  scope: SessionAccountScope | null,
  signal: AbortSignal,
): Promise<string> {
  if (!PERSONAL_UUID.test(ownerId))
    throw new PersonalFailure("INVALID_REQUEST");
  const selected = await capabilities.consume(capability, capabilityOwner);
  const extension = win32.extname(selected.name).slice(1).toLowerCase();
  const stagedId = randomUUID(),
    relative = `personal\\inputs\\${stagedId}\\source.${extension}`;
  let complete = false;
  let write: StorageWrite | undefined,
    copiedBirth: { device: string; fileId: string; bornAt: string } | undefined;
  const writes = new WindowsStorageWriteJournal(host, (pid) => {
    if (!host.native.processIdentity) throw new Error("STORAGE_OWNER_INVALID");
    return host.native.processIdentity(pid);
  });
  const mutate = async <T>(action: () => Promise<T>): Promise<T> => {
    const lease = await acquireLibraryCacheLease(host, signal);
    try {
      return await action();
    } finally {
      await host.native.releaseMutex(lease);
    }
  };
  const finalize = async () => {
    let failure: unknown;
    try {
      if (!complete && write) {
        if (copiedBirth) {
          await host.native.validatePath("personal", relative, "file");
          const fingerprint = storageBirth(
            await lstat(win32.join(host.personalRoot, relative), {
              bigint: true,
            }),
          );
          if (JSON.stringify(fingerprint) !== JSON.stringify(copiedBirth))
            throw new PersonalFailure("INPUT_CHANGED");
          await unlink(win32.join(host.personalRoot, relative));
        }
        try {
          await host.native.validatePath(
            "personal",
            win32.dirname(relative),
            "directory",
          );
          await rmdir(win32.join(host.personalRoot, win32.dirname(relative)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      failure = error;
    }
    if (write) {
      // This copier has stopped even when deletion fails. Changed birth remains protected at recovery.
      try {
        const lease = await acquireLibraryCacheLease(host);
        try {
          await writes.finishOwned(write);
        } finally {
          await host.native.releaseMutex(lease);
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  try {
    if (!PERSONAL_FORMATS.has(extension))
      throw new PersonalFailure("INPUT_UNSUPPORTED");
    const space = await statfs(host.personalRoot, { bigint: true });
    if (space.bavail * space.bsize < 3n * 1024n ** 3n)
      throw new PersonalFailure("INPUT_LIMIT");
    const before = await selected.file.stat({ bigint: true });
    if (before.size < 1n || before.size > BigInt(PERSONAL_MAX_BYTES))
      throw new PersonalFailure("INPUT_LIMIT");
    if (space.bavail * space.bsize < 3n * 1024n ** 3n + before.size)
      throw new PersonalFailure("INPUT_LIMIT");
    await host.directory("personal\\inputs");
    const pins = new LibraryPins(host, (pid) => {
      if (!host.native.processIdentity)
        throw new Error("STORAGE_OWNER_INVALID");
      return host.native.processIdentity(pid);
    });
    write = await pins.exclusiveUnpinned([], async (guard) => {
      signal.throwIfAborted();
      await writes.reclaimInputsOwned(guard);
      return writes.beginOwned(win32.dirname(relative), "tree", {
        bytes: Number(before.size),
        expiresAt: Date.now() + 15 * 60000,
      });
    });
    const target = await newPrivateFile(host, relative);
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(1024 ** 2);
    let offset = 0;
    try {
      const { device, fileId, bornAt } = await target.info();
      copiedBirth = { device, fileId, bornAt };
      await mutate(() =>
        writes.recordInputBirthOwned(
          write!,
          win32.basename(relative),
          copiedBirth!,
        ),
      );
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await selected.file.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > Number(before.size))
          throw new PersonalFailure("INPUT_CHANGED");
        if (offset > PERSONAL_MAX_BYTES)
          throw new PersonalFailure("INPUT_LIMIT");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await target.writeFile(chunk);
      }
      await target.sync();
    } finally {
      await target.close();
    }
    const after = await selected.file.stat({ bigint: true });
    if (
      offset !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new PersonalFailure("INPUT_CHANGED");
    await host.native.validatePath("personal", relative, "file");
    const receipt: InputReceipt = {
      version: 1,
      capability: stagedId,
      ownerId,
      scope: structuredClone(scope),
      relative,
      name: safeName(selected.name),
      bytes: offset,
      sha256: hash.digest("hex"),
      expiresAt: write.input!.expiresAt,
    };
    await host.native.vaultWrite(
      "account",
      key(stagedId),
      Buffer.from(JSON.stringify(receipt)),
    );
    complete = true;
    return stagedId;
  } finally {
    try {
      await selected.file.close();
    } finally {
      await finalize();
    }
  }
}
export interface PersonalStorageLifecycle {
  assertRecoveredExit?(relative: string): Promise<void>;
  beginWrite?(
    relative: string,
    kind: "file" | "tree",
  ): Promise<StorageWriteLease>;
  trackWorkspace(relative: string): Promise<{ release(): Promise<void> }>;
  protectTree(
    relative: string,
    purpose: "processing",
  ): Promise<{ release(): Promise<void> }>;
  protectPlannedTree(
    relative: string,
    purpose: "processing",
  ): Promise<{ release(): Promise<void> }>;
  reserveVoice(
    bytes: number,
    relative: string,
  ): Promise<{ release(): Promise<void> }>;
}
export class PrivatePersonalStorage implements PersonalStoragePort {
  private readonly protections = new Map<
    string,
    { release(): Promise<void> }[]
  >();
  private readonly consumed = new Map<
    string,
    { relative: string; jobId: string }
  >();
  constructor(
    private readonly host: HostContext,
    private readonly lifecycle?: PersonalStorageLifecycle,
  ) {}
  async recover(receipt: PersonalRequestReceipt) {
    if (!PERSONAL_UUID.test(receipt.jobId)) fail();
    await this.assertRecoveredExit(receipt.jobId);
    const relative = `personal\\results\\${receipt.jobId}\\pair.json`;
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const pair = parsePersonalPair(
      JSON.parse(
        (await readPrivateBytes(this.host, relative, 32768)).toString("utf8"),
      ),
      this.host.report.installationId,
      receipt.jobId,
    );
    if (!pair.completion) return null;
    if (
      pair.completion.ownerId !== receipt.ownerId ||
      pair.completion.requestId !== receipt.requestId ||
      JSON.stringify(pair.completion.capturedAccountScope) !==
        JSON.stringify(receipt.capturedAccountScope ?? null)
    )
      fail();
    for (const kind of ["original", "vocals"] as const) {
      const artifact = pair.entry[kind];
      if (
        (await hashPrivateFile(
          this.host,
          `personal\\results\\${receipt.jobId}\\${pair.filenames[kind]}`,
          artifact.bytes,
          new AbortController().signal,
        )) !== artifact.sha256
      )
        fail();
    }
    return {
      view: pair.view,
      result: {
        original: pair.entry.original,
        vocals: pair.entry.vocals,
        ...(pair.timeline ? { timeline: pair.timeline } : {}),
      },
    };
  }
  async consume(
    capability: string,
    ownerId: string,
    scope: SessionAccountScope | null,
    signal: AbortSignal,
    jobId: string,
  ): Promise<PersonalStoredInput> {
    if (!PERSONAL_UUID.test(capability) || this.consumed.has(capability))
      throw new PersonalFailure("INVALID_REQUEST");
    const bytes = await this.host.native.vaultRead("account", key(capability));
    if (!bytes || bytes.length > 4096)
      throw new PersonalFailure("INPUT_CHANGED");
    let row: InputReceipt;
    try {
      row = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(bytes),
      ) as InputReceipt;
    } catch {
      throw new PersonalFailure("INPUT_CHANGED");
    }
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).sort().join() !==
        "bytes,capability,expiresAt,name,ownerId,relative,scope,sha256,version" ||
      row.version !== 1 ||
      row.capability !== capability ||
      row.ownerId !== ownerId ||
      JSON.stringify(row.scope) !== JSON.stringify(scope) ||
      row.expiresAt < Date.now() ||
      !Number.isSafeInteger(row.expiresAt) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 1 ||
      row.bytes > PERSONAL_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      typeof row.name !== "string" ||
      row.name.length > 255 ||
      !/^personal\\inputs\\[a-f0-9-]{36}\\source\.(mp3|m4a|mp4|mkv|mov|webm|opus|ogg|aac|wav|flac)$/.test(
        row.relative,
      ) ||
      row.relative.split("\\")[2] !== capability
    )
      throw new PersonalFailure("INPUT_CHANGED");
    if (!this.lifecycle) throw new PersonalFailure("PREPARE_REQUIRED");
    const sourcePin = await this.lifecycle.protectTree(
        win32.dirname(row.relative),
        "processing",
      ),
      protections = this.protections.get(jobId) ?? [];
    protections.push(sourcePin);
    this.protections.set(jobId, protections);
    // Consume the durable grant before reading input; crash recovery cannot replay it.
    await this.host.native.vaultDelete("account", key(capability));
    this.consumed.set(capability, { relative: row.relative, jobId });
    if (
      (await hashPrivateFile(this.host, row.relative, row.bytes, signal)) !==
      row.sha256
    )
      throw new PersonalFailure("INPUT_CHANGED");
    const input = `personal\\jobs\\${jobId}\\input\\${win32.basename(row.relative)}`;
    await this.host.directory(win32.dirname(input));
    await this.host.native.validatePath("personal", input, "absent");
    await this.host.native.validatePath("personal", row.relative, "file");
    signal.throwIfAborted();
    await rename(
      win32.join(this.host.personalRoot, row.relative),
      win32.join(this.host.personalRoot, input),
    );
    await this.host.native.validatePath("personal", input, "file");
    const lease = await acquireLibraryCacheLease(this.host);
    try {
      await this.host.native.validatePath(
        "personal",
        win32.dirname(row.relative),
        "directory",
      );
      await rmdir(
        win32.join(this.host.personalRoot, win32.dirname(row.relative)),
      );
      const writes = new WindowsStorageWriteJournal(this.host, (pid) => {
        if (!this.host.native.processIdentity)
          throw new Error("STORAGE_OWNER_INVALID");
        return this.host.native.processIdentity(pid);
      });
      await writes.consumeInputOwned(win32.dirname(row.relative));
    } finally {
      await this.host.native.releaseMutex(lease);
    }
    return {
      path: win32.join(this.host.personalRoot, input),
      name: row.name,
      bytes: row.bytes,
      sha256: row.sha256,
    };
  }
  async workDirectory(jobId: string): Promise<string> {
    if (!PERSONAL_UUID.test(jobId))
      throw new PersonalFailure("INVALID_REQUEST");
    const space = await statfs(this.host.personalRoot, { bigint: true });
    if (space.bavail * space.bsize < 3n * 1024n ** 3n)
      throw new PersonalFailure("INPUT_LIMIT");
    const relative = `personal\\jobs\\${jobId}`,
      directory = await this.host.directory(relative);
    if (!this.lifecycle) throw new PersonalFailure("PREPARE_REQUIRED");
    if (this.lifecycle && !this.protections.has(jobId))
      this.protections.set(jobId, [
        await this.lifecycle.trackWorkspace(relative),
      ]);
    return directory;
  }
  async commit(
    jobId: string,
    input: PersonalStoredInput,
    raw: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PersonalStoredResult> {
    if (!PERSONAL_UUID.test(jobId)) fail();
    if (!this.lifecycle?.beginWrite)
      throw new PersonalFailure("PREPARE_REQUIRED");
    await this.host.directory("personal\\results");
    const write = await this.lifecycle?.beginWrite?.(
      `personal\\results\\${jobId}.pending`,
      "tree",
    );
    try {
      return await this.commitVerified(jobId, input, raw, signal, write);
    } finally {
      await write?.settle();
    }
  }
  private async commitVerified(
    jobId: string,
    input: PersonalStoredInput,
    raw: Record<string, unknown>,
    signal: AbortSignal,
    write: StorageWriteLease,
  ): Promise<PersonalStoredResult> {
    const outputRelative = `personal\\jobs\\${jobId}\\engine\\${jobId}\\output\\vocals.mp3`,
      outputPath = win32.join(this.host.personalRoot, outputRelative);
    if (
      raw.attemptId !== jobId ||
      typeof raw.outputPath !== "string" ||
      win32.normalize(raw.outputPath).toLowerCase() !==
        win32.normalize(outputPath).toLowerCase() ||
      raw.contentType !== "audio/mpeg" ||
      raw.modelDigest !== MODEL.sha256 ||
      typeof raw.trimEnabled !== "boolean" ||
      raw.denoiseEnabled !== false ||
      raw.outputFormat !== "mp3" ||
      raw.outputBitrateKbps !== 160 ||
      raw.sampleRate !== 44100 ||
      raw.channels !== 2 ||
      !Number.isSafeInteger(raw.bytes) ||
      Number(raw.bytes) < 1 ||
      Number(raw.bytes) > 30_000_000 ||
      typeof raw.sha256 !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(raw.sha256) ||
      typeof raw.sourceDurationSeconds !== "number" ||
      !Number.isFinite(raw.sourceDurationSeconds) ||
      raw.sourceDurationSeconds <= 0 ||
      raw.sourceDurationSeconds > PERSONAL_MAX_SECONDS ||
      typeof raw.measuredOutputDurationSeconds !== "number" ||
      !Number.isFinite(raw.measuredOutputDurationSeconds) ||
      raw.measuredOutputDurationSeconds <= 0 ||
      !Number.isSafeInteger(raw.sourceSamples) ||
      Number(raw.sourceSamples) < 1 ||
      Number(raw.sourceSamples) > PERSONAL_MAX_SECONDS * 44100
    )
      fail();
    let timeline: PersonalTimeline;
    try {
      timeline = personalTimelineFromEngine(raw);
    } catch {
      fail();
    }
    const outputSha = Buffer.from(raw.sha256, "base64").toString("hex");
    if (
      (await hashPrivateFile(
        this.host,
        outputRelative,
        Number(raw.bytes),
        signal,
      )) !== outputSha
    )
      fail();
    let originalInput = input,
      originalDuration = raw.sourceDurationSeconds as number;
    if (raw.original !== undefined) {
      if (
        !raw.original ||
        typeof raw.original !== "object" ||
        Array.isArray(raw.original)
      )
        fail();
      const original = raw.original as Record<string, unknown>;
      const expected = win32.join(
        this.host.personalRoot,
        "personal",
        "jobs",
        jobId,
        "original.m4a",
      );
      if (
        Object.keys(original).sort().join() !==
          "bytes,contentType,durationSeconds,outputPath,sha256" ||
        original.outputPath !== expected ||
        original.contentType !== "audio/mp4" ||
        !Number.isSafeInteger(original.bytes) ||
        Number(original.bytes) < 1 ||
        Number(original.bytes) > 30_000_000 ||
        typeof original.sha256 !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(original.sha256) ||
        typeof original.durationSeconds !== "number" ||
        !Number.isFinite(original.durationSeconds) ||
        Math.abs(original.durationSeconds - originalDuration) > 0.25
      )
        fail();
      originalInput = {
        ...input,
        path: expected,
        bytes: Number(original.bytes),
        sha256: Buffer.from(original.sha256, "base64").toString("hex"),
      };
      originalDuration = original.durationSeconds;
    }
    const inputRelative = win32.relative(
      this.host.personalRoot,
      originalInput.path,
    );
    await this.host.native.validatePath("personal", inputRelative, "file");
    if (
      (await hashPrivateFile(
        this.host,
        inputRelative,
        originalInput.bytes,
        signal,
      )) !== originalInput.sha256
    )
      throw new PersonalFailure("INPUT_CHANGED");
    const staging = `personal\\results\\${jobId}.pending`;
    await this.host.directory(staging);
    await write.captureCreated(
      storageBirth(
        await lstat(win32.join(this.host.personalRoot, staging), {
          bigint: true,
        }),
      ),
    );
    if (!this.lifecycle) throw new PersonalFailure("PREPARE_REQUIRED");
    if (this.lifecycle) {
      const protections = this.protections.get(jobId) ?? [];
      this.protections.set(jobId, protections);
      protections.push(
        await this.lifecycle.reserveVoice(Number(raw.bytes), staging),
      );
      protections.push(await this.lifecycle.protectTree(staging, "processing"));
      protections.push(
        await this.lifecycle.protectPlannedTree(
          `personal\\results\\${jobId}`,
          "processing",
        ),
      );
    }
    const extension = win32.extname(originalInput.path).slice(1);
    if (!PERSONAL_FORMATS.has(extension)) fail();
    await this.copy(
      inputRelative,
      `${staging}\\original.${extension}`,
      originalInput.bytes,
      signal,
    );
    await this.copy(
      outputRelative,
      `${staging}\\vocals.mp3`,
      Number(raw.bytes),
      signal,
    );
    if (
      (await hashPrivateFile(
        this.host,
        `${staging}\\original.${extension}`,
        originalInput.bytes,
        signal,
      )) !== originalInput.sha256 ||
      (await hashPrivateFile(
        this.host,
        `${staging}\\vocals.mp3`,
        Number(raw.bytes),
        signal,
      )) !== outputSha
    )
      fail();
    const original: PersonalArtifact = {
      id: randomUUID(),
      kind: "original",
      name: input.name,
      bytes: originalInput.bytes,
      sha256: originalInput.sha256,
      durationSeconds: originalDuration,
      contentType: (
        {
          mp3: "audio/mpeg",
          m4a: "audio/mp4",
          mp4: "audio/mp4",
          mov: "video/quicktime",
          mkv: "video/x-matroska",
          webm: "audio/webm",
          ogg: "audio/ogg",
          opus: "audio/ogg",
          aac: "audio/aac",
          wav: "audio/wav",
          flac: "audio/flac",
        } as Record<string, string>
      )[extension]!,
    };
    const vocals: PersonalArtifact = {
      id: randomUUID(),
      kind: "vocals",
      name: input.name,
      bytes: Number(raw.bytes),
      sha256: outputSha,
      durationSeconds: raw.measuredOutputDurationSeconds,
      contentType: "audio/mpeg",
    };
    const reuseReceipt = createReuseReceipt(
      raw,
      input,
      original.sha256,
      vocals.sha256,
    );
    let completionReceipt,
      submittedSource:
        { kind: "file" } | { kind: "youtube"; videoId: string } | undefined;
    if (raw.completionContext !== undefined) {
      const context = raw.completionContext as Record<string, unknown>;
      if (
        !context ||
        typeof context !== "object" ||
        Array.isArray(context) ||
        Object.keys(context).sort().join() !==
          "capturedAccountScope,ownerId,requestId,submittedSource"
      )
        fail();
      const source = context.submittedSource as Record<string, unknown>;
      const identity = input.sourceIdentity
        ? parseReuseSource(input.sourceIdentity)
        : undefined;
      if (
        !source ||
        typeof source !== "object" ||
        Array.isArray(source) ||
        !["file", "youtube"].includes(String(source.kind))
      )
        fail();
      if (
        source.kind === "youtube" &&
        (typeof source.videoId !== "string" ||
          !/^[A-Za-z0-9_-]{11}$/.test(source.videoId) ||
          !identity ||
          identity.kind === "file" ||
          identity.videoId !== source.videoId ||
          identity.inputSha256 !== input.sha256 ||
          identity.inputBytes !== input.bytes)
      )
        fail();
      if (source.kind === "youtube")
        submittedSource = { kind: "youtube", videoId: String(source.videoId) };
      else submittedSource = { kind: "file" };
      if (
        source.kind === "file" &&
        input.sourceIdentity &&
        input.sourceIdentity.kind !== "file"
      )
        fail();
      completionReceipt = parseCompletionReceipt(
        {
          version: 1,
          installationId: this.host.report.installationId,
          jobId,
          ownerId: context.ownerId,
          requestId: context.requestId,
          capturedAccountScope: context.capturedAccountScope,
          originalSha256: original.sha256,
          vocalsSha256: vocals.sha256,
          completedAt: Date.now(),
        },
        {
          installationId: this.host.report.installationId,
          jobId,
          originalSha256: original.sha256,
          vocalsSha256: vocals.sha256,
        },
      );
    }
    await writePrivateAtomic(
      this.host,
      `${staging}\\pair.json`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          jobId,
          original: { ...original, filename: `original.${extension}` },
          vocals: { ...vocals, filename: "vocals.mp3" },
          timeline,
          ...(reuseReceipt ? { reuseReceipt } : {}),
          ...(completionReceipt ? { completionReceipt } : {}),
          ...(submittedSource ? { source: submittedSource } : {}),
        }),
      ),
    );
    signal.throwIfAborted();
    const final = `personal\\results\\${jobId}`;
    const lease = await acquireLibraryCacheLease(this.host, signal);
    try {
      await this.host.native.validatePath("personal", staging, "directory");
      await this.host.native.validatePath("personal", final, "absent");
      signal.throwIfAborted();
      await rename(
        win32.join(this.host.personalRoot, staging),
        win32.join(this.host.personalRoot, final),
      );
    } finally {
      await this.host.native.releaseMutex(lease);
    }
    return { original, vocals, timeline };
  }
  async cleanup(jobId: string, _keepResult: boolean): Promise<void> {
    if (!this.protections.has(jobId)) await this.assertRecoveredExit(jobId);
    const lease = await acquireLibraryCacheLease(this.host);
    try {
      for (const relative of [
        `personal\\jobs\\${jobId}`,
        `personal\\results\\${jobId}.pending`,
      ])
        await this.removeOwned(relative);
      // Canonical result directories were atomically published. A lost return/catalog acknowledgement
      // cannot revoke their immutable bytes or another consumer's pin; Library deletion owns that action.
      for (const [id, row] of this.consumed) {
        if (row.jobId !== jobId) continue;
        await this.removeOwned(win32.dirname(row.relative));
        this.consumed.delete(id);
      }
    } finally {
      await this.host.native.releaseMutex(lease);
    }
    for (const protection of this.protections.get(jobId) ?? [])
      await protection.release();
    this.protections.delete(jobId);
  }
  private async assertRecoveredExit(jobId: string): Promise<void> {
    const relative = `personal\\jobs\\${jobId}`;
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!this.lifecycle?.assertRecoveredExit)
      throw new PersonalFailure("STOP_UNCONFIRMED");
    try {
      await this.lifecycle.assertRecoveredExit(relative);
    } catch {
      throw new PersonalFailure("STOP_UNCONFIRMED");
    }
  }
  async artifactPath(
    jobId: string,
    artifactId: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!PERSONAL_UUID.test(jobId) || !PERSONAL_UUID.test(artifactId)) fail();
    const directory = `personal\\results\\${jobId}`;
    const raw = JSON.parse(
      (
        await readPrivateBytes(this.host, `${directory}\\pair.json`, 16384)
      ).toString("utf8"),
    ) as {
      version: number;
      jobId: string;
      original: PersonalArtifact & { filename: string };
      vocals: PersonalArtifact & { filename: string };
    };
    const artifact = [raw.original, raw.vocals].find(
      (item) => item.id === artifactId,
    );
    if (
      raw.version !== 1 ||
      raw.jobId !== jobId ||
      !artifact ||
      !/^(original\.(mp3|m4a|mp4|mkv|mov|webm|opus|ogg|aac|wav|flac)|vocals\.mp3)$/.test(
        artifact.filename,
      )
    )
      fail();
    const relative = `${directory}\\${artifact.filename}`;
    if (
      (await hashPrivateFile(this.host, relative, artifact.bytes, signal)) !==
      artifact.sha256
    )
      fail();
    return win32.join(this.host.personalRoot, relative);
  }
  private async copy(
    source: string,
    target: string,
    bytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > PERSONAL_MAX_BYTES)
      fail();
    const input = await this.host.native.openPrivateFile(source, "read", bytes);
    if (!input) fail();
    try {
      const before = await input.info();
      if (before.bytes !== bytes) fail();
      const output = await newPrivateFile(this.host, target);
      try {
        let offset = 0;
        const buffer = Buffer.alloc(Math.min(1024 ** 2, bytes));
        while (offset < bytes) {
          signal.throwIfAborted();
          const read = await input.read(
            buffer,
            0,
            Math.min(buffer.length, bytes - offset),
            offset,
          );
          if (!read.bytesRead) fail();
          offset += read.bytesRead;
          await output.writeFile(buffer.subarray(0, read.bytesRead));
        }
        signal.throwIfAborted();
        const after = await input.info();
        if (
          before.device !== after.device ||
          before.fileId !== after.fileId ||
          before.bornAt !== after.bornAt ||
          before.bytes !== after.bytes ||
          before.writtenAt !== after.writtenAt ||
          before.changedAt !== after.changedAt
        )
          fail();
        await output.sync();
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  }
  private async removeOwned(relative: string): Promise<void> {
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await this.host.native.validatePath("personal", relative, "directory");
    await rm(win32.join(this.host.personalRoot, relative), { recursive: true });
  }
}
