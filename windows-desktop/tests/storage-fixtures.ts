import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  unlink,
  rmdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import type { ConsumerProcessIdentity } from "../../worker/src/platform/windows/consumer-native.js";
import type {
  ConsumerCacheDeletion,
  ConsumerFileBirth,
  ConsumerCacheFileIdentity,
  ConsumerShareCleanupFile,
  ConsumerOwnedProcess,
  ConsumerStorageCleanupReceipt,
} from "../../worker/src/platform/windows/consumer-native.js";
import type { StorageWrite } from "../src/main/storage/write-journal.js";
import { partialWriteTarget } from "../src/main/storage/partial-write-policy.js";
import { LibraryPins } from "../src/main/library/pins.js";
import { WindowsStorageController } from "../src/main/storage/controller.js";
import { localLibraryMoveNativeFixture } from "./library-tree-native-fixture.js";
export async function storageFixture(
  pendingOriginalBytes?: () => Promise<number>,
) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-storage-code-")),
    identity = {
      sid: "S-1-5-21-100-200-300-1001",
      sessionId: 1,
      pid: 9999,
      creationTime: "9999",
    },
    parent: ConsumerProcessIdentity = {
      ...identity,
      pid: process.pid,
      creationTime: "1000",
    };
  const locks = new Set<string>();
  const candidates = new Map<
    string,
    {
      value: ConsumerCacheDeletion;
      expected: ConsumerFileBirth | ConsumerCacheFileIdentity;
      completed: boolean;
    }
  >();
  const fileIdentity = async (relative: string, kind: "file" | "directory") => {
    const row = await lstat(join(root, relative.replaceAll("\\", "/")), {
      bigint: true,
    });
    if (
      row.isSymbolicLink() ||
      (kind === "file" && (!row.isFile() || row.nlink !== 1n)) ||
      (kind === "directory" && !row.isDirectory())
    )
      throw Object.assign(new Error("PATH_UNSAFE"), { code: "PATH_UNSAFE" });
    return {
      device: String(row.dev),
      fileId: String(row.ino),
      bornAt: String(row.birthtimeNs),
      ...(kind === "file"
        ? {
            bytes: Number(row.size),
            writtenAt: String(row.mtimeNs),
            changedAt: String(row.ctimeNs),
          }
        : {}),
    };
  };
  const same = (a: object, b: object) =>
    Object.keys(a)
      .sort()
      .every((key) => Reflect.get(a, key) === Reflect.get(b, key)) &&
    Object.keys(a).length === Object.keys(b).length;
  const completedShares = new Map<string, string>();
  const storageCompletions = new Map<
    string,
    Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>
  >();
  const retireStorageFile = async (
    key: string,
    relative: string,
  ): Promise<ConsumerStorageCleanupReceipt> => {
    if (!locks.has("cache")) throw new Error("PEER_DENIED");
    const receiptId = createHash("sha256").update(key).digest("hex"),
      prior = storageCompletions.get(receiptId),
      path = join(root, relative.replaceAll("\\", "/"));
    if (prior) {
      try {
        await lstat(path);
        throw new Error("PATH_UNSAFE");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return prior;
    }
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { state: "pending" };
      throw error;
    }
    const receipt = {
      state: "completed" as const,
      receiptId,
      nonce: createHash("sha256").update(`nonce:${key}`).digest("hex"),
    };
    storageCompletions.set(receiptId, receipt);
    return receipt;
  };
  let alive = true,
    inferenceIdle = true,
    exited = false,
    free = 100 * 1024 ** 3,
    pendingOriginals = 0;
  const native = {
    openPrivateFile: vi.fn(
      privateFileNativeFixture((relative) =>
        join(root, relative.replaceAll("\\", "/")),
      ).openPrivateFile,
    ),
    moveLocalLibraryDeletion: localLibraryMoveNativeFixture({
      path: (relative) => join(root, relative.replaceAll("\\", "/")),
      cacheHeld: () => locks.has("cache"),
    }),
    discardStoragePartial: vi.fn(
      async (id: string): Promise<ConsumerStorageCleanupReceipt> => {
        const journal = JSON.parse(
            await readFile(join(root, "storage/writes.json"), "utf8"),
          ) as { writes: StorageWrite[] },
          row = journal.writes.find((r) => r.id === id);
        if (!row || !row.birth || !partialWriteTarget(row.relativePath))
          throw new Error("PATH_UNSAFE");
        if (!row.settled && alive) return { state: "pending" };
        const key = `partial:${id}`;
        if (
          !storageCompletions.has(
            createHash("sha256").update(key).digest("hex"),
          )
        ) {
          const actual = await fileIdentity(row.relativePath, "file");
          if (
            actual.device !== row.birth.device ||
            actual.fileId !== row.birth.fileId ||
            actual.bornAt !== row.birth.bornAt
          )
            throw new Error("PATH_UNSAFE");
        }
        return retireStorageFile(key, row.relativePath);
      },
    ),
    retireStorageWorkspaceMarker: vi.fn(
      async (
        relative: string,
        owner: ConsumerOwnedProcess,
      ): Promise<ConsumerStorageCleanupReceipt> => {
        const boundIdle =
          (owner.role === "personal" || owner.role === "fleet") &&
          alive &&
          same(owner.identity, parent) &&
          inferenceIdle;
        if (!(await treeExited(owner)) && !boundIdle)
          return { state: "pending" };
        const marker = `storage\\workspaces\\${createHash("sha256").update(relative).digest("hex")}.json`,
          key = `workspace:${relative}:${owner.nonce}`;
        if (
          !storageCompletions.has(
            createHash("sha256").update(key).digest("hex"),
          )
        ) {
          const row = JSON.parse(
            await readFile(join(root, marker.replaceAll("\\", "/")), "utf8"),
          ) as { relativePath: string; owner: ConsumerOwnedProcess };
          if (
            row.relativePath !== relative ||
            JSON.stringify(row.owner) !== JSON.stringify(owner)
          )
            throw new Error("PATH_UNSAFE");
        }
        return retireStorageFile(key, marker);
      },
    ),
    acknowledgeStorageCleanup: vi.fn(
      async (
        receipt: Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>,
      ) => {
        if (!locks.has("cache")) throw new Error("PEER_DENIED");
        const prior = storageCompletions.get(receipt.receiptId);
        if (prior && JSON.stringify(prior) !== JSON.stringify(receipt))
          throw new Error("PEER_DENIED");
        storageCompletions.delete(receipt.receiptId);
      },
    ),
    // Injected OS boundary over real temporary files, not Win32 HANDLE proof.
    discardShareWorkspace: vi.fn(
      async (
        requestId: string,
        birth: ConsumerFileBirth,
        file: ConsumerShareCleanupFile | null,
      ): Promise<"completed" | "pending"> => {
        if (!locks.has("cache")) throw new Error("PEER_DENIED");
        const relative = `share\\requests\\${requestId}`,
          tuple = JSON.stringify({ birth, file });
        if (completedShares.has(requestId)) {
          if (completedShares.get(requestId) !== tuple)
            throw new Error("PATH_UNSAFE");
          return "completed";
        }
        if (!same(await fileIdentity(relative, "directory"), birth))
          throw new Error("PATH_UNSAFE");
        const directory = join(root, relative.replaceAll("\\", "/")),
          names = await readdir(directory);
        if (
          names.length > 1 ||
          (names.length &&
            (!file || !file.relativePath.endsWith(`\\${names[0]}`)))
        )
          throw new Error("PATH_UNSAFE");
        if (file) {
          if (
            !same(await fileIdentity(file.relativePath, "file"), file.identity)
          )
            throw new Error("PATH_UNSAFE");
          const path = join(root, file.relativePath.replaceAll("\\", "/"));
          if (
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex") !== file.sha256
          )
            throw new Error("PATH_UNSAFE");
          await unlink(path);
        }
        await rmdir(directory);
        completedShares.set(requestId, tuple);
        return "completed";
      },
    ),
    recoverPersonalCleanups: vi.fn(async () => ({ removed: 0, retained: 0 })),
    beginCacheDeletion: vi.fn(
      async (
        relativePath: string,
        kind: "file" | "directory",
        expected: ConsumerFileBirth | ConsumerCacheFileIdentity,
      ) => {
        if (!locks.has("cache")) throw new Error("PEER_DENIED");
        if (!same(await fileIdentity(relativePath, kind), expected))
          throw Object.assign(new Error("PATH_UNSAFE"), {
            code: "PATH_UNSAFE",
          });
        const value = {
          relativePath,
          kind,
          requestId: randomUUID(),
          nonce: randomUUID(),
        };
        candidates.set(value.nonce, { value, expected, completed: false });
        return value;
      },
    ),
    commitCacheDeletion: vi.fn(
      async (
        value: ConsumerCacheDeletion,
      ): Promise<"completed" | "pending"> => {
        const candidate = candidates.get(value.nonce);
        if (!locks.has("cache") || !candidate || !same(candidate.value, value))
          throw new Error("PEER_DENIED");
        if (candidate.completed) return "completed";
        if (
          !same(
            await fileIdentity(value.relativePath, value.kind),
            candidate.expected,
          )
        )
          throw Object.assign(new Error("PATH_UNSAFE"), {
            code: "PATH_UNSAFE",
          });
        const path = join(root, value.relativePath.replaceAll("\\", "/"));
        try {
          if (value.kind === "file") await unlink(path);
          else await rmdir(path);
        } catch (error) {
          if (
            ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            return "pending";
          throw error;
        }
        candidate.completed = true;
        return "completed";
      },
    ),
    releaseCacheDeletion: vi.fn(async (value: ConsumerCacheDeletion) => {
      if (!locks.has("cache") || !candidates.get(value.nonce)?.completed)
        throw new Error("PEER_DENIED");
      candidates.delete(value.nonce);
    }),
    recoverCacheDeletions: vi.fn(async () => ({ completed: 0, pending: 0 })),
    validatePath: vi.fn(
      async (_namespace: string, relative: string, kind: string) => {
        const path = join(root, relative.replaceAll("\\", "/"));
        if (kind === "absent") {
          try {
            await lstat(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          throw new Error("PATH_EXISTS");
        }
        const stat = await lstat(path);
        if (
          stat.isSymbolicLink() ||
          (kind === "file" && (!stat.isFile() || stat.nlink !== 1)) ||
          (kind === "directory" && !stat.isDirectory())
        )
          throw new Error("PATH_UNSAFE");
      },
    ),
    acquireMutex: vi.fn(async (scope: string) => {
      if (locks.has(scope)) return null;
      locks.add(scope);
      return { scope, nonce: randomUUID(), identity };
    }),
    releaseMutex: vi.fn(async (lease: { scope: string }) => {
      if (lease.scope === "cache") candidates.clear();
      locks.delete(lease.scope);
    }),
    identity: vi.fn(async () => identity),
    processIdentity: vi.fn(async (pid: number) =>
      pid === process.pid
        ? { ...parent, creationTime: alive ? "1000" : "2000" }
        : null,
    ),
  };
  const host = {
    personalRoot: root,
    identity,
    native,
    report: { installationId: randomUUID() },
    directory: async (relative: string) => {
      const path = join(root, relative.replaceAll("\\", "/"));
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    },
  } as unknown as HostContext;
  const processIdentity = vi.fn(async (pid: number) =>
      alive && pid === parent.pid ? parent : null,
    ),
    pins = new LibraryPins(host, processIdentity),
    treeExited = vi.fn(async (_owner?: ConsumerOwnedProcess) => exited),
    controller = new WindowsStorageController({
      host,
      pins,
      processIdentity,
      treeExited,
      freeBytes: async () => free,
      pendingOriginalBytes:
        pendingOriginalBytes ?? (async () => pendingOriginals),
    });
  Object.assign(native, {
    ownedTreeExited: treeExited,
  });
  return {
    root,
    cacheHeld: () => locks.has("cache"),
    host,
    native,
    pins,
    parent,
    processIdentity,
    treeExited,
    controller,
    setAlive: (value: boolean) => {
      alive = value;
    },
    setExited: (value: boolean) => {
      exited = value;
    },
    setInferenceIdle: (value: boolean) => {
      inferenceIdle = value;
    },
    setFree: (value: number) => {
      free = value;
    },
    setPending: (value: number) => {
      pendingOriginals = value;
    },
  };
}
export async function sparseAccountVoice(
  f: Awaited<ReturnType<typeof storageFixture>>,
  index: number,
  bytes = 100000000,
) {
  const ownerUid = "storage-fixture-owner",
    owner = createHash("sha256").update(ownerUid).digest("hex"),
    jobId = index.toString(16).padStart(24, "0"),
    sha = index.toString(16).padStart(64, "0"),
    relative = `library\\media\\${owner}\\${jobId}\\voice\\${sha}`,
    directory = await f.host.directory(relative),
    artifactId = randomUUID(),
    file = await open(join(directory, "media.mp3"), "wx", 0o600);
  try {
    await file.truncate(bytes);
  } finally {
    await file.close();
  }
  const metadata = {
    version: 1,
    ownerUid,
    jobId,
    artifactId,
    relativePath: `${relative}\\media.mp3`,
    bytes,
    sha256: sha,
    durationSeconds: 60,
    contentType: "audio/mpeg",
    variant: "voice",
    createdAt: index * 1000,
  };
  await writeFile(join(directory, "media.json"), JSON.stringify(metadata));
  await utimes(directory, index, index);
  await utimes(join(directory, "media.mp3"), index, index);
  await utimes(join(directory, "media.json"), index, index);
  return {
    relative,
    artifactId,
    relativePath: metadata.relativePath,
    bytes,
    sha256: sha,
    mime: "audio/mpeg",
    durationSeconds: 60,
  };
}
