import { lstat, readdir, readFile, readlink, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { MacUserLayout } from "../macos/user-paths.js";
import type { WindowsServiceLayout } from "../windows/service-definition.js";
import { readWindowsActiveVersion } from "../windows/active-release.js";
import { verifyManagedMacRelease as verifyMacRelease } from "../macos/app-installation-binding.js";
import { verifyWindowsRelease } from "../windows/release-manifest.js";
import { compareWorkerReleaseVersions } from "./release-version.js";
import { loadUpdateState } from "../macos/user-updater.js";
import { loadWindowsUpdateState } from "../windows/user-updater.js";
import { readMacQualifiedRollback } from "../macos/app-installation-state.js";

const DAY = 24 * 60 * 60 * 1000;
export const WORKER_CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;

export interface WorkerStorageLayout {
  installRoot: string;
  releasesRoot: string;
  transactionRoot: string;
  workRoot: string;
  cacheRoot: string;
  temporaryRoot: string;
  updateStatePath: string;
  recoveryPaths: string[];
  activeVersion: () => Promise<string>;
  verifyRelease: (version: string) => Promise<void>;
  validateUpdateState?: () => Promise<unknown>;
  qualifiedRollback?: () => Promise<{
    knownGoodVersion: string;
    previousVersion: string | null;
  } | null>;
  transactionName: (name: string) => boolean;
  legacyEnrollment?: {
    statePath: string;
    installationPath: string;
    configPath: string;
  };
}

export function macWorkerStorageLayout(
  layout: MacUserLayout,
  options: { ownsPreparationFence?: boolean } = {},
): WorkerStorageLayout {
  return {
    ...layout,
    updateStatePath: layout.updateStatePath,
    recoveryPaths: [
      ...["finalization.json", "enrollment.credential"].map((name) =>
        join(layout.transactionRoot, "install", name),
      ),
      join(layout.stateRoot, "app-activation.json"),
      ...(options.ownsPreparationFence
        ? []
        : [join(layout.stateRoot, "app-preparation.json")]),
    ],
    activeVersion: async () => {
      const target = resolve(
        dirname(layout.currentLink),
        await readlink(layout.currentLink),
      );
      const version = basename(target);
      if (
        !VERSION.test(version) ||
        target !== join(layout.releasesRoot, version)
      )
        throw new TypeError("Active worker release path is unsafe");
      if ((await verifyMacRelease(target)).releaseVersion !== version)
        throw new TypeError("Active worker release identity changed");
      return version;
    },
    verifyRelease: async (version) => {
      if (
        (await verifyMacRelease(join(layout.releasesRoot, version)))
          .releaseVersion !== version
      )
        throw new TypeError("Rollback worker release identity changed");
    },
    validateUpdateState: () => loadUpdateState(layout.updateStatePath),
    qualifiedRollback: () => readMacQualifiedRollback(layout),
    legacyEnrollment: {
      statePath: join(
        layout.transactionRoot,
        "install",
        ".enrollment-state.json",
      ),
      installationPath: layout.installationStatePath,
      configPath: layout.configPath,
    },
    // Legacy local qualification transactions lived in this dedicated scratch root.
    transactionName: (name) =>
      /^(?:install|updates|local-[0-9A-Za-z-]+|\.install-[0-9a-f-]+\.completed)$/u.test(
        name,
      ),
  };
}

export function windowsWorkerStorageLayout(
  layout: WindowsServiceLayout,
): WorkerStorageLayout {
  return {
    ...layout,
    transactionRoot: layout.serviceRoot,
    cacheRoot: layout.runtimeCacheRoot,
    updateStatePath: join(layout.serviceRoot, "update-state.json"),
    recoveryPaths: [join(layout.serviceRoot, "operation-recovery")],
    activeVersion: async () => {
      const version = await readWindowsActiveVersion(layout);
      if (
        (await verifyWindowsRelease(join(layout.releasesRoot, version)))
          .releaseVersion !== version
      )
        throw new TypeError("Active worker release identity changed");
      return version;
    },
    verifyRelease: async (version) => {
      if (
        (await verifyWindowsRelease(join(layout.releasesRoot, version)))
          .releaseVersion !== version
      )
        throw new TypeError("Rollback worker release identity changed");
    },
    validateUpdateState: () => loadWindowsUpdateState(layout),
    transactionName: (name) => /^update-[0-9a-f-]{36}$/u.test(name),
  };
}

export interface WorkerStorageCleanup {
  action: "cleanup";
  mode: "dry-run" | "apply";
  status: "ok" | "blocked" | "partial";
  reclaimableBytes: number;
  reclaimedBytes: number;
  cacheLimitBytes: number;
  keptReleaseVersions: string[];
  entries: Array<{
    path: string;
    category: string;
    bytes: number;
    removed: boolean;
  }>;
  warnings: string[];
}

/** Call under the operator lock, with the service stopped or before children start. */
export async function cleanupWorkerStorage(options: {
  layout: WorkerStorageLayout;
  apply?: boolean;
  now?: number;
  remove?: (path: string) => Promise<void>;
  stateOnly?: boolean;
}): Promise<WorkerStorageCleanup> {
  const { layout } = options;
  const now = options.now ?? Date.now();
  const result: WorkerStorageCleanup = {
    action: "cleanup",
    mode: options.apply ? "apply" : "dry-run",
    status: "ok",
    reclaimableBytes: 0,
    reclaimedBytes: 0,
    cacheLimitBytes: WORKER_CACHE_LIMIT_BYTES,
    keptReleaseVersions: [],
    entries: [],
    warnings: [],
  };
  // Any recovery object, including corrupt records or links, protects all scratch.
  for (const path of layout.recoveryPaths) {
    await assertSafeAncestors(layout.installRoot, path, false);
    if (await info(path))
      return blocked(
        result,
        "Installation or update recovery is pending; complete recovery before cleanup",
      );
  }
  if (layout.legacyEnrollment) {
    const legacy = layout.legacyEnrollment;
    for (const path of Object.values(legacy))
      await assertSafeAncestors(layout.installRoot, path, false);
    const enrollment = await readRecord(legacy.statePath);
    if (enrollment) {
      const installation = await readRecord(legacy.installationPath);
      const config = await readRecord(legacy.configPath);
      // Older installers left this private state after committing installation.
      // A matching durable installation/config is proof it is no longer pending.
      if (
        enrollment.schemaVersion !== 1 ||
        installation?.schemaVersion !== 1 ||
        config?.schemaVersion !== 1 ||
        typeof enrollment.installationId !== "string" ||
        installation.installationId !== enrollment.installationId ||
        typeof enrollment.machineId !== "string" ||
        installation.machineId !== enrollment.machineId ||
        config.machineId !== enrollment.machineId
      )
        return blocked(
          result,
          "Enrollment is not durably installed; complete installation before cleanup",
        );
    }
  }
  await assertSafeAncestors(layout.installRoot, layout.updateStatePath, false);
  await layout.validateUpdateState?.();
  const update = await readRecord(layout.updateStatePath);
  if (
    update &&
    (update.schemaVersion !== 1 ||
      !Number.isSafeInteger(update.highestSequence) ||
      (update.highestSequence as number) < 0 ||
      !Array.isArray(update.quarantinedVersions) ||
      update.quarantinedVersions.some(
        (version) => typeof version !== "string" || !VERSION.test(version),
      ) ||
      (update.status !== undefined &&
        !["none", "healthy", "rolled-back"].includes(String(update.status))) ||
      update.recovery !== undefined)
  )
    return blocked(
      result,
      "Update state requires recovery or operator inspection before cleanup",
    );
  const active = await layout.activeVersion();
  if (!VERSION.test(active))
    throw new TypeError("Active worker version is invalid");
  await assertSafeAncestors(
    layout.installRoot,
    join(layout.releasesRoot, active),
  );
  const releases = (await children(layout, layout.releasesRoot)).filter(
    (entry) => entry.directory && VERSION.test(entry.name),
  );
  const activeInfo = await info(join(layout.releasesRoot, active));
  if (!activeInfo?.isDirectory() || activeInfo.isSymbolicLink())
    throw new TypeError("Active worker release is unavailable");
  if (
    update?.knownGoodVersion !== undefined &&
    update.knownGoodVersion !== active
  )
    return blocked(
      result,
      "Active release and known-good update state disagree; inspect recovery before cleanup",
    );
  const quarantined = new Set((update?.quarantinedVersions ?? []) as string[]);
  const qualified = await layout.qualifiedRollback?.();
  if (qualified && qualified.knownGoodVersion !== active)
    return blocked(
      result,
      "Active release and qualified rollback state disagree; inspect recovery before cleanup",
    );
  const older = releases
    .filter(
      (entry) =>
        entry.name !== active &&
        !quarantined.has(entry.name) &&
        compareWorkerReleaseVersions(entry.name, active) < 0,
    )
    .sort((a, b) => compareWorkerReleaseVersions(b.name, a.name));
  let previous: (typeof older)[number] | undefined;
  if (
    !options.stateOnly &&
    qualified?.previousVersion !== undefined &&
    qualified.previousVersion !== null
  ) {
    const release = releases.find(
      (entry) => entry.name === qualified.previousVersion,
    );
    if (!release || quarantined.has(release.name))
      return blocked(
        result,
        "Qualified rollback release is unavailable; inspect recovery before cleanup",
      );
    try {
      await assertSafeAncestors(layout.installRoot, release.path);
      await layout.verifyRelease(release.name);
      previous = release;
    } catch {
      return blocked(
        result,
        "Qualified rollback release failed verification; inspect recovery before cleanup",
      );
    }
  }
  if (!options.stateOnly && qualified == null)
    for (const release of older) {
      try {
        await assertSafeAncestors(layout.installRoot, release.path);
        await layout.verifyRelease(release.name);
        previous = release;
        break;
      } catch {
        /* An invalid release cannot serve as the rollback. */
      }
    }
  result.keptReleaseVersions = [active, ...(previous ? [previous.name] : [])];
  const keep = new Set(result.keptReleaseVersions);
  const candidates: Array<{ path: string; category: string }> = [];
  if (!options.stateOnly)
    for (const entry of releases)
      if (!keep.has(entry.name))
        candidates.push({ path: entry.path, category: "older-release" });
  if (!options.stateOnly)
    for (const entry of await children(layout, layout.transactionRoot)) {
      if (entry.directory && layout.transactionName(entry.name))
        candidates.push({
          path: entry.path,
          category: "completed-transaction",
        });
    }
  for (const entry of await children(layout, layout.workRoot)) {
    if (
      entry.directory &&
      /^qualification-[0-9A-Za-z-]+$/u.test(entry.name) &&
      now - entry.modified > DAY
    )
      candidates.push({ path: entry.path, category: "old-qualification" });
  }
  for (const entry of await children(layout, layout.temporaryRoot)) {
    if (now - entry.modified > DAY)
      candidates.push({ path: entry.path, category: "old-temporary-file" });
  }
  // Keep recent reusable Python/Numba caches within a fixed disk budget.
  const cached = await files(layout, layout.cacheRoot);
  let cacheBytes = cached.reduce((total, file) => total + file.bytes, 0);
  for (const file of cached.sort((a, b) => a.modified - b.modified)) {
    if (
      now - file.modified > 30 * DAY ||
      cacheBytes > WORKER_CACHE_LIMIT_BYTES
    ) {
      candidates.push({ path: file.path, category: "cache" });
      cacheBytes -= file.bytes;
    }
  }
  for (const candidate of candidates) {
    await assertSafeAncestors(layout.installRoot, candidate.path);
    const bytes = await diskBytes(candidate.path);
    const entry = {
      path: relative(layout.installRoot, candidate.path),
      category: candidate.category,
      bytes,
      removed: false,
    };
    result.entries.push(entry);
    result.reclaimableBytes += bytes;
    if (!options.apply) continue;
    try {
      // Recheck immediately before deletion; never traverse a linked parent.
      await assertSafeAncestors(layout.installRoot, candidate.path);
      await (
        options.remove ?? ((path) => rm(path, { recursive: true, force: true }))
      )(candidate.path);
      entry.removed = true;
      result.reclaimedBytes += bytes;
    } catch {
      result.status = "partial";
      result.warnings.push(
        `Could not remove ${entry.path}; retry cleanup after checking permissions`,
      );
    }
  }
  return result;
}

function blocked(
  result: WorkerStorageCleanup,
  warning: string,
): WorkerStorageCleanup {
  result.status = "blocked";
  result.warnings.push(warning);
  return result;
}

async function info(path: string) {
  return await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function assertSafeAncestors(
  root: string,
  target: string,
  includeTarget = true,
): Promise<void> {
  const base = resolve(root);
  const destination = resolve(target);
  if (!destination.startsWith(`${base}${sep}`) || destination === base)
    throw new TypeError("Worker cleanup path escaped its installation");
  const rootInfo = await info(base);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink())
    throw new TypeError("Worker installation root is unsafe");
  let current = base;
  const parts = relative(
    base,
    includeTarget ? destination : dirname(destination),
  )
    .split(sep)
    .filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const item = await info(current);
    if (!item) return;
    if (
      item.isSymbolicLink() ||
      (index < parts.length - 1 && !item.isDirectory())
    )
      throw new TypeError("Worker cleanup path contains an unsafe ancestor");
  }
}

