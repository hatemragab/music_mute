import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { freemem } from "node:os";
import { promisify } from "node:util";

export const MAX_INPUT_BYTES = 1_000_000_000;
export const MIN_AVAILABLE_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export const WORKSPACE_DISK_RESERVE_BYTES = 2_300 * 1024 * 1024;

export interface RuntimeResourceProbe {
  availableDiskBytes(path: string): Promise<bigint>;
  availableMemoryBytes(): Promise<bigint>;
}

export interface RuntimeResourceLimits {
  minimumAvailableMemoryBytes: number;
  workspaceDiskReserveBytes: number;
}

const DEFAULT_LIMITS: RuntimeResourceLimits = {
  minimumAvailableMemoryBytes: MIN_AVAILABLE_MEMORY_BYTES,
  workspaceDiskReserveBytes: WORKSPACE_DISK_RESERVE_BYTES,
};

const execFileAsync = promisify(execFile);

const HOST_RESOURCE_PROBE: RuntimeResourceProbe = {
  async availableDiskBytes(path) {
    const information = await statfs(path, { bigint: true });
    return information.bavail * information.bsize;
  },
  async availableMemoryBytes() {
    if (process.platform !== "darwin") return BigInt(freemem());
    const { stdout } = await execFileAsync("/usr/bin/vm_stat", [], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return parseMacAvailableMemory(stdout);
  },
};

export class RuntimeResourceLimitError extends Error {
  constructor(readonly resource: "disk" | "memory") {
    super(`Worker ${resource} admission limit is not satisfied`);
    this.name = "RuntimeResourceLimitError";
  }
}

export class RuntimeResourceGate {
  private readonly limits: RuntimeResourceLimits;

  constructor(
    private readonly workRoot: string,
    private readonly probe: RuntimeResourceProbe = HOST_RESOURCE_PROBE,
    limits: Partial<RuntimeResourceLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    assertLimit(
      this.limits.minimumAvailableMemoryBytes,
      "minimum available memory",
    );
    assertLimit(
      this.limits.workspaceDiskReserveBytes,
      "workspace disk reserve",
    );
  }

  async assertAvailable(inputBytes: number): Promise<void> {
    if (
      !Number.isSafeInteger(inputBytes) ||
      inputBytes < 1 ||
      inputBytes > MAX_INPUT_BYTES
    )
      throw new TypeError("Worker input byte count is outside runtime limits");

    let availableMemory: bigint;
    try {
      availableMemory = await this.probe.availableMemoryBytes();
    } catch {
      throw new RuntimeResourceLimitError("memory");
    }
    if (availableMemory < BigInt(this.limits.minimumAvailableMemoryBytes))
      throw new RuntimeResourceLimitError("memory");

    const requiredDisk = BigInt(
      inputBytes + this.limits.workspaceDiskReserveBytes,
    );
    let availableDisk: bigint;
    try {
      availableDisk = await this.probe.availableDiskBytes(this.workRoot);
    } catch {
      throw new RuntimeResourceLimitError("disk");
    }
    if (availableDisk < requiredDisk)
      throw new RuntimeResourceLimitError("disk");
  }
}

export function parseMacAvailableMemory(output: string): bigint {
  const pageSize = /page size of (\d+) bytes/iu.exec(output)?.[1];
  if (!pageSize) throw new TypeError("macOS memory page size is unavailable");
  let pages = 0n;
  for (const label of ["free", "inactive", "speculative"] as const) {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.$`, "imu").exec(
      output,
    )?.[1];
    if (!match) throw new TypeError(`macOS ${label} memory is unavailable`);
    pages += BigInt(match);
  }
  return pages * BigInt(pageSize);
}

function assertLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`Worker ${label} limit is invalid`);
}
