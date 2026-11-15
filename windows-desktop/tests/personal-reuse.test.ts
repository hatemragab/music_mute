import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rm, unlink, writeFile } from "node:fs/promises";
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
import { WindowsPersonalReuse } from "../src/main/personal/reuse.js";
import { PrivatePersonalStorage } from "../src/main/personal/storage.js";
import type { PersonalRunContext } from "../src/main/personal/controller.js";
import { LibraryArtifactCache } from "../src/main/library/artifacts.js";
import { LibraryStore, WindowsLibraryDisk } from "../src/main/library/store.js";
import { parsePersonalPair } from "../src/main/reuse/pair.js";
import type { YouTubeCommunityClient } from "../../chrome-extension/src/companion/youtube-community-client.js";
import type { WindowsReuseMedia } from "../src/main/reuse/media.js";
import { storageFixture } from "./storage-fixtures.js";
import { receiptFixture } from "./reuse-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  const receipt = receiptFixture(),
    original = Buffer.from("source codec bytes are synthetic in this fixture"),
    voice = Buffer.from("voice codec bytes are synthetic in this fixture");
  f.host.report.installationId = receipt.completion.installationId;
  const raw = {
    ...receipt.raw,
    original: {
      ...receipt.raw.original,
      bytes: original.length,
      sha256: hash(original),
    },
    vocals: { ...receipt.raw.vocals, bytes: voice.length, sha256: hash(voice) },
    reuseReceipt: {
      ...receipt.reuse,
      source: {
        ...receipt.reuse.source,
        inputBytes: original.length,
        inputSha256: hash(original),
      },
      originalSha256: hash(original),
      vocalsSha256: hash(voice),
    },
    completionReceipt: {
      ...receipt.completion,
      originalSha256: hash(original),
      vocalsSha256: hash(voice),
    },
  };
  const pair = parsePersonalPair(
      raw,
      f.host.report.installationId,
      receipt.entry.personalJobId,
    ),
    sourceRoot = await f.host.directory(
      `personal\\results\\${pair.entry.personalJobId}`,
    );
  await writeFile(join(sourceRoot, "pair.json"), JSON.stringify(raw));
  await writeFile(join(sourceRoot, "original.m4a"), original);
  await writeFile(join(sourceRoot, "vocals.mp3"), voice);
  const store = new LibraryStore(
      new WindowsLibraryDisk(f.host),
      (scope) => scope === null,
    ),
    cache = new LibraryArtifactCache(f.host, () => false);
  await store.rememberPersonal(pair.view, null);
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
      owner: Parameters<typeof f.controller.trackWorkspace>[1],
      purpose: "processing" | "download",
    ) => f.controller.trackWorkspace(relative, owner, purpose),
  };
  const tools = {
      snapshotMediaTools: vi.fn(async () => {
        throw new Error("CPU_TOOL_MUST_NOT_RUN_FOR_LOCAL_HIT");
      }),
    },
    abort = new AbortController(),
    context: PersonalRunContext = {
      jobId: randomUUID(),
      ownerId: randomUUID(),
      requestId: randomUUID(),
      scope: null,
      recipeId: "kim-vocals-v2",
      workDirectory: "unused",
      signal: abort.signal,
      progress: vi.fn(),
    };
  await f.host.directory(`personal\\jobs\\${context.jobId}`);
  const options = {
      host: f.host,
      store,
      cache,
      pins: f.pins,
      admission,
      tools,
    },
    reuse = new WindowsPersonalReuse(options);
  return {
    ...f,
    raw,
    pair,
    sourceRoot,
    original,
    voice,
    store,
    cache,
    admission,
    tools,
    context,
    abort,
    options,
    reuse,
  };
}
it("uses an actual private guest pair before downloader or GPU and adopts exact immutable bytes into the current request", async () => {
  const f = await fixture(),
    hit = await f.reuse.lookup("bZxrIoCPsOc", f.context);
  expect(hit?.kind).toBe("pair");
  if (hit?.kind !== "pair") throw new Error("EXPECTED_PAIR");
  try {
    const result = await hit.adopt(),
      root = join(f.root, "personal", "results", f.context.jobId),
      raw = JSON.parse(await readFile(join(root, "pair.json"), "utf8"));
    expect(await readFile(join(root, "original.m4a"))).toEqual(f.original);
    expect(await readFile(join(root, "vocals.mp3"))).toEqual(f.voice);
    expect(raw.completionReceipt).toMatchObject({
      installationId: f.host.report.installationId,
      jobId: f.context.jobId,
      ownerId: f.context.ownerId,
      requestId: f.context.requestId,
      capturedAccountScope: null,
    });
    expect(result.vocals.sha256).toBe(hash(f.voice));
    expect(result.vocals.id).not.toBe(f.pair.entry.vocals.id);
    expect((await f.store.snapshot(null)).guest.entries).toHaveLength(2);
    expect(await f.controller.writes.readOwned()).toEqual([]);
    expect(f.tools.snapshotMediaTools).not.toHaveBeenCalled();
    expect(f.reuse.publisher).toBeUndefined();
  } finally {
    await hit.release();
    await f.reuse.dispose();
  }
  expect(await readFile(join(f.sourceRoot, "vocals.mp3"))).toEqual(f.voice);
  expect(await f.pins.hasLiveConsumers()).toBe(false);
});
it("uses the retained exact input after voice eviction while preserving source proof for new inference", async () => {
  const f = await fixture();
  await unlink(join(f.sourceRoot, "vocals.mp3"));
  const hit = await f.reuse.lookup("bZxrIoCPsOc", f.context);
  expect(hit?.kind).toBe("original");
  if (hit?.kind !== "original") throw new Error("EXPECTED_ORIGINAL");
  try {
    expect(await readFile(hit.input.path)).toEqual(f.original);
    expect(hit.input.sourceIdentity).toEqual(f.raw.reuseReceipt.source);
    expect(hit.input.sha256).toBe(hash(f.original));
    expect(f.tools.snapshotMediaTools).not.toHaveBeenCalled();
  } finally {
    await hit.release();
  }
  expect(await readFile(join(f.sourceRoot, "original.m4a"))).toEqual(
    f.original,
  );
  expect((await f.store.snapshot(null)).guest.entries).toHaveLength(1);
});
it("does not relabel a retained normalized original as the original source identity", async () => {
  const f = await fixture();
  await unlink(join(f.sourceRoot, "vocals.mp3"));
  f.raw.reuseReceipt.source.inputSha256 = "b".repeat(64);
  await writeFile(join(f.sourceRoot, "pair.json"), JSON.stringify(f.raw));
  expect(await f.reuse.lookup("bZxrIoCPsOc", f.context)).toBeNull();
  expect(await f.pins.hasLiveConsumers()).toBe(false);
});
it("rejects claimed checksum corruption without fabricating a hit or acquisition fallback", async () => {
  const f = await fixture();
  await writeFile(
    join(f.sourceRoot, "vocals.mp3"),
    Buffer.alloc(f.voice.length, 9),
  );
  await expect(f.reuse.lookup("bZxrIoCPsOc", f.context)).rejects.toThrow(
    "LIBRARY_RESULT_INVALID",
  );
  expect(await f.pins.hasLiveConsumers()).toBe(false);
  expect(f.tools.snapshotMediaTools).not.toHaveBeenCalled();
});
it("cancellation between verified lookup and adoption creates no ready artifact and releases exact pins", async () => {
  const f = await fixture(),
    hit = await f.reuse.lookup("bZxrIoCPsOc", f.context);
  if (hit?.kind !== "pair") throw new Error("EXPECTED_PAIR");
  f.abort.abort();
  await expect(hit.adopt()).rejects.toThrow();
  await hit.release();
  await expect(
    lstat(join(f.root, "personal", "results", f.context.jobId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.pins.hasLiveConsumers()).toBe(false);
});
it("an absent backend origin is a local-only miss and a private trim recipe never consults community", async () => {
  const f = await fixture();
  expect(await f.reuse.lookup("aaaaaaaaaaa", f.context)).toBeNull();
  const lookup = vi.fn(async () => {
      throw new Error("MUST_NOT_RUN");
    }),
    configured = new WindowsPersonalReuse({
      ...f.options,
      community: { lookup } as unknown as YouTubeCommunityClient,
    });
  expect(
    await configured.lookup("bZxrIoCPsOc", {
      ...f.context,
      recipeId: "kim-vocals-v2-trim",
    }),
  ).toBeNull();
  expect(lookup).not.toHaveBeenCalled();
  await configured.dispose();
});
it("headless reuse cannot report idle or dispose successfully while exact account-cache cleanup is unconfirmed", async () => {
  const f = await fixture(),
    activity = vi
      .spyOn(f.cache, "cleanupActivity")
      .mockReturnValue({ active: 1 }),
    close = vi
      .spyOn(f.cache, "close")
      .mockRejectedValueOnce(new Error("LIBRARY_DELETE_PENDING"))
      .mockImplementation(async () => {
        activity.mockReturnValue({ active: 0 });
      });
  expect(f.reuse.idle()).toBe(false);
  await expect(f.reuse.dispose()).rejects.toThrow("LIBRARY_DELETE_PENDING");
  expect(f.reuse.idle()).toBe(false);
  await f.reuse.dispose();
  expect(close).toHaveBeenCalledTimes(2);
  expect(f.reuse.idle()).toBe(true);
});
it("a community original hit requires its validated CPU source before copying, and retains the original request reservation", async () => {
  const f = await fixture(),
    release = vi.fn(async () => {}),
    reservation = {
      request_id: f.context.requestId,
      contribution_id: "a".repeat(24),
      video_id: "aaaaaaaaaaa",
      profile_id: "kim-vocal-2-full-timeline-v1",
      producer: true,
      state: "preparing",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      lease_expires_at: new Date(Date.now() + 600000).toISOString(),
      upload_grants: null,
    };
  const file = await import("node:fs/promises").then((fs) =>
      fs.open(join(f.sourceRoot, "original.m4a"), "r"),
    ),
    item = { file, declaration: f.pair.entry.original, extension: "m4a" },
    declaration = {
      declaration: { sha256: hash(f.original), bytes: f.original.length },
    },
    lookup = vi.fn(async () => null),
    reserve = vi.fn(async () => reservation),
    lookupOriginal = vi.fn(async () => declaration),
    validateOriginal = vi.fn(async () => {});
  const configured = new WindowsPersonalReuse({
    ...f.options,
    community: {
      lookup,
      reserve,
      lookupOriginal,
    } as unknown as YouTubeCommunityClient,
    media: {
      downloadOriginal: async () => ({
        original: item,
        close: release,
        markUnsafe: vi.fn(),
      }),
      validateOriginal,
    } as unknown as WindowsReuseMedia,
  });
  try {
    const hit = await configured.lookup("aaaaaaaaaaa", f.context);
    expect(hit?.kind).toBe("original");
    if (hit?.kind !== "original") throw new Error("EXPECTED_ORIGINAL");
    expect(await readFile(hit.input.path)).toEqual(f.original);
    expect(hit.input.sourceIdentity).toMatchObject({
      kind: "community-youtube",
      videoId: "aaaaaaaaaaa",
      provenance: "trusted",
      sourceIdentityVerified: true,
    });
    expect(validateOriginal).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(
      "aaaaaaaaaaa",
      f.context.signal,
      f.context.requestId,
    );
    expect(lookupOriginal).toHaveBeenCalledWith(
      reservation,
      undefined,
      f.context.signal,
    );
    await hit.release();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    await file.close();
    await configured.dispose();
  }
});
it("lost catalog acknowledgement after pair rename retains immutable bytes through failed scratch cleanup and exact recovery", async () => {
  const f = await fixture(),
    hit = await f.reuse.lookup("bZxrIoCPsOc", f.context);
  if (hit?.kind !== "pair") throw new Error("EXPECTED_PAIR");
  vi.spyOn(f.store, "rememberPersonal").mockRejectedValueOnce(
    new Error("CATALOG_ACK_LOST"),
  );
  await expect(hit.adopt()).rejects.toThrow("CATALOG_ACK_LOST");
  await hit.release();
  await f.controller.trackWorkspace(
    `personal\\jobs\\${f.context.jobId}`,
    { role: "personal", nonce: "a".repeat(64), identity: f.parent },
    "processing",
  );
  f.setExited(true);
  const storage = new PrivatePersonalStorage(f.host, {
    assertRecoveredExit: (relative) =>
      f.controller.assertWorkspaceExited(relative),
    beginWrite: (relative, kind) => f.controller.beginWrite(relative, kind),
    trackWorkspace: (relative) =>
      f.controller.trackWorkspace(
        relative,
        { role: "personal", nonce: "a".repeat(64), identity: f.parent },
        "processing",
      ),
    protectTree: (relative, purpose) =>
      f.controller.protectTree(relative, purpose),
    protectPlannedTree: (relative, purpose) =>
      f.controller.protectTree(relative, purpose, true),
    reserveVoice: (bytes, relative) =>
      f.controller.reserveVoice(bytes, relative),
  });
  await storage.cleanup(f.context.jobId, false);
  const recovered = await storage.recover({
    ownerId: f.context.ownerId,
    requestId: f.context.requestId,
    jobId: f.context.jobId,
    digest: "a".repeat(64),
    state: "inflight",
    capturedAccountScope: null,
  });
  expect(recovered?.view).toMatchObject({
    state: "ready",
    ownerId: f.context.ownerId,
  });
  expect(
    await readFile(
      join(f.root, "personal", "results", f.context.jobId, "vocals.mp3"),
    ),
  ).toEqual(f.voice);
  await f.store.rememberPersonal(
    recovered!.view,
    null,
    recovered!.result.timeline,
  );
  expect((await f.store.snapshot(null)).guest.entries).toHaveLength(2);
});
