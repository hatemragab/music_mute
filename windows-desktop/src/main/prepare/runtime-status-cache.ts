import { createHash } from "node:crypto";
import { assertConsumerRelativePath } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import { CONSUMER_DLL_POLICY } from "../../../../worker/src/platform/windows/consumer-dlls.js";
import type { ReadinessFile } from "./readiness-cache.js";
import type { PrivateFileFingerprint } from "./private-files.js";
import {
  fingerprintIndexPath,
  readFingerprintChunks,
  writeFingerprintChunks,
  FINGERPRINT_INDEX_BYTES,
  FINGERPRINT_TOTAL_FILES,
} from "./fingerprint-chunks.js";
export interface RuntimeStatusBinding {
  sid: string;
  installationId: string;
  target: string;
  sequence: number;
  manifestSha256: string;
  dllPolicy: typeof CONSUMER_DLL_POLICY;
}
export interface RuntimeStatusPort {
  readMarker(): Promise<Buffer | null>;
  writeMarker(bytes: Buffer): Promise<void>;
  readCapsule(path: string, maximum: number): Promise<Buffer>;
  writeCapsule(path: string, bytes: Buffer): Promise<void>;
  fingerprint(path: string): Promise<PrivateFileFingerprint>;
}
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
function key(binding: RuntimeStatusBinding) {
  return digest(
    JSON.stringify([
      binding.sid,
      binding.installationId,
      binding.target,
      binding.sequence,
      binding.manifestSha256,
      binding.dllPolicy,
    ]),
  );
}
function base(binding: RuntimeStatusBinding) {
  return `prepare\\runtime-status\\${binding.target}`;
}
function invalid(): never {
  throw new Error("READINESS_INVALID");
}
function filesValid(files: ReadinessFile[], binding: RuntimeStatusBinding) {
  const paths = new Set<string>(),
    prefix = `runtime\\releases\\${binding.target}\\`;
  if (
    !files.length ||
    files.length > FINGERPRINT_TOTAL_FILES ||
    !/^[a-f0-9]{64}$/u.test(binding.target) ||
    !/^[a-f0-9]{64}$/u.test(binding.manifestSha256) ||
    binding.dllPolicy !== CONSUMER_DLL_POLICY
  )
    return invalid();
  for (const row of files) {
    if (
      !row ||
      Object.keys(row).sort().join() !== "fingerprint,path" ||
      typeof row.path !== "string" ||
      !row.path.startsWith(prefix)
    )
      return invalid();
    assertConsumerRelativePath(row.path);
    const normalized = row.path.normalize("NFC").toLowerCase(),
      fp = row.fingerprint;
    if (
      paths.has(normalized) ||
      !fp ||
      Object.keys(fp).sort().join() !==
        "bytes,changedAt,device,fileId,writtenAt" ||
      !Number.isSafeInteger(fp.bytes) ||
      fp.bytes < 0 ||
      [fp.device, fp.fileId, fp.writtenAt, fp.changedAt].some(
        (part) => typeof part !== "string" || !/^\d{1,30}$/u.test(part),
      ) ||
      fp.fileId === "0"
    )
      return invalid();
    paths.add(normalized);
  }
  if (!paths.has(`${prefix}release-manifest.json`.toLowerCase()))
    return invalid();
}
/** CPU tool status has runtime-only authority. It never queries boot/GPU/model,
 * and cannot replace full signed-file verification before launching a tool. */