async function children(layout: WorkerStorageLayout, path: string) {
  await assertSafeAncestors(layout.installRoot, path);
  if (!(await info(path))) return [];
  const result: Array<{
    name: string;
    path: string;
    directory: boolean;
    modified: number;
  }> = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    const details = await lstat(child);
    if (details.isSymbolicLink()) continue;
    result.push({
      name: entry.name,
      path: child,
      directory: details.isDirectory(),
      modified: details.mtimeMs,
    });
  }
  return result;
}

async function files(
  layout: WorkerStorageLayout,
  path: string,
): Promise<Array<{ path: string; bytes: number; modified: number }>> {
  const result: Array<{ path: string; bytes: number; modified: number }> = [];
  for (const entry of await children(layout, path)) {
    if (entry.directory) result.push(...(await files(layout, entry.path)));
    else {
      const details = await lstat(entry.path);
      if (details.isFile())
        result.push({
          path: entry.path,
          bytes: allocatedBytes(details),
          modified: details.mtimeMs,
        });
    }
  }
  return result;
}

function allocatedBytes(details: Awaited<ReturnType<typeof lstat>>): number {
  return Number(details.blocks) > 0
    ? Number(details.blocks) * 512
    : Number(details.size);
}

async function diskBytes(path: string): Promise<number> {
  const details = await lstat(path);
  let bytes = allocatedBytes(details);
  if (details.isDirectory() && !details.isSymbolicLink())
    for (const entry of await readdir(path))
      bytes += await diskBytes(join(path, entry));
  return bytes;
}

async function readRecord(
  path: string,
): Promise<Record<string, unknown> | null> {
  const details = await info(path);
  if (!details) return null;
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size < 2 ||
    details.size > 64 * 1024
  )
    throw new TypeError("Worker update state is unsafe");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Worker update state is invalid");
  return value as Record<string, unknown>;
}
