import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertCacheDirectory, cacheFileBytes } from "./cache-budget.js";
import { processStartIdentity } from "./process-start.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_MARKERS = 512;
const MAX_MARKER_BYTES = 4096;
const MAX_SOURCE_BYTES = 256 * 1024 ** 2;
const MAX_PCM_BYTES = 640 * 1024 ** 2;
const MAX_WORKSPACE_BYTES = 2 * 1024 ** 3;
const SOURCE =
  /^source\.(m4a|mp4|mp3|webm|opus|ogg|aac|wav|flac)(?:\.(?:part|ytdl|temp)|\.part-Frag\d{1,5}(?:\.part)?)?$/;
const RECOVERY =
  /^\.local-sync-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const incarnation = randomUUID();
interface WorkspaceMarker {
  version: 1;
  job_id: string;
  pid: number;
  process_start: string;
  incarnation: string;
}
interface FileIdentity {
  path: string;
  info: Stats;
}
function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function durableDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function markerPath(cacheRoot: string, jobId: string): string {
  if (!UUID.test(jobId)) throw new Error("CACHE_UNSAFE");
  return join(cacheRoot, "job-workspaces", `${jobId}.json`);
}
async function readMarker(
  cacheRoot: string,
  jobId: string,
): Promise<{ marker: WorkspaceMarker; info: Stats }> {
  const path = markerPath(cacheRoot, jobId);
  if (
    !(await assertCacheDirectory(cacheRoot, cacheRoot)) ||
    !(await assertCacheDirectory(cacheRoot, join(cacheRoot, "job-workspaces")))
  )
    throw new Error("CACHE_UNSAFE");
  await cacheFileBytes(cacheRoot, path);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("CACHE_UNSAFE");
  });
  try {
    const info = await file.stat();
    const named = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size < 1 ||
      info.size > MAX_MARKER_BYTES ||
      named.ino !== info.ino ||
      named.dev !== info.dev
    )
      throw new Error("CACHE_UNSAFE");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    const after = await file.stat();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("CACHE_UNSAFE");
    const marker = value as WorkspaceMarker;
    if (
      Object.keys(marker).length !== 5 ||
      marker.version !== 1 ||
      marker.job_id !== jobId ||
      !Number.isSafeInteger(marker.pid) ||
      marker.pid < 1 ||
      marker.pid > 2_147_483_647 ||
      typeof marker.process_start !== "string" ||
      !HASH.test(marker.process_start) ||
      typeof marker.incarnation !== "string" ||
      !UUID.test(marker.incarnation) ||
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs
    )
      throw new Error("CACHE_UNSAFE");
    return { marker, info };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("CACHE_UNSAFE");
  } finally {
    await file.close();
  }
}
/** Sidecar metadata keeps the shared engine's input-only workspace contract intact. */
export async function markJobWorkspace(
  cacheRoot: string,
  jobId: string,
): Promise<void> {
  const path = markerPath(cacheRoot, jobId);
  for (const directory of [
    cacheRoot,
    join(cacheRoot, "jobs"),
    join(cacheRoot, "jobs", jobId),
  ])
    if (!(await assertCacheDirectory(cacheRoot, directory)))
      throw new Error("CACHE_UNSAFE");
  await assertCacheDirectory(
    cacheRoot,
    join(cacheRoot, "job-workspaces"),
    true,
  );
  if ((await readdir(join(cacheRoot, "job-workspaces"))).length >= MAX_MARKERS)
    throw new Error("CACHE_UNSAFE");
  const processStart = await processStartIdentity(process.pid);
  if (!processStart || !HASH.test(processStart))
    throw new Error("CACHE_UNSAFE");
  const marker: WorkspaceMarker = {
    version: 1,
    job_id: jobId,
    pid: process.pid,
    process_start: processStart,
    incarnation,
  };
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let complete = false;
  try {
    await file.writeFile(JSON.stringify(marker));
    await file.sync();
    await durableDirectory(join(cacheRoot, "job-workspaces"));
    await durableDirectory(join(cacheRoot, "jobs"));
    await durableDirectory(cacheRoot);
    complete = true;
  } finally {
    const owned = await file.stat();
    await file.close();
    if (!complete) {
      const named = await lstat(path).catch(() => null);
      if (named?.ino === owned.ino && named?.dev === owned.dev)
        await unlink(path);
    }
  }
}
/** Remove only this process's metadata after its owned workspace has been removed. */
export async function releaseJobWorkspace(
  cacheRoot: string,
  jobId: string,
): Promise<void> {
  const current = await readMarker(cacheRoot, jobId);
  if (
    current.marker.pid !== process.pid ||
    current.marker.incarnation !== incarnation
  )
    throw new Error("CACHE_UNSAFE");
  const named = await lstat(markerPath(cacheRoot, jobId));
  if (named.ino !== current.info.ino || named.dev !== current.info.dev)
    throw new Error("CACHE_UNSAFE");
  await unlink(markerPath(cacheRoot, jobId));
  await durableDirectory(join(cacheRoot, "job-workspaces"));
}
async function inspectWorkspace(
  cacheRoot: string,
  root: string,
): Promise<{ bytes: number; identities: FileIdentity[]; recovery: boolean }> {
  const identities: FileIdentity[] = [];
  const names = (await readdir(root)).sort();
  if (names.length > 64) throw new Error("CACHE_UNSAFE");
  if (
    names.some(
      (name) => name === "local-sync-recovery.json" || RECOVERY.test(name),
    )
  )
    return { bytes: 0, identities, recovery: true };
  let bytes = 0;
  let sourceBytes = 0;
  const file = async (path: string, maximum: number) => {
    const size = await cacheFileBytes(cacheRoot, path);
    if (size === null || size > maximum) throw new Error("CACHE_UNSAFE");
    identities.push({ path, info: await lstat(path) });
    bytes += size;
    if (bytes > MAX_WORKSPACE_BYTES) throw new Error("CACHE_UNSAFE");
  };
  for (const name of names) {
    const path = join(root, name);
    if (SOURCE.test(name)) {
      await file(path, name.endsWith(".ytdl") ? 64 * 1024 : MAX_SOURCE_BYTES);
      sourceBytes += identities.at(-1)!.info.size;
      if (sourceBytes > MAX_SOURCE_BYTES) throw new Error("CACHE_UNSAFE");
    } else if (["prepared.wav", "trimmed.wav"].includes(name)) {
      await file(path, MAX_PCM_BYTES);
    } else if (name === "cloud.m4a") {
      await file(path, MAX_SOURCE_BYTES);
    } else if (name === "output.mp3" || name === "vocals.mp3") {
      await file(path, 60 * 1024 ** 2);
    } else if (name === "separated" || name === "output") {
      await assertCacheDirectory(cacheRoot, path);
      identities.push({ path, info: await lstat(path) });
      const files = (await readdir(path)).sort();
      const allowed = name === "separated" ? "vocals.wav" : "vocals.mp3";
      if (files.some((entry) => entry !== allowed))
        throw new Error("CACHE_UNSAFE");
      if (files.length)
        await file(
          join(path, allowed),
          name === "separated" ? MAX_PCM_BYTES : 60 * 1024 ** 2,
        );
    } else throw new Error("CACHE_UNSAFE");
  }
  return { bytes, identities, recovery: false };
}
function unchanged(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid
  );
}
/** Hold the shared cache mutation lease. Unknown/live work and pair tickets are never discarded. */
export async function recoverJobWorkspaces(
  cacheRoot: string,
): Promise<{ removed: number; bytes: number; preserved: number }> {
  const summary = { removed: 0, bytes: 0, preserved: 0 };
  const markers = join(cacheRoot, "job-workspaces");
  if (
    !(await assertCacheDirectory(cacheRoot, cacheRoot)) ||
    !(await assertCacheDirectory(cacheRoot, markers))
  )
    return summary;
  const names = await readdir(markers);
  if (names.length > MAX_MARKERS) throw new Error("CACHE_UNSAFE");
  const candidates: Array<{
    jobId: string;
    root: string;
    marker: WorkspaceMarker;
    info: Stats;
    directory?: Stats;
    bytes: number;
    identities: FileIdentity[];
  }> = [];
  for (const name of names) {
    const jobId = name.slice(0, -5);
    if (!name.endsWith(".json") || !UUID.test(jobId))
      throw new Error("CACHE_UNSAFE");
    const { marker, info } = await readMarker(cacheRoot, jobId);
    // A reused or uninspectable live PID is still protected. Identity mismatch
    // never authorizes deleting another live process's workspace.
    if (live(marker.pid)) {
      await processStartIdentity(marker.pid).catch(() => null);
      summary.preserved++;
      continue;
    }
    const root = join(cacheRoot, "jobs", jobId);
    await assertCacheDirectory(cacheRoot, join(cacheRoot, "jobs"));
    if (!(await assertCacheDirectory(cacheRoot, root))) {
      candidates.push({ jobId, root, marker, info, bytes: 0, identities: [] });
      continue;
    }
    const directory = await lstat(root);
    const workspace = await inspectWorkspace(cacheRoot, root);
    if (workspace.recovery) {
      summary.preserved++;
      continue;
    }
    candidates.push({ jobId, root, marker, info, directory, ...workspace });
  }
  // Local child groups have a 250 ms parent guardian. Allow it to terminate and
  // require a quiescent second filesystem pass before touching abandoned media.
  if (candidates.some((entry) => entry.directory)) await delay(500);
  for (const entry of candidates) {
    const current = await readMarker(cacheRoot, entry.jobId);
    if (
      !unchanged(entry.info, current.info) ||
      JSON.stringify(current.marker) !== JSON.stringify(entry.marker)
    )
      throw new Error("CACHE_UNSAFE");
    if (live(entry.marker.pid)) {
      summary.preserved++;
      continue;
    }
    if (entry.directory) {
      await assertCacheDirectory(cacheRoot, entry.root);
      const fresh = await inspectWorkspace(cacheRoot, entry.root);
      if (fresh.recovery) {
        summary.preserved++;
        continue;
      }
      if (
        !unchanged(entry.directory, await lstat(entry.root)) ||
        fresh.identities.length !== entry.identities.length ||
        fresh.identities.some(
          (item, index) =>
            item.path !== entry.identities[index]!.path ||
            !unchanged(entry.identities[index]!.info, item.info),
        )
      )
        throw new Error("CACHE_UNSAFE");
      await rm(entry.root, { recursive: true });
      await durableDirectory(join(cacheRoot, "jobs"));
      summary.removed++;
      summary.bytes += entry.bytes;
    } else if (await assertCacheDirectory(cacheRoot, entry.root)) {
      throw new Error("CACHE_UNSAFE");
    }
    const named = await lstat(markerPath(cacheRoot, entry.jobId));
    if (!unchanged(entry.info, named)) throw new Error("CACHE_UNSAFE");
    await unlink(markerPath(cacheRoot, entry.jobId));
    await durableDirectory(markers);
  }
  return summary;
}
