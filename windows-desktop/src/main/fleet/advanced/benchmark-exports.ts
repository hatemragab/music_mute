import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../../host-context.js";
import type { FileCapabilities } from "../../file-capabilities.js";
import { parseStoredRepeatedBenchmarkReport } from "../../../../../worker/src/platform/shared/file-benchmark.js";
export interface AdvancedExportEntry {
  filename: string;
  bytes: number;
  sha256: string;
  /** Read from offset zero; never close the borrowed descriptor. */ file: FileHandle;
}
export interface AdvancedBenchmarkDestination {
  write(
    entries: readonly AdvancedExportEntry[],
    signal: AbortSignal,
  ): Promise<void>;
  release(): Promise<void>;
}
export interface AdvancedBenchmarkExports {
  claim(
    capability: string,
    kind: "audio" | "report",
    signal: AbortSignal,
  ): Promise<AdvancedBenchmarkDestination>;
}
export async function readAdvancedBaseline(
  files: FileCapabilities,
  capability: string,
  owner: string,
  sid: string,
  signal: AbortSignal,
) {
  const source = await files.consume(capability, owner);
  try {
    signal.throwIfAborted();
    if (source.bytes < 2 || source.bytes > 2 * 1024 ** 2)
      throw new Error("ADVANCED_BASELINE_INVALID");
    const before = await source.file.stat({ bigint: true }),
      bytes = await source.file.readFile(),
      after = await source.file.stat({ bigint: true });
    signal.throwIfAborted();
    if (
      bytes.length !== source.bytes ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("INPUT_CHANGED");
    const report = parseStoredRepeatedBenchmarkReport(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      { expectedUserSid: sid },
    );
    if (report.provider !== "directml" || report.serviceIdentity !== sid)
      throw new Error("ADVANCED_BASELINE_INVALID");
    return report;
  } finally {
    await source.file.close();
  }
}
/** Fixed private output only, with full byte/hash and descriptor/name identity proof. */
export async function openAdvancedExport(
  host: HostContext,
  relative: string,
  filename: string,
  expected: { bytes: number; sha256: string },
  signal: AbortSignal,
): Promise<AdvancedExportEntry> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u.test(filename) ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1 ||
    expected.bytes > 256 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/u.test(expected.sha256)
  )
    throw new Error("ADVANCED_EXPORT_INVALID");
  await host.native.validatePath("personal", relative, "file");
  const path = win32.join(host.personalRoot, relative),
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true }),
      named = await lstat(path, { bigint: true });
    if (
      !before.isFile() ||
      named.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size !== BigInt(expected.bytes) ||
      before.ino !== named.ino ||
      before.dev !== named.dev
    )
      throw new Error("ADVANCED_EXPORT_INVALID");
    const hash = createHash("sha256");
    signal.throwIfAborted();
    for await (const bytes of file.createReadStream({
      start: 0,
      autoClose: false,
      signal,
    }))
      hash.update(bytes);
    const after = await file.stat({ bigint: true }),
      current = await lstat(path, { bigint: true });
    if (
      hash.digest("hex") !== expected.sha256 ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink()
    )
      throw new Error("ADVANCED_EXPORT_INVALID");
    return { filename, ...expected, file };
  } catch (error) {
    await file.close();
    throw error;
  }
}
