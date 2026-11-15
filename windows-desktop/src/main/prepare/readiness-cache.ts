import { createHash } from "node:crypto";
import { assertConsumerRelativePath } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  parseConsumerGpu,
  type ConsumerGpuIdentity,
} from "../../../../worker/src/platform/windows/consumer-native-gpu.js";
import { resolveQualifiedGpuIdentity } from "../../../../worker/src/enrollment/report-builder.js";
import type { PrivateFileFingerprint } from "./private-files.js";
import {
  fingerprintIndexPath,
  readFingerprintChunks,
  writeFingerprintChunks,
  FINGERPRINT_TOTAL_FILES,
  FINGERPRINT_INDEX_BYTES,
} from "./fingerprint-chunks.js";

const MAX_BYTES = 2 * 1024 ** 2;
const MAX_FILES = 8192;
const HASH = /^[a-f0-9]{64}$/u;
export interface ReadinessBinding {
  bootIdentity: string;
  sid: string;
  installationId: string;
  target: string;
  sequence: number;
  manifestSha256: string;
  modelSha256: string;
  fixtureSha256: string;
  policy: "windows-user/directml/onnxruntime-1.24.4/no-cpu-v1";
}
export interface ReadinessFile {
  path: string;
  fingerprint: PrivateFileFingerprint;
}
interface Capsule {
  version: 2;
  binding: ReadinessBinding;
  gpu: ConsumerGpuIdentity;
  files: ReadinessFile[];
}
interface Marker {
  version: 2 | 3;
  binding: string;
  sha256: string;
  bytes: number;
  path: string;
}
export interface ReadinessCachePort {
  readMarker(): Promise<Buffer | null>;
  writeMarker(bytes: Buffer): Promise<void>;
  removeMarker(): Promise<void>;
  readCapsule(path: string, maximumBytes: number): Promise<Buffer>;
  writeCapsule(path: string, bytes: Buffer): Promise<void>;
  fingerprint(path: string): Promise<PrivateFileFingerprint>;
  enumerateGpus(): Promise<ConsumerGpuIdentity[]>;
  bootIdentity(): Promise<string>;
}
export interface ReadinessMeasurement {
  ready: boolean;
  reason: "verified" | "missing" | "changed" | "timeout" | "cancelled";
  filesChecked: number;
  durationMs: number;
}
function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function bindingHash(binding: ReadinessBinding): string {
  return digest(
    JSON.stringify([
      binding.bootIdentity,
      binding.sid,
      binding.installationId,
      binding.target,
      binding.sequence,
      binding.manifestSha256,
      binding.modelSha256,
      binding.fixtureSha256,
      binding.policy,
    ]),
  );
}
function fingerprint(value: unknown): PrivateFileFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("READINESS_INVALID");
  const row = value as PrivateFileFingerprint;
  if (
    Object.keys(row).sort().join() !==
      ["device", "fileId", "bytes", "writtenAt", "changedAt"].sort().join() ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes < 0 ||
    [row.device, row.fileId, row.writtenAt, row.changedAt].some(
      (part) => typeof part !== "string" || !/^\d{1,30}$/u.test(part),
    ) ||
    row.fileId === "0"
  )
    throw new Error("READINESS_INVALID");
  return row;
}
function sameFile(
  a: PrivateFileFingerprint,
  b: PrivateFileFingerprint,
): boolean {
  return (
    a.device === b.device &&
    a.fileId === b.fileId &&
    a.bytes === b.bytes &&
    a.writtenAt === b.writtenAt &&
    a.changedAt === b.changedAt
  );
}
function capsulePath(binding: ReadinessBinding): string {
  return `prepare\\readiness\\${binding.target}.json`;
}
function validateCapsule(
  row: Capsule,
  binding: ReadinessBinding,
  maximum = MAX_FILES,
): Capsule {
  if (
    !row ||
    Object.keys(row).sort().join() !==
      ["version", "binding", "gpu", "files"].sort().join() ||
    row.version !== 2 ||
    !row.binding ||
    Object.keys(row.binding).length !== 9 ||
    !HASH.test(row.binding.bootIdentity) ||
    bindingHash(row.binding) !== bindingHash(binding) ||
    !Array.isArray(row.files) ||
    row.files.length < 1 ||
    row.files.length > maximum
  )
    throw new Error("READINESS_INVALID");
  row.gpu = parseConsumerGpu(row.gpu);
  const paths = new Set<string>();
  for (const file of row.files) {
    if (
      !file ||
      Object.keys(file).sort().join() !== ["path", "fingerprint"].sort().join()
    )
      throw new Error("READINESS_INVALID");
    assertConsumerRelativePath(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new Error("READINESS_INVALID");
    paths.add(key);
    fingerprint(file.fingerprint);
  }
  return row;
}
function decodeCapsule(bytes: Buffer, binding: ReadinessBinding): Capsule {
  return validateCapsule(
    JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(bytes),
    ) as Capsule,
    binding,
  );
}
/** This receipt accelerates status checks only. Execution still verifies its signed runtime and GPU policy. */
export class StartupReadinessCache {
  constructor(
    private readonly port: ReadinessCachePort,
    private readonly deadlineMs = 8000,
  ) {
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 30_000
    )
      throw new Error("READINESS_DEADLINE_INVALID");
  }
  invalidate(): Promise<void> {
    return this.port.removeMarker();
  }
  async capture(
    binding: ReadinessBinding,
    gpu: ConsumerGpuIdentity,
    paths: string[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if ((await this.port.bootIdentity()) !== binding.bootIdentity)
      throw new Error("READINESS_INVALID");
    if (
      !HASH.test(binding.target) ||
      !HASH.test(binding.bootIdentity) ||
      paths.length < 1 ||
      paths.length > FINGERPRINT_TOTAL_FILES ||
      paths.reduce((sum, path) => sum + Buffer.byteLength(path), 0) >
        32 * 1024 ** 2
    )
      throw new Error("READINESS_INVALID");
    const files: ReadinessFile[] = [];
    for (const path of paths) {
      signal.throwIfAborted();
      assertConsumerRelativePath(path);
      files.push({
        path,
        fingerprint: fingerprint(await this.port.fingerprint(path)),
      });
    }
    const capsule: Capsule = {
      version: 2,
      binding,
      gpu: parseConsumerGpu(gpu),
      files,
    };
    validateCapsule(capsule, binding, FINGERPRINT_TOTAL_FILES);
    let bytes =
        paths.length <= MAX_FILES
          ? Buffer.from(JSON.stringify(capsule))
          : Buffer.alloc(0),
      path = capsulePath(binding),
      version: 2 | 3 = 2;
    if (paths.length > MAX_FILES || bytes.length > MAX_BYTES) {
      const prior = await this.port.readMarker();
      let previous: string | undefined;
      if (prior && prior.length <= 4096) {
        try {
          previous = (JSON.parse(prior.toString("utf8")) as Marker).path;
        } catch {
          /* Repair never trusts malformed marker authority. */
        }
      }
      path = fingerprintIndexPath(capsulePath(binding).slice(0, -5), previous);
      const chunks = await writeFingerprintChunks(
        this.port,
        path,
        files,
        signal,
      );
      bytes = Buffer.from(
        JSON.stringify({
          version: 3,
          binding,
          gpu: capsule.gpu,
          totalFiles: files.length,
          chunks,
        }),
      );
      if (bytes.length > FINGERPRINT_INDEX_BYTES)
        throw new Error("READINESS_INVALID");
      version = 3;
    }
    await this.port.writeCapsule(path, bytes);
    signal.throwIfAborted();
    if ((await this.port.bootIdentity()) !== binding.bootIdentity)
      throw new Error("READINESS_INVALID");
    // The DPAPI marker is published last. An interrupted capsule write cannot establish readiness.
    await this.port.writeMarker(
      Buffer.from(
        JSON.stringify({
          version,
          binding: bindingHash(binding),
          sha256: digest(bytes),
          bytes: bytes.length,
          path,
        } satisfies Marker),
      ),
    );
  }
  check(
    binding: ReadinessBinding,
    signal: AbortSignal,
  ): Promise<ReadinessMeasurement> {
    // Each reader owns its abort/deadline. Cancelling one window cannot cancel
    // another window's bounded readonly capsule/fingerprint checks.
    return this.inspect(binding, signal);
  }
  private async inspect(
    binding: ReadinessBinding,
    caller: AbortSignal,
  ): Promise<ReadinessMeasurement> {
    const started = performance.now(),
      abort = new AbortController();
    let filesChecked = 0;
    const measure = (
      ready: boolean,
      reason: ReadinessMeasurement["reason"],
    ): ReadinessMeasurement => ({
      ready,
      reason,
      filesChecked,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
    const work = async (): Promise<ReadinessMeasurement> => {
      abort.signal.throwIfAborted();
      if ((await this.port.bootIdentity()) !== binding.bootIdentity)
        throw new Error("READINESS_INVALID");
      const bytes = await this.port.readMarker();
      if (!bytes) return measure(false, "missing");
      if (bytes.length > 4096) throw new Error("READINESS_INVALID");
      const marker = JSON.parse(bytes.toString("utf8")) as Marker;
      if (
        !marker ||
        Object.keys(marker).sort().join() !==
          ["version", "binding", "sha256", "bytes", "path"].sort().join() ||
        ![2, 3].includes(marker.version) ||
        marker.binding !== bindingHash(binding) ||
        (marker.version === 2
          ? marker.path !== capsulePath(binding)
          : ![0, 1].some(
              (slot) =>
                marker.path ===
                `${capsulePath(binding).slice(0, -5)}\\slot${slot}\\index.json`,
            )) ||
        !HASH.test(marker.sha256) ||
        !Number.isSafeInteger(marker.bytes) ||
        marker.bytes < 1 ||
        marker.bytes >
          (marker.version === 2 ? MAX_BYTES : FINGERPRINT_INDEX_BYTES)
      )
        throw new Error("READINESS_INVALID");
      const content = await this.port.readCapsule(
        marker.path,
        marker.version === 2 ? MAX_BYTES : FINGERPRINT_INDEX_BYTES,
      );
      if (content.length !== marker.bytes || digest(content) !== marker.sha256)
        throw new Error("READINESS_INVALID");
      let capsule: Capsule;
      if (marker.version === 2) capsule = decodeCapsule(content, binding);
      else {
        const index = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(content),
        );
        if (
          !index ||
          Object.keys(index).sort().join() !==
            "binding,chunks,gpu,totalFiles,version" ||
          index.version !== 3
        )
          throw new Error("READINESS_INVALID");
        const files = await readFingerprintChunks(
          this.port,
          marker.path,
          index.chunks,
          index.totalFiles,
          abort.signal,
        );
        capsule = validateCapsule(
          { version: 2, binding: index.binding, gpu: index.gpu, files },
          binding,
          FINGERPRINT_TOTAL_FILES,
        );
      }
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, capsule.files.length) }, async () => {
          while (cursor < capsule.files.length) {
            abort.signal.throwIfAborted();
            const file = capsule.files[cursor++]!;
            const current = fingerprint(await this.port.fingerprint(file.path));
            abort.signal.throwIfAborted();
            filesChecked++;
            if (!sameFile(file.fingerprint, current))
              throw new Error("READINESS_INVALID");
          }
        }),
      );
      abort.signal.throwIfAborted();
      resolveQualifiedGpuIdentity(capsule.gpu, await this.port.enumerateGpus());
      abort.signal.throwIfAborted();
      if ((await this.port.bootIdentity()) !== binding.bootIdentity)
        throw new Error("READINESS_INVALID");
      // Detect activation/repair racing the read; a stale reader never publishes Ready.
      const currentMarker = await this.port.readMarker();
      if (!currentMarker || !currentMarker.equals(bytes))
        throw new Error("READINESS_INVALID");
      abort.signal.throwIfAborted();
      return measure(true, "verified");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = () => {};
    const bounded = new Promise<ReadinessMeasurement>((resolve) => {
      cancelled = () => {
        abort.abort();
        resolve(measure(false, "cancelled"));
      };
      if (caller.aborted) cancelled();
      else caller.addEventListener("abort", cancelled, { once: true });
      timer = setTimeout(() => {
        abort.abort();
        resolve(measure(false, "timeout"));
      }, this.deadlineMs);
    });
    try {
      return await Promise.race([
        work().catch(() => {
          abort.abort();
          return measure(false, caller.aborted ? "cancelled" : "changed");
        }),
        bounded,
      ]);
    } finally {
      clearTimeout(timer);
      caller.removeEventListener("abort", cancelled);
    }
  }
}