export class RuntimeStatusCache {
  constructor(
    private readonly port: RuntimeStatusPort,
    private readonly deadlineMs = 8000,
  ) {
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 30_000
    )
      throw new Error("READINESS_DEADLINE_INVALID");
  }
  async capture(
    binding: RuntimeStatusBinding,
    paths: string[],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (
      paths.length > FINGERPRINT_TOTAL_FILES ||
      paths.reduce((n, path) => n + Buffer.byteLength(path), 0) > 32 * 1024 ** 2
    )
      return invalid();
    const files: ReadinessFile[] = [];
    for (const path of paths) {
      signal.throwIfAborted();
      files.push({ path, fingerprint: await this.port.fingerprint(path) });
    }
    filesValid(files, binding);
    const old = await this.port.readMarker();
    let previous: string | undefined;
    if (old && old.length <= 4096) {
      try {
        previous = JSON.parse(old.toString()).path;
      } catch {
        /* Explicit verified producer replaces only its fixed bounded slots. */
      }
    }
    const path = fingerprintIndexPath(base(binding), previous),
      chunks = await writeFingerprintChunks(this.port, path, files, signal);
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, binding, totalFiles: files.length, chunks }),
    );
    if (bytes.length > FINGERPRINT_INDEX_BYTES) return invalid();
    await this.port.writeCapsule(path, bytes);
    signal.throwIfAborted();
    await this.port.writeMarker(
      Buffer.from(
        JSON.stringify({
          version: 1,
          binding: key(binding),
          path,
          sha256: digest(bytes),
          bytes: bytes.length,
        }),
      ),
    );
  }
  async check(
    binding: RuntimeStatusBinding,
    caller: AbortSignal,
  ): Promise<boolean> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      off = () => {};
    const timeout = new Promise<boolean>((resolve) => {
      const stop = () => {
        abort.abort();
        resolve(false);
      };
      off = () => caller.removeEventListener("abort", stop);
      caller.addEventListener("abort", stop, { once: true });
      if (caller.aborted) stop();
      timer = setTimeout(stop, this.deadlineMs);
    });
    const work = async () => {
      abort.signal.throwIfAborted();
      const markerBytes = await this.port.readMarker();
      if (!markerBytes || markerBytes.length > 4096) return false;
      const marker = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(markerBytes),
      );
      if (
        !marker ||
        Object.keys(marker).sort().join() !==
          "binding,bytes,path,sha256,version" ||
        marker.version !== 1 ||
        marker.binding !== key(binding) ||
        ![0, 1].some(
          (slot) => marker.path === `${base(binding)}\\slot${slot}\\index.json`,
        ) ||
        !/^[a-f0-9]{64}$/u.test(marker.sha256) ||
        !Number.isSafeInteger(marker.bytes) ||
        marker.bytes < 1 ||
        marker.bytes > FINGERPRINT_INDEX_BYTES
      )
        return invalid();
      const bytes = await this.port.readCapsule(
        marker.path,
        FINGERPRINT_INDEX_BYTES,
      );
      abort.signal.throwIfAborted();
      if (bytes.length !== marker.bytes || digest(bytes) !== marker.sha256)
        return invalid();
      const index = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (
        !index ||
        Object.keys(index).sort().join() !==
          "binding,chunks,totalFiles,version" ||
        index.version !== 1 ||
        !index.binding ||
        Object.keys(index.binding).sort().join() !==
          "dllPolicy,installationId,manifestSha256,sequence,sid,target" ||
        key(index.binding) !== key(binding)
      )
        return invalid();
      const files = await readFingerprintChunks(
        this.port,
        marker.path,
        index.chunks,
        index.totalFiles,
        abort.signal,
      );
      filesValid(files, binding);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, files.length) }, async () => {
          while (cursor < files.length) {
            abort.signal.throwIfAborted();
            const row = files[cursor++]!,
              actual = await this.port.fingerprint(row.path);
            abort.signal.throwIfAborted();
            if (
              actual.device !== row.fingerprint.device ||
              actual.fileId !== row.fingerprint.fileId ||
              actual.bytes !== row.fingerprint.bytes ||
              actual.writtenAt !== row.fingerprint.writtenAt ||
              actual.changedAt !== row.fingerprint.changedAt
            )
              return invalid();
          }
        }),
      );
      const after = await this.port.readMarker();
      abort.signal.throwIfAborted();
      return !!after && after.equals(markerBytes);
    };
    try {
      return await Promise.race([
        work().catch(() => {
          abort.abort();
          return false;
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      off();
    }
  }
}
