import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";
import { withDiagnosticStoreLock } from "../../runtime/diagnostic-store-lock.js";
import { loadConfirmedUnpairReceipt } from "../shared/unpair-receipt.js";
import {
  privateWrite,
  readBoundedJson,
  assertMacPreparedRuntimeUnused,
} from "./app-installation-binding.js";
import { personalProcessIdentity } from "../../runtime/personal-reservation.js";
import { hasMacPersonalReservation } from "./app-control-maintenance.js";
import {
  assertSafeExistingAncestors,
  type MacUserLayout,
} from "./user-paths.js";
import type { LaunchAgentStatus } from "./launch-agent.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FIXED_PATHS = [
  "state/installation.json",
  "state/lifecycle.json",
  "state/runtime-status.json",
  "state/capacity-validation.json",
  "state/machine-deleted.json",
  "config/restart-budget.json",
  "state/transactions/install",
  "state/unpaired.json",
] as const;
const SPOOL_NAME =
  /^(?:delivery\.json|stream-id|history\.json|events\.jsonl|events-\d{12}\.jsonl|spool-full\.marker)$/u;
interface ArchivedEntry {
  path: string;
  dev: number;
  ino: number;
  directory: boolean;
}
interface DeletionJournal {
  schemaVersion: 1;
  machineId: string;
  confirmedAt: string;
  archiveId: string;
  phase: "archiving" | "complete";
  entries: ArchivedEntry[];
}
export interface MachineDeletionNotice {
  schemaVersion: 1;
  code: "WORKER_MACHINE_DELETED";
  httpStatus: 410;
  detectedAt: string;
  machineId: string;
}
const journalPath = (layout: MacUserLayout) =>
  join(layout.stateRoot, "deleted-registration.json");
const archiveRoot = (layout: MacUserLayout, journal: DeletionJournal) =>
  join(layout.stateRoot, "deleted-registrations", journal.archiveId);
