import { createHash } from "node:crypto";
import { lstat, open, readFile, rm, writeFile } from "node:fs/promises";
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
import { WindowsSilenceRunner } from "../src/main/player/silence-runner.js";
import { MediaShutdownPending } from "../src/main/prepare/owned-media-operation.js";
import { storageFixture } from "./storage-fixtures.js";
import type { VerifiedPlaybackFile } from "../src/main/player/media-server.js";
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  child.run.mockReset();
  await Promise.all(closes.splice(0).map((close) => close()));
});
async function fixture() {
  const f = await storageFixture(),
    source = join(f.root, "voice-source.mp3"),
    bytes = Buffer.from(
      "trusted voice fixture; decoder and Win32 process are injected",
    );
  await writeFile(source, bytes);
  const file = await open(source, "r"),
    sha = createHash("sha256").update(bytes).digest("hex"),
    verified: VerifiedPlaybackFile = {
      file,
      bytes: bytes.length,
      mime: "audio/mpeg",
      current: vi.fn(async () => {}),
      release: async () => file.close(),
    },
    admission = {
      reserveScratch: (count: number, relative: string) =>
        f.controller.reserveScratch(count, relative),
      beginWrite: (relative: string, kind: "tree") =>
        f.controller.beginWrite(relative, kind),
      protectTree: (relative: string, purpose: "download") =>
        f.controller.protectTree(relative, purpose),
      trackWorkspace: f.controller.trackWorkspace.bind(f.controller),
    },
    runner = new WindowsSilenceRunner(
      f.host,
      {
        snapshotMediaTools: async () => {
          throw new Error("unused injected codec");
        },
      },
      admission,
    );
  let work = "";
  child.run.mockImplementation(async (options) => {
    const config = options.configuration({
      releaseRoot: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      nativeSha256: "c".repeat(64),
    });
    work = `prepare/work/${config.requestId}`;
    expect(await readFile(join(f.root, work, "voice.bin"))).toEqual(bytes);
    await options.beforeLaunch();
    await options.onOwner({
      role: "prepare",
      nonce: "d".repeat(64),
      identity: f.parent,
    });
    f.setExited(true);
    return { ranges: [{ start: 1, end: 2 }] };
  });
  closes.push(async () => {
    await file.close();
    await rm(f.root, { recursive: true, force: true });
  });
  return {
    ...f,
    runner,
    verified,
    sha,
    source,
    bytes,
    work: () => join(f.root, work),
  };
}
it("reserves/captures before copied bytes and binds actual native ownership before silence decoding", async () => {
  const f = await fixture();
  expect(
    await f.runner.run(f.verified, f.sha, 60, new AbortController().signal),
  ).toEqual([{ start: 1, end: 2 }]);
  expect(await readFile(f.source)).toEqual(f.bytes);
  await expect(lstat(f.work())).rejects.toMatchObject({ code: "ENOENT" });
  const reservations = await readFile(
    join(f.root, "storage", "scratch-reservations.json"),
    "utf8",
  );
  expect(JSON.parse(reservations).reservations).toEqual([]);
});
it("does not launch a decoder when verified source bytes no longer match their declaration", async () => {
  const f = await fixture();
  await writeFile(f.source, Buffer.alloc(f.bytes.length, 1));
  await expect(
    f.runner.run(f.verified, f.sha, 60, new AbortController().signal),
  ).rejects.toThrow("SILENCE_UNAVAILABLE");
  expect(child.run).not.toHaveBeenCalled();
});
it("keeps an acknowledgement-gap workspace protected rather than deleting by a guessed process ID", async () => {
  const f = await fixture();
  child.run.mockImplementation(async (options) => {
    const config = options.configuration({
      releaseRoot: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      nativeSha256: "c".repeat(64),
    });
    await options.beforeLaunch();
    throw Object.assign(new MediaShutdownPending(), {
      requestId: config.requestId,
    });
  });
  await expect(
    f.runner.run(f.verified, f.sha, 60, new AbortController().signal),
  ).rejects.toThrow("MEDIA_SHUTDOWN_PENDING");
  const raw = JSON.parse(
    await readFile(
      join(f.root, "storage", "scratch-reservations.json"),
      "utf8",
    ),
  );
  expect(raw.reservations).toHaveLength(1);
  expect(raw.reservations[0].nativePending).toBe(true);
  expect(f.runner.activity()).toEqual({
    pending: 0,
    workspaces: 1,
    idle: false,
  });
  await expect(f.runner.dispose()).rejects.toThrow("SILENCE_SHUTDOWN_PENDING");
  expect(f.runner.activity().idle).toBe(false);
  expect(f.treeExited).not.toHaveBeenCalled();
  await expect(
    f.runner.run(f.verified, f.sha, 60, new AbortController().signal),
  ).rejects.toThrow("SILENCE_UNAVAILABLE");
  expect(
    await readFile(
      join(
        f.root,
        raw.reservations[0].relativePath.replaceAll("\\", "/"),
        "voice.bin",
      ),
    ),
  ).toEqual(f.bytes);
});
it("releases retained bytes only after the captured native owner has an exact tree-exit certificate", async () => {
  const f = await fixture();
  child.run.mockImplementation(async (options) => {
    await options.configuration({
      releaseRoot: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      nativeSha256: "c".repeat(64),
    });
    await options.beforeLaunch();
    await options.onOwner({
      role: "prepare",
      nonce: "d".repeat(64),
      identity: f.parent,
    });
    throw new MediaShutdownPending();
  });
  const changes: boolean[] = [];
  f.runner.subscribeActivity(() => changes.push(f.runner.activity().idle));
  await expect(
    f.runner.run(f.verified, f.sha, 60, new AbortController().signal),
  ).rejects.toThrow("MEDIA_SHUTDOWN_PENDING");
  await expect(f.runner.dispose()).rejects.toThrow("SILENCE_SHUTDOWN_PENDING");
  expect(f.runner.activity()).toEqual({
    pending: 0,
    workspaces: 1,
    idle: false,
  });
  expect(changes.slice(1)).not.toContain(true);
  f.setExited(true);
  await f.runner.dispose();
  expect(f.runner.activity()).toEqual({
    pending: 0,
    workspaces: 0,
    idle: true,
  });
  expect(f.treeExited).toHaveBeenCalledWith({
    role: "prepare",
    nonce: "d".repeat(64),
    identity: f.parent,
  });
  expect(
    JSON.parse(
      await readFile(
        join(f.root, "storage", "scratch-reservations.json"),
        "utf8",
      ),
    ).reservations,
  ).toEqual([]);
  expect(await readFile(f.source)).toEqual(f.bytes);
});
