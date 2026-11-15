import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});
import type { HostContext } from "../src/main/host-context.js";
import { createWindowsLibrary } from "../src/main/library/factory.js";
import { LibraryArtifactCache } from "../src/main/library/artifacts.js";
import { LibraryThumbnailCache } from "../src/main/library/thumbnails.js";
import { LibraryPins } from "../src/main/library/pins.js";
import { WindowsStorageController } from "../src/main/storage/controller.js";
import { storageBirth } from "../src/main/storage/write-journal.js";
import { storagePartialNativeFixture } from "./storage-partial-native-fixture.js";
import { libraryArtifactNativeFixture } from "./library-artifact-native-fixture.js";
import { libraryTreeNativeFixture } from "./library-tree-native-fixture.js";
import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import {
  libraryOwnerA,
  libraryJob,
  libraryPersonal,
} from "./library-fixtures.js";
import { accountLibraryJob } from "../src/main/library/model.js";
import type { ConsumerProcessIdentity } from "../../worker/src/platform/windows/consumer-native.js";
import { DesktopShutdownCoordinator } from "../src/main/shutdown/coordinator.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-library-code-"));
  roots.push(root);
  const identity = {
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
  const held = new Set<string>();
  const partialNative = storagePartialNativeFixture({
    path: (relative) => join(root, relative.replaceAll("\\", "/")),
    cacheHeld: () => held.has("cache"),
    currentProcess: async (pid) => processIdentity(pid),
  });
  const native = {
    ...privateFileNativeFixture((relative) =>
      join(root, relative.replaceAll("\\", "/")),
    ),
    ...partialNative,
    ...libraryTreeNativeFixture({
      path: (relative) => join(root, relative.replaceAll("\\", "/")),
      cacheHeld: () => held.has("cache"),
    }),
    ...libraryArtifactNativeFixture({
      path: (relative) => join(root, relative.replaceAll("\\", "/")),
      cacheHeld: () => held.has("cache"),
      currentProcess: async (pid) => processIdentity(pid),
      acknowledgeOther: (receipt) =>
        partialNative.acknowledgeStorageCleanup(receipt),
    }),
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
      if (held.has(scope)) return null;
      held.add(scope);
      return { scope, nonce: randomUUID(), identity };
    }),
    releaseMutex: vi.fn(async (lease: { scope: string }) => {
      held.delete(lease.scope);
    }),
    identity: vi.fn(async () => identity),
    processIdentity: vi.fn(async (pid: number) =>
      pid === process.pid ? parent : null,
    ),
  };
  const host = {
    personalRoot: root,
    report: { installationId: randomUUID() },
    identity,
    native,
    directory: async (relative: string) => {
      const path = join(root, relative.replaceAll("\\", "/"));
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    },
  } as unknown as HostContext;
  const bytes = Buffer.from("synthetic-code-media"),
    sha = createHash("sha256").update(bytes).digest("base64"),
    raw = libraryJob(undefined, undefined, {
      input: { ...libraryJob().input, bytes: bytes.length, sha256: sha },
      output: { ...libraryJob().output, bytes: bytes.length, sha256: sha },
    }),
    job = accountLibraryJob(raw).metadata;
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(bytes, {
        headers: {
          "content-type": "audio/mpeg",
          "content-length": String(bytes.length),
        },
      }),
  );
  let current = true;
  const cache = new LibraryArtifactCache(
      host,
      () => current,
      undefined,
      fetcher,
    ),
    processIdentity = vi.fn(async (pid: number) =>
      pid === parent.pid ? parent : null,
    ),
    pins = new LibraryPins(host, processIdentity),
    storage = new WindowsStorageController({
      host,
      pins,
      processIdentity,
      treeExited: async () => true,
      freeBytes: async () => 100 * 1024 ** 3,
    });
  cache.setAdmissionHooks({
    beginWrite: (relative, kind) => storage.beginWrite(relative, kind),
    protectTree: (relative, purpose) => storage.protectTree(relative, purpose),
    reserveVoice: (bytes, relative) => storage.reserveVoice(bytes, relative),
  });
  const grant = {
    url: "https://fixture.r2.cloudflarestorage.com/media?signature=fixture",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  return {
    root,
    host,
    native,
    parent,
    processIdentity,
    pins,
    storage,
    cache,
    job,
    bytes,
    fetcher,
    grant,
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}
async function localPairFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const view = libraryPersonal();
  view.original!.sha256 = createHash("sha256").update("raw").digest("hex");
  view.vocals!.sha256 = createHash("sha256").update("vox").digest("hex");
  const library = createWindowsLibrary({
      host: f.host,
      current: (scope) => scope === null,
      processIdentity: f.processIdentity,
      controller: {
        scope: () => null,
        realtime: { watch: () => () => {} },
        request: async () => ({}),
      },
    }),
    id = await library.store.rememberPersonal(view, null),
    relative = `personal\\results\\${view.id}`,
    directory = await f.host.directory(relative);
  await writeFile(
    join(directory, "pair.json"),
    JSON.stringify({
      version: 1,
      jobId: view.id,
      original: { ...view.original!, filename: "original.m4a" },
      vocals: { ...view.vocals!, filename: "vocals.mp3" },
    }),
  );
  await writeFile(join(directory, "original.m4a"), "raw");
  await writeFile(join(directory, "vocals.mp3"), "vox");
  await library.controller.setScope(null);
  return { library, id, view, directory };
}
describe("immutable Library cache and consuming-process pins (filesystem fixtures)", () => {
  it("adopts an external result through successive held writes without truncating earlier chunks", async () => {
    const f = await fixture(),
      bytes = Buffer.alloc(2 * 1024 ** 2 + 31, 0x61),
      source = join(f.root, "external-result.mp3"),
      job = {
        ...f.job,
        output: {
          ...f.job.output!,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("base64"),
        },
      };
    await writeFile(source, bytes);
    const cache = new LibraryArtifactCache(
      f.host,
      () => true,
      async () => ({
        file: await open(source, "r"),
        name: "external-result.mp3",
        bytes: bytes.length,
      }),
    );
    cache.setAdmissionHooks({
      beginWrite: (relative, kind) => f.storage.beginWrite(relative, kind),
      protectTree: (relative, purpose) =>
        f.storage.protectTree(relative, purpose),
      reserveVoice: (bytes, relative) =>
        f.storage.reserveVoice(bytes, relative),
    });
    const result = await cache.adopt(
      "fixture-capability",
      job,
      libraryOwnerA,
      new AbortController().signal,
    );
    expect(
      await readFile(join(f.root, result.relativePath.replaceAll("\\", "/"))),
    ).toEqual(bytes);
    expect(await readFile(source)).toEqual(bytes);
    expect(await f.storage.writes.readOwned()).toEqual([]);
    expect(cache.cleanupActivity()).toEqual({ active: 0 });
  });
  it("reuses exact verified content and artifact identity without overwriting a pinned file", async () => {
    const f = await fixture(),
      a = await f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
      path = join(f.root, a.relativePath.replaceAll("\\", "/")),
      before = await lstat(path, { bigint: true });
    const pin = await f.pins.pin({ ...a, mime: a.contentType });
    try {
      const b = await f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      );
      expect(b.artifactId).toBe(a.artifactId);
      expect((await lstat(path, { bigint: true })).ino).toBe(before.ino);
      expect(await readFile(path)).toEqual(f.bytes);
      await expect(
        f.pins.exclusiveUnpinned([a.relativePath], async () => {}),
      ).rejects.toThrow("LIBRARY_MEDIA_PINNED");
      expect(f.processIdentity).toHaveBeenCalledWith(process.pid);
      const registry = JSON.parse(
        await readFile(join(f.root, "library", "pins.json"), "utf8"),
      );
      expect(registry.pins[0].owner).toMatchObject({
        pid: process.pid,
        creationTime: f.parent.creationTime,
      });
    } finally {
      await pin.release();
    }
  });
  it("holds the same cache mutex across cleanup recheck and deletion", async () => {
    const f = await fixture(),
      artifact = await f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      );
    let reached!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
    const cleanup = f.pins.exclusiveUnpinned(
      [artifact.relativePath],
      async () => {
        reached();
        await wait;
      },
    );
    await entered;
    await expect(
      f.pins.pin({ ...artifact, mime: artifact.contentType }),
    ).rejects.toThrow("LIBRARY_BUSY");
    finish();
    await cleanup;
    const pin = await f.pins.pin({ ...artifact, mime: artifact.contentType });
    await pin.release();
  });
  it("keeps a pin when the helper has died but the consuming parent birth remains live", async () => {
    const f = await fixture(),
      artifact = await f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
      pin = await f.pins.pin({ ...artifact, mime: artifact.contentType });
    f.native.identity.mockRejectedValue(new Error("HELPER_CLOSED"));
    expect((await f.pins.protectedDirectories()).size).toBe(1);
    await pin.release();
  });
  it("prunes a reused PID only after exact parent birth mismatch", async () => {
    const f = await fixture(),
      artifact = await f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      );
    await f.pins.pin({ ...artifact, mime: artifact.contentType });
    f.processIdentity.mockResolvedValue({
      ...f.parent,
      creationTime: "2000",
    });
    expect((await f.pins.protectedDirectories()).size).toBe(0);
  });
  it("does not replace existing content after a corrupt late transfer or account change", async () => {
    const f = await fixture(),
      artifact = await f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      );
    const pin = await f.pins.pin({ ...artifact, mime: artifact.contentType });
    f.fetcher.mockResolvedValue(
      new Response(Buffer.alloc(f.bytes.length, 1), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(
      (await f.cache.lookup(f.job, libraryOwnerA, new AbortController().signal))
        ?.artifactId,
    ).toBe(artifact.artifactId);
    expect(
      await readFile(join(f.root, artifact.relativePath.replaceAll("\\", "/"))),
    ).toEqual(f.bytes);
    await expect(
      f.pins.exclusiveUnpinned([artifact.relativePath], async () => {}),
    ).rejects.toThrow("LIBRARY_MEDIA_PINNED");
    f.setCurrent(false);
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await pin.release();
  });
  it("retires a corrupt created download through its exact journal/birth receiver before releasing admission", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(Buffer.alloc(f.bytes.length, 1), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("CLOUD_REPLY_INVALID");
    expect(f.native.discardLibraryArtifact).toHaveBeenCalledOnce();
    const [id, relative, identity] =
      f.native.discardLibraryArtifact.mock.calls[0]!;
    expect(id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(relative).toMatch(/media\.mp3\.[a-f0-9-]{36}\.part$/u);
    expect(identity).toMatchObject({
      bytes: f.bytes.length,
      bornAt: expect.any(String),
      fileId: expect.any(String),
    });
    await expect(
      lstat(join(f.root, relative.replaceAll("\\", "/"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.storage.writes.readOwned()).toEqual([]);
    expect((await f.pins.protectedDirectories()).size).toBe(0);
  });
  it("cleans its exact renamed generation after account scope changes without nesting the publication cache lease", async () => {
    const f = await fixture(),
      validate = f.native.validatePath.getMockImplementation()!;
    f.native.validatePath.mockImplementation(
      async (namespace, relative, kind) => {
        await validate(namespace, relative, kind);
        if (kind === "file" && relative.endsWith("\\media.mp3"))
          f.setCurrent(false);
      },
    );
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect(
      f.native.discardLibraryArtifact.mock.calls.some(([, relative]) =>
        relative.endsWith("\\media.mp3"),
      ),
    ).toBe(true);
    for (const [, relative] of f.native.discardLibraryArtifact.mock.calls)
      await expect(
        lstat(join(f.root, relative.replaceAll("\\", "/"))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.storage.writes.readOwned())[0]?.settled).toBe(true);
    expect((await f.pins.protectedDirectories()).size).toBe(0);
  });
  it("preserves a replacement generation after rename and retains its unsettled journal and pin", async () => {
    const f = await fixture(),
      validate = f.native.validatePath.getMockImplementation()!;
    let foreign: string | undefined;
    f.native.validatePath.mockImplementation(
      async (namespace, relative, kind) => {
        await validate(namespace, relative, kind);
        if (!foreign && kind === "file" && relative.endsWith("\\media.mp3")) {
          foreign = join(f.root, relative.replaceAll("\\", "/"));
          await rename(foreign, `${foreign}.retained-original`);
          await writeFile(foreign, "foreign replacement");
        }
      },
    );
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("LIBRARY_RESULT_CHANGED");
    expect(await readFile(foreign!, "utf8")).toBe("foreign replacement");
    const rows = await f.storage.writes.readOwned();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.settled).toBe(false);
    expect((await f.pins.protectedDirectories()).size).toBe(1);
    expect(f.native.inspectLibraryArtifactPublication).toHaveBeenCalledWith(
      rows[0]!.id,
      "media",
    );
    expect(
      f.native.discardLibraryArtifact.mock.calls.some(
        ([, relative]) => relative === rows[0]!.publication!.relativePath,
      ),
    ).toBe(false);
  });
  it("retains capacity, writer and pin after pending deletion, then retries exact cleanup before another transfer", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(Buffer.alloc(f.bytes.length, 1), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    f.native.discardLibraryArtifact.mockResolvedValueOnce({ state: "pending" });
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("CLOUD_REPLY_INVALID");
    const [id, relative, identity] =
      f.native.discardLibraryArtifact.mock.calls[0]!;
    expect((await f.storage.writes.readOwned())[0]).toMatchObject({
      id,
      settled: false,
    });
    expect(
      JSON.parse(
        await readFile(join(f.root, "storage", "reservations.json"), "utf8"),
      ).reservations,
    ).toEqual([expect.objectContaining({ bytes: f.bytes.length })]);
    expect((await f.pins.protectedDirectories()).size).toBe(1);
    expect(
      (await lstat(join(f.root, relative.replaceAll("\\", "/")))).size,
    ).toBe(f.bytes.length);
    const artifact = await f.cache.download(
      f.job,
      f.grant,
      libraryOwnerA,
      new AbortController().signal,
    );
    expect(f.native.discardLibraryArtifact.mock.calls[1]).toEqual([
      id,
      relative,
      identity,
    ]);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(artifact.bytes).toBe(f.bytes.length);
    expect(await f.storage.writes.readOwned()).toEqual([]);
    expect((await f.pins.protectedDirectories()).size).toBe(0);
    expect(
      JSON.parse(
        await readFile(join(f.root, "storage", "reservations.json"), "utf8"),
      ).reservations,
    ).toEqual([]);
  });
  it("retries only the captured metadata ACK after completed deletion reply", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(Buffer.alloc(f.bytes.length, 1), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    f.native.acknowledgeStorageCleanup.mockRejectedValueOnce(
      new Error("ACK_LOST"),
    );
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("CLOUD_REPLY_INVALID");
    expect(f.native.discardLibraryArtifact).toHaveBeenCalledOnce();
    expect((await f.storage.writes.readOwned())[0]?.settled).toBe(false);
    expect((await f.pins.protectedDirectories()).size).toBe(1);
    const receipt = f.native.acknowledgeStorageCleanup.mock.calls[0]![0];
    await f.cache.download(
      f.job,
      f.grant,
      libraryOwnerA,
      new AbortController().signal,
    );
    expect(f.native.discardLibraryArtifact).toHaveBeenCalledOnce();
    expect(f.native.acknowledgeStorageCleanup.mock.calls[1]).toEqual([receipt]);
    expect(await f.storage.writes.readOwned()).toEqual([]);
    expect((await f.pins.protectedDirectories()).size).toBe(0);
  });
  it("reports deferred exact cleanup and closes it without starting another transfer or memoizing rejection", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(Buffer.alloc(f.bytes.length, 1), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    f.native.discardLibraryArtifact.mockResolvedValueOnce({ state: "pending" });
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("CLOUD_REPLY_INVALID");
    expect(f.cache.cleanupActivity()).toEqual({ active: 1 });
    const exact = f.native.discardLibraryArtifact.mock.calls[0];
    f.native.discardLibraryArtifact.mockResolvedValueOnce({ state: "pending" });
    await expect(f.cache.close()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
    expect(f.cache.cleanupActivity()).toEqual({ active: 1 });
    await f.cache.close();
    expect(f.native.discardLibraryArtifact.mock.calls[1]).toEqual(exact);
    expect(f.native.discardLibraryArtifact.mock.calls[2]).toEqual(exact);
    expect(f.cache.cleanupActivity()).toEqual({ active: 0 });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(await f.storage.writes.readOwned()).toEqual([]);
    expect((await f.pins.protectedDirectories()).size).toBe(0);
    expect(
      JSON.parse(
        await readFile(join(f.root, "storage", "reservations.json"), "utf8"),
      ).reservations,
    ).toEqual([]);
  });
  it("reports an actual active transfer and refuses cleanup closure until it has settled", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.fetcher.mockImplementationOnce(async () => {
      entered();
      await wait;
      return new Response(f.bytes, {
        headers: { "content-type": "audio/mpeg" },
      });
    });
    const transfer = f.cache.download(
      f.job,
      f.grant,
      libraryOwnerA,
      new AbortController().signal,
    );
    await reached;
    expect(f.cache.cleanupActivity()).toEqual({ active: 1 });
    await expect(f.cache.close()).rejects.toThrow("LIBRARY_BUSY");
    expect(f.native.discardLibraryArtifact).not.toHaveBeenCalled();
    release();
    await transfer;
    await f.cache.close();
    expect(f.cache.cleanupActivity()).toEqual({ active: 0 });
  });
  it("recovers a lost completed deletion reply from the exact native receipt while retaining original failure", async () => {
    const f = await fixture(),
      discard = f.native.discardLibraryArtifact.getMockImplementation()!;
    f.fetcher.mockResolvedValueOnce(
      new Response(Buffer.alloc(f.bytes.length, 1), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    f.native.discardLibraryArtifact.mockImplementationOnce(async (...args) => {
      await discard(...args);
      throw new Error("NATIVE_REPLY_LOST");
    });
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("CLOUD_REPLY_INVALID");
    expect((await f.storage.writes.readOwned())[0]?.settled).toBe(false);
    expect((await f.pins.protectedDirectories()).size).toBe(1);
    await f.cache.download(
      f.job,
      f.grant,
      libraryOwnerA,
      new AbortController().signal,
    );
    expect(f.native.discardLibraryArtifact.mock.calls[1]).toEqual(
      f.native.discardLibraryArtifact.mock.calls[0],
    );
    expect(await f.storage.writes.readOwned()).toEqual([]);
    expect((await f.pins.protectedDirectories()).size).toBe(0);
  });
  it("downloads original media against its own exact hash/type without account authorization headers", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValue(
      new Response(f.bytes, { headers: { "content-type": "audio/mp4" } }),
    );
    const artifact = await f.cache.download(
      f.job,
      f.grant,
      libraryOwnerA,
      new AbortController().signal,
      "original",
    );
    expect(artifact).toMatchObject({
      variant: "original",
      contentType: "audio/mp4",
      bytes: f.bytes.length,
    });
    expect(artifact.relativePath).toContain("\\original\\");
    expect(
      new Headers(f.fetcher.mock.calls[0]?.[1]?.headers).has("authorization"),
    ).toBe(false);
    expect(
      await f.cache.lookup(
        f.job,
        libraryOwnerA,
        new AbortController().signal,
        "voice",
      ),
    ).toBeNull();
  });
  it("retains durable outbox protection after process pins disappear", async () => {
    const f = await fixture(),
      artifact = await f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
      pins = new LibraryPins(
        f.host,
        f.processIdentity,
        async () => new Set([artifact.relativePath]),
      );
    await expect(
      pins.exclusiveUnpinned([artifact.relativePath], async () => {}),
    ).rejects.toThrow("LIBRARY_MEDIA_PINNED");
  });
  it("caches only bounded public thumbnail pixels and survives offline reuse", async () => {
    const f = await fixture(),
      jpeg = Buffer.from([
        255, 216, 255, 192, 0, 11, 8, 0, 100, 0, 100, 1, 1, 17, 0, 255, 217,
      ]);
    const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
      ),
      cache = new LibraryThumbnailCache(f.host, fetcher),
      url = "https://i.ytimg.com/vi/12345678901/hqdefault.jpg";
    cache.setWriteAdmission({
      beginPartialWrite: (relative, bytes) =>
        f.storage.beginPartialWrite(relative, bytes),
      recoverPartialWrites: (relative, signal) =>
        f.storage.recoverPartialWrites(relative, signal),
    });
    const pixels = await cache.resolve(url, new AbortController().signal);
    expect(pixels).toMatch(/^data:image\/jpeg;base64,/u);
    fetcher.mockRejectedValue(new Error("OFFLINE"));
    expect(await cache.resolve(url, new AbortController().signal)).toBe(pixels);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      await cache.resolve(
        "https://private.r2.cloudflarestorage.com/image",
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("uses a safe fallback for private redirects, oversize and invalid thumbnail responses", async () => {
    const f = await fixture(),
      fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response("<svg><script>bad</script></svg>", {
            headers: { "content-type": "image/svg+xml" },
          }),
      ),
      cache = new LibraryThumbnailCache(f.host, fetcher);
    cache.setWriteAdmission({
      beginPartialWrite: (relative, bytes) =>
        f.storage.beginPartialWrite(relative, bytes),
      recoverPartialWrites: (relative, signal) =>
        f.storage.recoverPartialWrites(relative, signal),
    });
    expect(
      await cache.resolve(
        "https://i.ytimg.com/vi/12345678901/hqdefault.jpg",
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
    });
    fetcher.mockResolvedValueOnce(
      new Response("x", { headers: { "content-length": "99999999" } }),
    );
    expect(
      await cache.resolve(
        "https://i.ytimg.com/vi/12345678901/mqdefault.jpg",
        new AbortController().signal,
      ),
    ).toBeNull();
  });
  it("recovers an interrupted thumbnail copier by exact old Node/file birth before publishing one verified image", async () => {
    const f = await fixture(),
      url = "https://i.ytimg.com/vi/12345678901/hqdefault.jpg",
      canonical = `library\\thumbnails\\${createHash("sha256").update(url).digest("hex")}.image`,
      temporary = `${canonical}.${randomUUID()}.tmp`,
      jpeg = Buffer.from([
        255, 216, 255, 192, 0, 11, 8, 0, 100, 0, 100, 1, 1, 17, 0, 255, 217,
      ]);
    await f.host.directory("library\\thumbnails");
    const write = await f.storage.beginPartialWrite(temporary, jpeg.length),
      path = join(f.root, temporary.replaceAll("\\", "/"));
    await writeFile(path, Buffer.alloc(0));
    await write.captureCreated(
      storageBirth(await lstat(path, { bigint: true })),
    );
    await writeFile(path, jpeg.subarray(0, 5));
    f.processIdentity.mockImplementation(async (pid) =>
      pid === process.pid ? { ...f.parent, creationTime: "2000" } : null,
    );
    const cache = new LibraryThumbnailCache(
      f.host,
      async () => new Response(jpeg),
    );
    cache.setWriteAdmission({
      beginPartialWrite: (relative, bytes) =>
        f.storage.beginPartialWrite(relative, bytes),
      recoverPartialWrites: (relative, signal) =>
        f.storage.recoverPartialWrites(relative, signal),
    });
    expect(await cache.resolve(url, new AbortController().signal)).toBe(
      `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    );
    expect(
      await readFile(join(f.root, canonical.replaceAll("\\", "/"))),
    ).toEqual(jpeg);
    expect(await readdir(join(f.root, "library", "thumbnails"))).toEqual([
      canonical.split("\\").at(-1),
    ]);
    expect(await f.storage.writes.readOwned()).toEqual([]);
  });
  it("does not start a thumbnail transfer without actual write admission", async () => {
    const f = await fixture(),
      fetcher = vi.fn<typeof fetch>();
    expect(
      await new LibraryThumbnailCache(f.host, fetcher).resolve(
        "https://i.ytimg.com/vi/12345678901/hqdefault.jpg",
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deletes only an unpinned app-owned local pair and never the selected user source", async () => {
    const f = await fixture(),
      { library, id, view, directory } = await localPairFixture(f);
    const userSource = join(f.root, "user-selected-source.wav");
    await writeFile(userSource, "user source");
    const artifact = await library.cache.local(view.id, view.vocals!, "voice"),
      pin = await library.pins.pin(artifact);
    await expect(
      library.controller.act({ type: "DELETE_LOCAL", trackId: id }),
    ).rejects.toThrow("LIBRARY_MEDIA_PINNED");
    expect(await readFile(join(directory, "vocals.mp3"), "utf8")).toBe("vox");
    await pin.release();
    await library.controller.act({ type: "DELETE_LOCAL", trackId: id });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await library.store.snapshot(null)).guest.entries).toEqual([]);
    expect(await readFile(userSource, "utf8")).toBe("user source");
    library.controller.dispose();
  });
  it("retains the actual shutdown gate after local deletion ACK loss, then closes by metadata ACK without another byte deletion", async () => {
    const f = await fixture(),
      { library, id, directory } = await localPairFixture(f),
      release = vi.fn(async () => {});
    f.native.acknowledgeLibraryTreeCleanup.mockRejectedValueOnce(
      new Error("ACK_LOST"),
    );
    await expect(
      library.controller.act({ type: "DELETE_LOCAL", trackId: id }),
    ).rejects.toThrow("ACK_LOST");
    expect(f.native.discardLibraryTree).toHaveBeenCalledOnce();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(library.cleanupActivity()).toEqual({ active: 1 });
    const receipt = f.native.acknowledgeLibraryTreeCleanup.mock.calls[0]![0];
    f.native.acknowledgeLibraryTreeCleanup.mockRejectedValueOnce(
      new Error("ACK_STILL_LOST"),
    );
    const shutdown = new DesktopShutdownCoordinator({
      fence: () => library.controller.dispose(),
      cancel: () => [],
      settle: async () => {},
      cleanup: () => [() => library.close()],
      assertIdle: () => {
        if (library.cleanupActivity().active)
          throw new Error("SHUTDOWN_PENDING");
      },
      release: () => [release],
    });
    expect((await shutdown.begin()).phase).toBe("pending");
    expect(release).not.toHaveBeenCalled();
    expect(library.cleanupActivity()).toEqual({ active: 1 });
    expect((await shutdown.retry()).phase).toBe("complete");
    expect(release).toHaveBeenCalledOnce();
    expect(library.cleanupActivity()).toEqual({ active: 0 });
    expect(f.native.discardLibraryTree).toHaveBeenCalledOnce();
    expect(f.native.acknowledgeLibraryTreeCleanup.mock.calls).toEqual([
      [receipt],
      [receipt],
      [receipt],
    ]);
    expect(f.native.listLibraryCleanups).toHaveBeenCalledTimes(2);
  });
  it("restores the native completed cleanup receipt into a fresh host and closes by exact ACK only", async () => {
    const f = await fixture(),
      { library, id } = await localPairFixture(f);
    f.native.acknowledgeLibraryTreeCleanup.mockRejectedValueOnce(
      new Error("ACK_LOST"),
    );
    await expect(
      library.controller.act({ type: "DELETE_LOCAL", trackId: id }),
    ).rejects.toThrow("ACK_LOST");
    const receipt = f.native.acknowledgeLibraryTreeCleanup.mock.calls[0]![0];
    library.controller.dispose();
    const reopened = createWindowsLibrary({
      host: { ...f.host } as unknown as HostContext,
      current: (scope) => scope === null,
      processIdentity: f.processIdentity,
      controller: {
        scope: () => null,
        realtime: { watch: () => () => {} },
        request: async () => ({}),
      },
    });
    await reopened.close();
    expect(f.native.listLibraryCleanups).toHaveBeenCalledOnce();
    expect(f.native.acknowledgeLibraryTreeCleanup.mock.calls[1]).toEqual([
      receipt,
    ]);
    expect(f.native.discardLibraryTree).toHaveBeenCalledOnce();
    expect(reopened.cleanupActivity()).toEqual({ active: 0 });
    reopened.controller.dispose();
  });
  it("inspects a lost publication ACK and cleans the exact moved generation without publishing again", async () => {
    const f = await fixture(),
      publish = f.native.publishLibraryArtifact.getMockImplementation()!;
    f.native.publishLibraryArtifact.mockImplementationOnce(
      async (id, component) => {
        await publish(id, component);
        throw new Error("PUBLISH_ACK_LOST");
      },
    );
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("PUBLISH_ACK_LOST");
    expect(f.native.publishLibraryArtifact).toHaveBeenCalledOnce();
    expect(f.native.inspectLibraryArtifactPublication).toHaveBeenCalledOnce();
    expect(f.cache.cleanupActivity()).toEqual({ active: 0 });
    expect(f.storage.view().reservedVoicesBytes).toBe(0);
    expect(
      f.native.discardLibraryArtifact.mock.calls.some((call) =>
        call[1].endsWith("media.mp3"),
      ),
    ).toBe(true);
  });
  it("a new canonical generation at publication is preserved and the owned temporary alone is retired", async () => {
    const f = await fixture(),
      publish = f.native.publishLibraryArtifact.getMockImplementation()!;
    let path = "";
    f.native.publishLibraryArtifact.mockImplementationOnce(
      async (id, component) => {
        const journal = JSON.parse(
          await readFile(join(f.root, "storage", "writes.json"), "utf8"),
        ) as {
          writes: { id: string; publication: { relativePath: string } }[];
        };
        path = join(
          f.root,
          journal.writes
            .find((row) => row.id === id)!
            .publication.relativePath.replaceAll("\\", "/"),
        );
        await writeFile(path, "foreign canonical", "utf8");
        await publish(id, component);
      },
    );
    await expect(
      f.cache.download(
        f.job,
        f.grant,
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("PATH_UNSAFE");
    expect(await readFile(path, "utf8")).toBe("foreign canonical");
    expect(f.cache.cleanupActivity().active).toBeGreaterThan(0);
  });
});