const archivedPath = (
  layout: MacUserLayout,
  journal: DeletionJournal,
  path: string,
) => join(archiveRoot(layout, journal), path.replaceAll("/", "__"));
function allowedPath(path: string): boolean {
  return (
    FIXED_PATHS.some((allowed) => path === allowed) ||
    (path.startsWith("jobs/logs/") &&
      SPOOL_NAME.test(path.slice("jobs/logs/".length)))
  );
}
async function info(path: string) {
  return await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
async function privateArtifact(path: string, directory = false) {
  const value = await info(path);
  if (!value) return null;
  if (
    value.isSymbolicLink() ||
    value.uid !== process.getuid?.() ||
    (value.mode & 0o077) !== 0 ||
    (directory ? !value.isDirectory() : !value.isFile()) ||
    (!directory && value.nlink !== 1)
  )
    throw new TypeError("Deleted worker registration state is unsafe");
  return value;
}
async function privateJson(path: string, limit = 64 * 1024) {
  const value = await privateArtifact(path);
  if (!value || value.size < 2 || value.size > limit)
    throw new TypeError("Deleted worker registration metadata is unsafe");
  try {
    return await readBoundedJson(path, limit);
  } catch {
    throw new TypeError("Deleted worker registration metadata is invalid");
  }
}
async function loadJournal(
  layout: MacUserLayout,
): Promise<DeletionJournal | null> {
  await assertSafeExistingAncestors(
    layout.homeRoot,
    dirname(journalPath(layout)),
  );
  if (!(await info(journalPath(layout)))) return null;
  const value = await privateJson(journalPath(layout));
  const entries: unknown[] = Array.isArray(value.entries) ? value.entries : [];
  if (
    Object.keys(value).sort().join() !==
      "archiveId,confirmedAt,entries,machineId,phase,schemaVersion" ||
    value.schemaVersion !== 1 ||
    !UUID.test(String(value.machineId)) ||
    !UUID.test(String(value.archiveId)) ||
    typeof value.confirmedAt !== "string" ||
    !Number.isFinite(Date.parse(value.confirmedAt)) ||
    !["archiving", "complete"].includes(String(value.phase)) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 256 ||
    value.entries.some((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return true;
      const record = entry as Record<string, unknown>;
      return (
        Object.keys(record).sort().join() !== "dev,directory,ino,path" ||
        typeof record.path !== "string" ||
        !allowedPath(record.path) ||
        !Number.isSafeInteger(record.dev) ||
        !Number.isSafeInteger(record.ino) ||
        typeof record.directory !== "boolean" ||
        record.directory !== (record.path === "state/transactions/install")
      );
    }) ||
    new Set(value.entries.map((entry) => entry.path)).size !==
      value.entries.length ||
    [
      "state/installation.json",
      "state/runtime-status.json",
      "state/unpaired.json",
    ].some(
      (path) =>
        !entries.some((entry) => (entry as ArchivedEntry).path === path),
    )
  )
    throw new TypeError("Deleted worker registration journal is invalid");
  return value as unknown as DeletionJournal;
}
export async function hasDeletedMacRegistration(
  layout: MacUserLayout,
): Promise<boolean> {
  return (
    (await loadJournal(layout)) !== null ||
    (await loadConfirmedUnpairReceipt(layout.unpairReceiptPath))?.deleted ===
      true
  );
}
export async function readMacMachineIdentity(
  layout: MacUserLayout,
): Promise<{ present: boolean; machineId: string | null }> {
  if (!(await info(layout.configPath)))
    return { present: false, machineId: null };
  const config = await privateJson(layout.configPath);
  return {
    present: true,
    machineId:
      typeof config.machineId === "string" && UUID.test(config.machineId)
        ? config.machineId
        : null,
  };
}
export async function assertMacUnpairReceiptReplay(
  layout: MacUserLayout,
  machineId: string,
): Promise<void> {
  const config = await info(layout.configPath);
  const credential = await info(layout.credentialPath);
  if (!config && credential)
    throw new Error(
      "Unpair receipt conflicts with partial worker registration",
    );
  if (config) {
    const current = await privateJson(layout.configPath);
    if (credential) {
      const protectedCredential = await privateArtifact(layout.credentialPath);
      if (
        !protectedCredential ||
        protectedCredential.size < 43 ||
        protectedCredential.size > 128
      )
        throw new TypeError("Worker credential file is unsafe");
    }
    if (
      current.schemaVersion !== 1 ||
      current.machineId !== machineId ||
      current.credentialFile !== layout.credentialPath
    )
      throw new Error("Unpair receipt does not match the current machine");
  }
  if (await info(layout.installationStatePath)) {
    const installation = await privateJson(layout.installationStatePath);
    if (installation.machineId !== machineId)
      throw new Error("Unpair receipt does not match the installed machine");
  }
}
export async function assertMacFreshEnrollmentAllowed(
  layout: MacUserLayout,
): Promise<void> {
  if (await loadConfirmedUnpairReceipt(layout.unpairReceiptPath))
    throw new Error(
      "Preserved unpaired MusicMute state requires confirmed deletion cleanup before fresh enrollment",
    );
  if ((await loadJournal(layout))?.phase === "archiving")
    throw new Error(
      "Deleted worker cleanup must complete before fresh enrollment",
    );
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeJournal(
  layout: MacUserLayout,
  journal: DeletionJournal,
): Promise<void> {
  await privateWrite(
    journalPath(layout),
    Buffer.from(`${JSON.stringify(journal)}\n`),
  );
}

/** Caller holds the command lock and preparation fence. Never enrolls or reactivates a machine. */
export async function resetDeletedMacRegistration(options: {
  layout: MacUserLayout;
  service: { status(): Promise<LaunchAgentStatus>; bootout(): Promise<void> };
  afterArchive?: (path: string) => Promise<void>;
}): Promise<{ deleted: true; registrationReset: true } | null> {
  const { layout, service } = options;
  let journal = await loadJournal(layout);
  if (!journal && !(await info(layout.unpairReceiptPath))) return null;
  for (const path of [layout.configPath, layout.credentialPath])
    if (await info(path))
      throw new Error("Deleted worker cleanup requires confirmed unpair first");
  if (await hasMacPersonalReservation(layout))
    throw new Error("WORKER_PERSONAL_BUSY");
  for (const name of ["app-activation.json", "app-maintenance.json"])
    if (await info(join(layout.stateRoot, name)))
      throw new Error("Deleted worker cleanup requires completed maintenance");
  if (await info(layout.updateStatePath)) {
    const update = await privateJson(layout.updateStatePath);
    if (update.recovery !== undefined)
      throw new Error(
        "Deleted worker cleanup requires completed update recovery",
      );
  }
  const receiptPath =
    journal && !(await info(layout.unpairReceiptPath))
      ? archivedPath(layout, journal, "state/unpaired.json")
      : layout.unpairReceiptPath;
  await assertSafeExistingAncestors(layout.homeRoot, dirname(receiptPath));
  await privateArtifact(receiptPath);
  const receipt = await loadConfirmedUnpairReceipt(receiptPath);
  if (!receipt?.deleted)
    throw new Error("Only backend-confirmed deleted machines can be reset");
  if (
    journal &&
    (journal.machineId !== receipt.machineId ||
      journal.confirmedAt !== receipt.confirmedAt)
  )
    throw new Error("Deleted worker receipt identity changed");
  if (journal?.phase === "complete") {
    for (const entry of journal.entries) {
      const source = join(layout.installRoot, entry.path);
      const destination = archivedPath(layout, journal, entry.path);
      await assertSafeExistingAncestors(layout.homeRoot, dirname(destination));
      const saved = await privateArtifact(destination, entry.directory);
      if (
        (await info(source)) ||
        !saved ||
        saved.dev !== entry.dev ||
        saved.ino !== entry.ino
      )
        throw new Error("Deleted worker archive identity changed");
    }
    return { deleted: true, registrationReset: true };
  }
  const statusPath =
    journal && !(await info(layout.runtimeStatusPath))
      ? archivedPath(layout, journal, "state/runtime-status.json")
      : layout.runtimeStatusPath;
  await assertSafeExistingAncestors(layout.homeRoot, dirname(statusPath));
  await privateArtifact(statusPath);
  const runtime = await loadLocalRuntimeStatus(statusPath);
  if (
    runtime.activeAttemptIds.length !== 0 ||
    (runtime.currentAttempts?.length ?? 0) !== 0
  )
    throw new Error("Deleted worker cleanup requires zero active attempts");
  if (!journal) {
    const installation = await privateJson(layout.installationStatePath);
    if (installation.machineId !== receipt.machineId)
      throw new Error(
        "Deleted worker receipt does not match the installed machine",
      );
  }
  if ((await service.status()).loaded) await service.bootout();
  const stopped = await service.status();
  if (stopped.loaded || stopped.running)
    throw new Error("Deleted worker service did not stop");
  if (
    runtime.processId !== undefined &&
    (await personalProcessIdentity(runtime.processId)) !== undefined
  )
    throw new Error("ENGINE_EXIT_UNCONFIRMED");
  await assertMacPreparedRuntimeUnused(layout);
  const logsRoot = join(layout.installRoot, "jobs", "logs");
  const archive = async () => {
    if (!journal) {
      const paths: string[] = FIXED_PATHS.filter(
        (path) => path !== "state/unpaired.json",
      );
      if (await info(logsRoot)) {
        await privateArtifact(logsRoot, true);
        paths.push(
          ...(await readdir(logsRoot))
            .filter((name) => SPOOL_NAME.test(name))
            .map((name) => `jobs/logs/${name}`),
        );
      }
      paths.push("state/unpaired.json");
      const entries: ArchivedEntry[] = [];
      for (const path of paths) {
        const source = join(layout.installRoot, path);
        await assertSafeExistingAncestors(layout.homeRoot, dirname(source));
        const directory = path === "state/transactions/install";
        const value = await privateArtifact(source, directory);
        if (value)
          entries.push({ path, dev: value.dev, ino: value.ino, directory });
      }
      journal = {
        schemaVersion: 1,
        machineId: receipt.machineId,
        confirmedAt: receipt.confirmedAt,
        archiveId: randomUUID(),
        phase: "archiving",
        entries,
      };
      const root = archiveRoot(layout, journal);
      await assertSafeExistingAncestors(layout.homeRoot, root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await privateArtifact(dirname(root), true);
      await privateArtifact(root, true);
      if (
        (await realpath(root)) !==
        join(
          await realpath(layout.stateRoot),
          "deleted-registrations",
          journal.archiveId,
        )
      )
        throw new TypeError("Deleted worker archive is unsafe");
      await syncDirectory(root);
      await syncDirectory(dirname(root));
      await writeJournal(layout, journal);
    }
    await privateArtifact(archiveRoot(layout, journal), true);
    for (const entry of journal.entries) {
      const source = join(layout.installRoot, entry.path);
      const destination = archivedPath(layout, journal, entry.path);
      await assertSafeExistingAncestors(layout.homeRoot, dirname(source));
      await assertSafeExistingAncestors(layout.homeRoot, dirname(destination));
      const from = await privateArtifact(source, entry.directory);
      const to = await privateArtifact(destination, entry.directory);
      if (
        (from && to) ||
        (!from && !to) ||
        (from ?? to)?.dev !== entry.dev ||
        (from ?? to)?.ino !== entry.ino
      )
        throw new Error("Deleted worker archive identity changed");
      if (from) {
        await rename(source, destination);
        await syncDirectory(dirname(source));
        await syncDirectory(dirname(destination));
        await options.afterArchive?.(entry.path);
      }
    }
    journal.phase = "complete";
    await privateWrite(
      join(archiveRoot(layout, journal), "journal.json"),
      Buffer.from(`${JSON.stringify(journal)}\n`),
    );
    await writeJournal(layout, journal);
  };
  if (await info(logsRoot)) await withDiagnosticStoreLock(logsRoot, archive);
  else await archive();
  return { deleted: true, registrationReset: true };
}

/** A completed fresh installation consumes the cleanup marker, never its private archive. */
export async function finishDeletedMacRegistration(
  layout: MacUserLayout,
  machineId: string,
): Promise<void> {
  const journal = await loadJournal(layout);
  if (!journal) return;
  if (
    journal.phase !== "complete" ||
    !UUID.test(machineId) ||
    machineId === journal.machineId
  )
    throw new Error(
      "Fresh worker installation conflicts with deleted registration cleanup",
    );
  await rm(journalPath(layout));
  await syncDirectory(layout.stateRoot);
}
export async function writeMachineDeletionNotice(
  layout: Pick<MacUserLayout, "stateRoot">,
  machineId: string,
): Promise<void> {
  if (!UUID.test(machineId))
    throw new TypeError("Worker deletion notice identity is invalid");
  await privateArtifact(join(layout.stateRoot, "machine-deleted.json"));
  const notice: MachineDeletionNotice = {
    schemaVersion: 1,
    code: "WORKER_MACHINE_DELETED",
    httpStatus: 410,
    detectedAt: new Date().toISOString(),
    machineId,
  };
  await privateWrite(
    join(layout.stateRoot, "machine-deleted.json"),
    Buffer.from(`${JSON.stringify(notice)}\n`),
  );
}
export async function loadMachineDeletionNotice(
  layout: Pick<MacUserLayout, "stateRoot">,
): Promise<MachineDeletionNotice | null> {
  const path = join(layout.stateRoot, "machine-deleted.json");
  if (!(await info(path))) return null;
  const value = await privateJson(path, 4096);
  if (
    Object.keys(value).sort().join() !==
      "code,detectedAt,httpStatus,machineId,schemaVersion" ||
    value.schemaVersion !== 1 ||
    value.code !== "WORKER_MACHINE_DELETED" ||
    value.httpStatus !== 410 ||
    typeof value.machineId !== "string" ||
    !UUID.test(value.machineId) ||
    typeof value.detectedAt !== "string" ||
    !Number.isFinite(Date.parse(value.detectedAt))
  )
    throw new TypeError("Worker deletion notice is invalid");
  return value as unknown as MachineDeletionNotice;
}
