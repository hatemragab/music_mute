import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { assertWindowsPrivateDataFile } from "../windows/private-data.js";

export async function writeCapacityEvidence(
  path: string,
  evidence: object,
): Promise<void> {
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(body) > 4 * 1024 * 1024)
    throw new TypeError("Capacity evidence is too large");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform === "win32")
      await assertWindowsPrivateDataFile(temporary);
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
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
