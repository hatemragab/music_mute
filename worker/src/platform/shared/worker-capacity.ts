import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  loadRuntimeConfig,
  readBenchmarkMachineIdentity,
} from "../../runtime/runtime-config.js";
import { assertWindowsPrivateDataFile } from "../windows/private-data.js";
import {
  configuredSlotIdentities,
  retainSlotIdentities,
} from "./slot-identities.js";

/** Caller holds its platform command lock; a stopped worker cannot claim work. */
export async function configureWorkerCapacity(options: {
  configPath: string;
  receiptPath: string;
  workers: 1 | 2;
  requireStopped: () => Promise<void>;
}) {
  if (options.workers !== 1 && options.workers !== 2)
    throw new TypeError("Worker capacity must be 1 or 2");
  await options.requireStopped();
  const info = await lstat(options.configPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 64 * 1024 ||
    (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new TypeError("Runtime config file is unsafe");
  if (process.platform === "win32")
    await assertWindowsPrivateDataFile(options.configPath);
  // Validate retained identities before selection can remove duplicate records;
  // expired benchmark evidence must not prevent a safe reduction to one worker.
  await readBenchmarkMachineIdentity(options.configPath);
  const original = await readFile(options.configPath, "utf8");
  const document = JSON.parse(original) as Record<string, unknown>;
  if (
    !Array.isArray(document.slots) ||
    document.slots.length < 1 ||
    document.slots.length > 2
  )
    throw new TypeError("Capacity configuration requires one qualified GPU");
  const first = document.slots[0] as Record<string, unknown>;
  if (
    !first ||
    first.slotIndex !== 0 ||
    document.slots.some(
      (slot) =>
        !slot ||
        slot.gpuId !== first.gpuId ||
        slot.provider !== first.provider ||
        slot.directmlDeviceId !== first.directmlDeviceId ||
        JSON.stringify(slot.recipeIds) !== JSON.stringify(first.recipeIds),
    )
  )
    throw new TypeError(
      "Capacity configuration requires matching slots on one GPU",
    );
  const slots = [first];
  if (options.workers === 2) {
    if (document.slots[1] && document.slots[1].slotIndex !== 1)
      throw new TypeError("Second worker slot index must be 1");
    const retained = configuredSlotIdentities(document).find(
      (slot) => slot.gpuId === first.gpuId && slot.slotIndex === 1,
    );
    slots.push({
      ...first,
      workerId: retained?.workerId ?? randomUUID(),
      slotIndex: 1,
    });
  }
  const updated = {
    ...retainSlotIdentities(document, slots),
    validatedMaxWorkersPerGpu: options.workers,
    capacityValidationFile: options.receiptPath,
  };
  const temporary = `${options.configPath}.${randomUUID()}.capacity.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Validate real credentials, evidence, runtime inventory and hardware before
    // the atomic replacement. Selecting one remains possible after approval expiry.
    const validated = await loadRuntimeConfig(temporary);
    await options.requireStopped();
    if ((await readFile(options.configPath, "utf8")) !== original)
      throw new Error(
        "Runtime configuration changed during capacity validation",
      );
    await rename(temporary, options.configPath);
    if (process.platform !== "win32") {
      const directory = await open(dirname(options.configPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return {
      status: "ok",
      action: "capacity",
      workers: options.workers,
      workerIds: validated.slots.map((slot) => slot.workerId),
      serviceStarted: false,
      backendApprovalRequired: options.workers === 2,
    };
  } finally {
    await rm(temporary, { force: true });
  }
}
