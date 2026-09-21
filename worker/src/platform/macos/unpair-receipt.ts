import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ConfirmedUnpairReceipt {
  schemaVersion: 1;
  machineId: string;
  confirmedAt: string;
}

export async function writeConfirmedUnpairReceipt(
  path: string,
  machineId: string,
  now = new Date(),
): Promise<ConfirmedUnpairReceipt> {
  if (!UUID_V4.test(machineId) || !Number.isFinite(now.getTime()))
    throw new TypeError("Confirmed unpair receipt is invalid");
  const receipt: ConfirmedUnpairReceipt = {
    schemaVersion: 1,
    machineId,
    confirmedAt: now.toISOString(),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return receipt;
}

export async function loadConfirmedUnpairReceipt(
  path: string,
): Promise<ConfirmedUnpairReceipt | null> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > 4096 ||
      (info.mode & 0o077) !== 0
    )
      throw new TypeError("Confirmed unpair receipt is unsafe");
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError("Confirmed unpair receipt is invalid");
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "confirmedAt,machineId,schemaVersion" ||
      record.schemaVersion !== 1 ||
      typeof record.machineId !== "string" ||
      !UUID_V4.test(record.machineId) ||
      typeof record.confirmedAt !== "string" ||
      !Number.isFinite(Date.parse(record.confirmedAt))
    )
      throw new TypeError("Confirmed unpair receipt is invalid");
    return {
      schemaVersion: 1,
      machineId: record.machineId,
      confirmedAt: record.confirmedAt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
