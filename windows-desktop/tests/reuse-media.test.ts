import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
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
import { WindowsReuseMedia } from "../src/main/reuse/media.js";
import { MediaShutdownPending } from "../src/main/prepare/owned-media-operation.js";
import { storageFixture } from "./storage-fixtures.js";
import type {
  CommunityArtifact,
  CommunityDelivery,
} from "../../chrome-extension/src/companion/youtube-community-client.js";
import type {
  CloudMediaChildConfig,
  CloudMediaChildResult,
} from "../src/main/cloud/media-child.js";
import type { ConsumerOwnedProcess } from "../../worker/src/platform/windows/consumer-native.js";
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
  const original = Buffer.from("synthetic source codec fixture"),
    vocals = Buffer.from("synthetic MP3 fixture"),
    sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const artifact = (kind: "original" | "vocals"): CommunityArtifact => {
    const bytes = kind === "original" ? original : vocals;
    return {
      declaration: {
        bytes: bytes.length,
        sha256: sha(bytes),
        extension: kind === "original" ? "m4a" : "mp3",
        content_type: kind === "original" ? "audio/mp4" : "audio/mpeg",
        duration_seconds: 5,
      },
      grant: {
        url: `https://fixture.r2.cloudflarestorage.com/${kind}?signature=fixture`,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    };
  };
  const delivery: CommunityDelivery = {
    video_id: "bZxrIoCPsOc",
    profile_id: "kim-vocal-2-full-timeline-v1",
    provenance: "trusted",
    source_identity_verified: true,
    original: artifact("original"),
    vocals: artifact("vocals"),
  };
  const fetcher = vi.fn<typeof fetch>(async (request) => {
    const source = String(request).includes("original"),
      data = source ? original : vocals;
    return new Response(data, {
      headers: {
        "content-type": source ? "audio/mp4" : "audio/mpeg",
        "content-length": String(data.length),
      },
    });
  });
  const tools = {
      snapshotMediaTools: async () => ({
        releaseRoot: `C:\\owned\\runtime\\releases\\${"a".repeat(64)}`,
        manifestSha256: "b".repeat(64),
        nativeSha256: "c".repeat(64),
        ffmpegPath: "fixed-ffmpeg",
        ffprobePath: "fixed-ffprobe",
      }),
    },
    owner: ConsumerOwnedProcess = {
      role: "prepare",
      nonce: "a".repeat(64),
      identity: f.parent,
    };
  const admission = {
    reserveScratch: (bytes: number, relative: string) =>
      f.controller.reserveScratch(bytes, relative),
    beginWrite: (relative: string, kind: "file" | "tree") =>
      f.controller.beginWrite(relative, kind),
    protectTree: (relative: string, purpose: "download" | "processing") =>
      f.controller.protectTree(relative, purpose),
    reserveVoice: (bytes: number, relative: string) =>
      f.controller.reserveVoice(bytes, relative),
    trackWorkspace: (
      relative: string,
      actual: ConsumerOwnedProcess,
      purpose: "download" | "processing",
    ) => f.controller.trackWorkspace(relative, actual, purpose),
  };
  const media = new WindowsReuseMedia({
    host: f.host,
    admission,
    tools,
    fetch: fetcher,
  });
  type ChildOptions = {
    beforeLaunch(): Promise<void>;
    onOwner(actual: ConsumerOwnedProcess): Promise<void>;
    configuration(
      verified: Awaited<ReturnType<typeof tools.snapshotMediaTools>>,
    ): CloudMediaChildConfig;
    parse(value: unknown, config: CloudMediaChildConfig): CloudMediaChildResult;
  };
  const commands: string[] = [];
  child.run.mockImplementation(async (options: ChildOptions) => {
    await options.beforeLaunch();
    expect(await f.controller.writes.readOwned()).toEqual([]);
    await options.onOwner(owner);
    const config = options.configuration(await tools.snapshotMediaTools());
    commands.push(config.operation);
    const bytes = config.operation === "cloud_prepare" ? original : vocals;
    f.setExited(true); // Injected Native exit proof; no Windows decoder is launched.
    return options.parse(
      {
        version: 1,
        operation: config.operation,
        requestId: config.requestId,
        executionId: config.executionId,
        source: "audio_file",
        bytes: bytes.length,
        durationSeconds: 5,
        sha256: Buffer.from(sha(bytes), "hex").toString("base64"),
        codec: config.operation === "cloud_prepare" ? "aac" : "mp3",
      },
      config,
    );
  });
  return {
    ...f,
    original,
    vocals,
    delivery,
    fetcher,
    tools,
    admission,
    media,
    commands,
  };
}
it("private real byte downloads use mandatory Node birth and exact Native handoff before both injected CPU checks", async () => {
  const f = await fixture(),
    signal = new AbortController().signal,
    downloaded = await f.media.download(f.delivery, signal, () => {}),
    rows = await f.controller.writes.readOwned();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.birth?.fileId).toMatch(/^\d+$/);
  expect(rows[0]?.settled).toBe(false);
  await f.media.validate(
    downloaded.original,
    downloaded.vocals,
    signal,
    () => {},
  );
  expect(f.commands).toEqual(["cloud_prepare", "cloud_probe"]);
  expect(await f.controller.writes.readOwned()).toEqual([]);
  expect(
    await readFile(
      join(
        f.root,
        rows[0]!.relativePath.replaceAll("\\", "/"),
        "original-media.bin",
      ),
    ),
  ).toEqual(f.original);
  await downloaded.close();
  expect(await f.pins.hasLiveConsumers()).toBe(false);
  await expect(
    lstat(join(f.root, rows[0]!.relativePath.replaceAll("\\", "/"))),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    f.fetcher.mock.calls.every(
      ([, options]) => !new Headers(options?.headers).has("authorization"),
    ),
  ).toBe(true);
});
it("the original-only delivery invokes its actual source validation branch and preserves checksum declarations", async () => {
  const f = await fixture(),
    signal = new AbortController().signal,
    downloaded = await f.media.downloadOriginal(
      f.delivery.original,
      signal,
      () => {},
    );
  await f.media.validateOriginal(downloaded.original, signal, () => {});
  expect(f.commands).toEqual(["cloud_prepare"]);
  expect(downloaded.original.declaration.sha256).toBe(
    f.delivery.original.declaration.sha256,
  );
  await downloaded.close();
});
it("a lost second decoder acknowledgement cannot reuse the first decoder's positive exit certificate", async () => {
  const f = await fixture(),
    signal = new AbortController().signal,
    downloaded = await f.media.download(f.delivery, signal, () => {}),
    row = (await f.controller.writes.readOwned())[0]!,
    first = child.run.getMockImplementation()!;
  child.run
    .mockImplementationOnce(first)
    .mockImplementationOnce(async (options) => {
      await options.beforeLaunch();
      throw new MediaShutdownPending();
    });
  await expect(
    f.media.validate(downloaded.original, downloaded.vocals, signal, () => {}),
  ).rejects.toThrow("MEDIA_SHUTDOWN_PENDING");
  expect(f.commands).toEqual(["cloud_prepare"]);
  downloaded.markUnsafe();
  await expect(downloaded.close()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  expect(await f.pins.hasLiveConsumers()).toBe(true);
  f.setAlive(false);
  f.setExited(true); // Only the first owner's certificate is available.
  await f.controller.cleanup("scratch", signal);
  expect(
    await readFile(
      join(
        f.root,
        row.relativePath.replaceAll("\\", "/"),
        "original-media.bin",
      ),
    ),
  ).toEqual(f.original);
  await expect(downloaded.close()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
});
it("unconfirmed decoder shutdown retains Native-owned scratch despite Node death until the exact exit certificate", async () => {
  const f = await fixture(),
    signal = new AbortController().signal,
    downloaded = await f.media.downloadOriginal(
      f.delivery.original,
      signal,
      () => {},
    ),
    row = (await f.controller.writes.readOwned())[0]!;
  child.run.mockImplementationOnce(async (options) => {
    await options.beforeLaunch();
    await options.onOwner({
      role: "prepare",
      nonce: "a".repeat(64),
      identity: f.parent,
    });
    throw new MediaShutdownPending();
  });
  const error = await f.media
    .validateOriginal(downloaded.original, signal, () => {})
    .catch((error) => error);
  expect(WindowsReuseMedia.shutdownPending(error)).toBe(true);
  downloaded.markUnsafe();
  await expect(downloaded.close()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  f.setAlive(false);
  await f.controller.cleanup("scratch", signal);
  const source = join(
    f.root,
    row.relativePath.replaceAll("\\", "/"),
    "original-media.bin",
  );
  expect(await readFile(source)).toEqual(f.original);
  f.setExited(true);
  await f.controller.cleanup("scratch", signal);
  await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
});
it("missing writer/native-workspace ports fail before transfer, and digest corruption never reaches validation", async () => {
  const f = await fixture(),
    { trackWorkspace: _unused, ...incomplete } = f.admission,
    signal = new AbortController().signal;
  await expect(
    new WindowsReuseMedia({
      host: f.host,
      admission: incomplete,
      tools: f.tools,
      fetch: f.fetcher,
    }).downloadOriginal(f.delivery.original, signal, () => {}),
  ).rejects.toThrow("STORAGE_NOT_READY");
  expect(f.fetcher).not.toHaveBeenCalled();
  f.fetcher.mockImplementation(
    async () =>
      new Response(Buffer.alloc(f.original.length, 7), {
        headers: {
          "content-type": "audio/mp4",
          "content-length": String(f.original.length),
        },
      }),
  );
  await expect(
    f.media.downloadOriginal(f.delivery.original, signal, () => {}),
  ).rejects.toThrow("CLOUD_REPLY_INVALID");
  expect(child.run).not.toHaveBeenCalled();
  expect(await f.controller.writes.readOwned()).toEqual([]);
});
