import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});
const child = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/main/prepare/owned-media-operation.js", async (original) => ({
  ...(await original<
    typeof import("../src/main/prepare/owned-media-operation.js")
  >()),
  runOwnedMediaOperation: child.run,
}));
import { MediaShutdownPending } from "../src/main/prepare/owned-media-operation.js";
import { WindowsCloudMedia } from "../src/main/cloud/media.js";
import { FileCapabilities } from "../src/main/file-capabilities.js";
import { storageFixture } from "./storage-fixtures.js";
import { libraryJob } from "./library-fixtures.js";
import { accountLibraryJob } from "../src/main/library/model.js";
import type {
  CloudMediaChildConfig,
  CloudMediaChildResult,
} from "../src/main/cloud/media-child.js";
import type { ConsumerOwnedProcess } from "../../worker/src/platform/windows/consumer-native.js";
import type { PrivateReadable } from "../../worker/src/platform/windows/consumer-private-file.js";
const roots: string[] = [];
afterEach(async () => {
  child.run.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  const source = join(f.root, "untouched-أغنية-source.wav"),
    original = Buffer.from("real fixture bytes, codec operation is injected"),
    prepared = Buffer.from("prepared AAC fixture"),
    voice = Buffer.from("voice MP3 fixture");
  await writeFile(source, original);
  const hash = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("base64"),
    scope = { firebaseUid: "A", generation: randomUUID() },
    files = new FileCapabilities(),
    tools = {
      snapshotMediaTools: async () => ({
        releaseRoot: `C:\\owned\\runtime\\releases\\${"a".repeat(64)}`,
        manifestSha256: "b".repeat(64),
        nativeSha256: "c".repeat(64),
        ffmpegPath: "fixed",
        ffprobePath: "fixed",
      }),
    };
  const admission = {
    reserveScratch: (bytes: number, relative: string) =>
      f.controller.reserveScratch(bytes, relative),
    beginWrite: (relative: string, kind: "tree") =>
      f.controller.beginWrite(relative, kind),
    protectTree: (relative: string, purpose: "download") =>
      f.controller.protectTree(relative, purpose),
    trackWorkspace: (
      relative: string,
      owner: ConsumerOwnedProcess,
      purpose: "processing",
    ) => f.controller.trackWorkspace(relative, owner, purpose),
  };
  const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(voice, {
          headers: {
            "content-type": "audio/mpeg",
            "content-length": String(voice.length),
          },
        }),
    ),
    media = new WindowsCloudMedia({
      host: f.host,
      files,
      fileOwner: "window",
      tools,
      admission,
      fetch: fetcher,
    }),
    context = {
      requestId: randomUUID(),
      scope,
      signal: new AbortController().signal,
      assertCurrent: vi.fn(),
    };
  type Child = {
    beforeLaunch(): Promise<void>;
    onOwner(owner: ConsumerOwnedProcess): Promise<void>;
    configuration(
      verified: Awaited<ReturnType<typeof tools.snapshotMediaTools>>,
    ): CloudMediaChildConfig;
    parse(value: unknown, config: CloudMediaChildConfig): CloudMediaChildResult;
  };
  child.run.mockImplementation(async (options: Child) => {
    await options.beforeLaunch();
    expect(await f.controller.writes.readOwned()).toEqual([]);
    await options.onOwner({
      role: "prepare",
      nonce: "a".repeat(64),
      identity: f.parent,
    });
    const config = options.configuration(await tools.snapshotMediaTools()),
      bytes = config.operation === "cloud_prepare" ? prepared : voice;
    if (config.operation === "cloud_prepare")
      await writeFile(
        join(f.root, "cloud", "work", config.requestId, "source.m4a"),
        prepared,
      );
    f.setExited(true); // Injected full-tree Native certificate; no decoder or Windows process is executed.
    return options.parse(
      {
        version: 1,
        operation: config.operation,
        requestId: config.requestId,
        executionId: config.executionId,
        source: "audio_file",
        bytes: bytes.length,
        durationSeconds: 60,
        sha256: hash(bytes),
        codec: config.operation === "cloud_prepare" ? "aac" : "mp3",
      },
      config,
    );
  });
  const job = accountLibraryJob(
      libraryJob(undefined, undefined, {
        output: {
          ...libraryJob().output,
          bytes: voice.length,
          sha256: hash(voice),
          duration_seconds: 60,
        },
      }),
    ).metadata,
    grant = {
      url: "https://fixture.r2.cloudflarestorage.com/voice?signature=fixture",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
  return {
    ...f,
    source,
    original,
    prepared,
    voice,
    media,
    context,
    scope,
    files,
    job,
    grant,
    fetcher,
  };
}
it("cloud file staging preserves source and holds one bounded scratch lease through its prepared upload lifetime", async () => {
  const f = await fixture(),
    capability = await f.files.grant(f.source, "window"),
    prepared = await f.media.prepareFile(capability, f.context);
  expect(prepared.input.bytes).toBe(f.prepared.length);
  expect(await readFile(f.source)).toEqual(f.original);
  expect(await f.pins.hasLiveConsumers()).toBe(true);
  expect(await f.controller.writes.readOwned()).toEqual([]);
  await prepared.close();
  expect(await f.pins.hasLiveConsumers()).toBe(false);
  await expect(
    lstat(join(f.root, "cloud", "work", f.context.requestId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await f.media.dispose();
});
it.each(["denied", "missing"] as const)(
  "a %s native upload reader prevents fetch and preserves prepared/source bytes",
  async (failure) => {
    const f = await fixture(),
      capability = await f.files.grant(f.source, "window"),
      prepared = await f.media.prepareFile(capability, f.context),
      original = f.host.native.openPrivateFile,
      opener = vi.fn(
        async (
          _relative: string,
          _mode: "read",
          _maximum: number,
        ): Promise<PrivateReadable | null> => {
          if (failure === "denied") throw new Error("NATIVE_SOURCE_DENIED");
          return null;
        },
      );
    Object.assign(f.host.native, { openPrivateFile: opener });
    const grant = {
      method: "PUT" as const,
      ...f.grant,
      headers: {
        "Content-Type": "audio/mp4",
        "If-None-Match": "*",
        "x-amz-checksum-sha256": prepared.input.sha256,
        "x-amz-meta-sha256": prepared.input.sha256,
      },
    };
    try {
      await expect(prepared.upload(grant, f.context.signal)).rejects.toThrow(
        failure === "denied" ? "NATIVE_SOURCE_DENIED" : "CLOUD_INPUT_INVALID",
      );
      expect(opener).toHaveBeenCalledWith(
        `cloud\\work\\${f.context.requestId}\\source.m4a`,
        "read",
        f.prepared.length,
      );
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(
        await readFile(
          join(f.root, "cloud", "work", f.context.requestId, "source.m4a"),
        ),
      ).toEqual(f.prepared);
      expect(await readFile(f.source)).toEqual(f.original);
    } finally {
      Object.assign(f.host.native, { openPrivateFile: original });
      await prepared.close();
      await f.media.dispose();
    }
  },
);
it("a consumed result FD retains its exact workspace until actual close and awaited disposal cannot delete active bytes", async () => {
  const f = await fixture(),
    capability = await f.media.download(f.job, f.grant, f.context),
    result = await f.media.consumeResult(capability, f.scope);
  expect(f.media.activity()).toMatchObject({
    grants: 0,
    borrowed: 1,
    workspaces: 1,
    idle: false,
  });
  expect(await result.file.readFile()).toEqual(f.voice);
  expect(await f.pins.hasLiveConsumers()).toBe(true);
  await expect(f.media.consumeResult(capability, f.scope)).rejects.toThrow(
    "ACCOUNT_CHANGED",
  );
  let done = false;
  const disposal = f.media.dispose().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(
    await readFile(
      join(f.root, "cloud", "work", f.context.requestId, "result.mp3"),
    ),
  ).toEqual(f.voice);
  await result.file.close();
  await disposal;
  expect(done).toBe(true);
  expect(await f.pins.hasLiveConsumers()).toBe(false);
  expect(f.media.activity().idle).toBe(true);
});
it("scope invalidation revokes only the old account capability and releases its app-owned scratch", async () => {
  const f = await fixture(),
    capability = await f.media.download(f.job, f.grant, f.context);
  await f.media.invalidateScope({ firebaseUid: "B", generation: randomUUID() });
  await expect(f.media.consumeResult(capability, f.scope)).rejects.toThrow(
    "ACCOUNT_CHANGED",
  );
  expect(await f.pins.hasLiveConsumers()).toBe(false);
  expect(await readFile(f.source)).toEqual(f.original);
  await f.media.dispose();
});
it("lost Native launch acknowledgement never grants Ready or cleanup permission from a dead Node PID", async () => {
  const f = await fixture();
  child.run.mockImplementationOnce(async (options) => {
    await options.beforeLaunch();
    throw new MediaShutdownPending();
  });
  await expect(f.media.download(f.job, f.grant, f.context)).rejects.toThrow(
    "MEDIA_SHUTDOWN_PENDING",
  );
  expect(f.media.activity()).toMatchObject({ workspaces: 1, idle: false });
  await expect(f.media.dispose()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  f.setAlive(false);
  f.setExited(true);
  await f.controller.cleanup("scratch", f.context.signal);
  expect(
    await readFile(
      join(f.root, "cloud", "work", f.context.requestId, "result.mp3"),
    ),
  ).toEqual(f.voice);
  expect(f.media.activity().idle).toBe(false);
});
it("known owner shutdown keeps pins and activity until the actual Native certificate permits recovery retry", async () => {
  const f = await fixture();
  child.run.mockImplementationOnce(async (options) => {
    await options.beforeLaunch();
    await options.onOwner({
      role: "prepare",
      nonce: "a".repeat(64),
      identity: f.parent,
    });
    throw new MediaShutdownPending();
  });
  await expect(f.media.download(f.job, f.grant, f.context)).rejects.toThrow(
    "MEDIA_SHUTDOWN_PENDING",
  );
  expect(await f.pins.hasLiveConsumers()).toBe(true);
  expect(f.media.activity().idle).toBe(false);
  await expect(f.media.dispose()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  f.setExited(true);
  await f.media.dispose();
  expect(f.treeExited).toHaveBeenCalledWith({
    role: "prepare",
    nonce: "a".repeat(64),
    identity: f.parent,
  });
  expect(await f.pins.hasLiveConsumers()).toBe(false);
  expect(f.media.activity().idle).toBe(true);
  await expect(
    lstat(join(f.root, "cloud", "work", f.context.requestId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("a pin release failure after marker removal keeps retained activity and can retry without guessing a missing marker", async () => {
  const f = await fixture(),
    original = f.pins.pinTree.bind(f.pins);
  let failed = false;
  vi.spyOn(f.pins, "pinTree").mockImplementation(async (...args) => {
    const pin = await original(...args);
    if (args[1] !== "processing") return pin;
    return {
      ...pin,
      release: async () => {
        if (!failed) {
          failed = true;
          throw new Error("PIN_RELEASE_FAILED");
        }
        await pin.release();
      },
    };
  });
  const capability = await f.media.download(f.job, f.grant, f.context),
    result = await f.media.consumeResult(capability, f.scope);
  await expect(result.file.close()).rejects.toThrow("PIN_RELEASE_FAILED");
  expect(f.media.activity()).toMatchObject({
    workspaces: 1,
    borrowed: 0,
    idle: false,
  });
  expect(await f.pins.hasLiveConsumers()).toBe(true);
  await f.media.dispose();
  expect(f.media.activity().idle).toBe(true);
  expect(await f.pins.hasLiveConsumers()).toBe(false);
});
