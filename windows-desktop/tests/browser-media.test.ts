import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WindowsBrowserMedia } from "../src/main/browser-media.js";
import type { HostContext } from "../src/main/host-context.js";
import type {
  BrowserCloudMediaPort,
  BrowserLocalReusePort,
} from "../src/main/browser/account-contracts.js";
import type { CachedAccountArtifact } from "../src/main/library/artifacts.js";
import {
  FULL_TIMELINE_RECIPE_DIGEST,
  type JobMetadata,
} from "../../chrome-extension/src/companion/cloud-provider.js";

const chromeOrigin = "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep";
const fixtures: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((close) => close()));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-browser-media-")),
    path = join(root, "voice.mp3"),
    bytes = Buffer.from("verified browser voice"),
    sha = createHash("sha256").update(bytes).digest("hex"),
    id = "a".repeat(24),
    scope = { firebaseUid: "account-a", generation: randomUUID() },
    peer = {
      pid: 41,
      creationTime: "133400000000000000",
      sid: "S-1-5-21-1-2-3-1001",
      sessionId: 1,
    };
  await writeFile(path, bytes);
  const cached: CachedAccountArtifact = {
    version: 1,
    ownerUid: scope.firebaseUid,
    jobId: id,
    artifactId: randomUUID(),
    relativePath: "library\\media\\fixture\\voice.mp3",
    bytes: bytes.length,
    sha256: sha,
    durationSeconds: 60,
    contentType: "audio/mpeg",
    variant: "voice",
    createdAt: 1,
  };
  const job: JobMetadata = {
    id,
    request_id: randomUUID(),
    status: "ready",
    processing_origin: "cloud",
    source_url: "https://www.youtube.com/watch?v=bZxrIoCPsOc",
    source_kind: "url",
    source_title: null,
    display_name: null,
    thumbnail_url: null,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    local_profile_id: null,
    trim_enabled: false,
    input: {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: 100,
      duration_seconds: 60,
      sha256: Buffer.alloc(32, 1).toString("base64"),
    },
    output: {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: bytes.length,
      duration_seconds: null,
      sha256: Buffer.from(sha, "hex").toString("base64"),
    },
    can_download_input: true,
    can_download_output: true,
    error: null,
  };
  let peerAllowed = true,
    accountAllowed = true;
  const current = () => {
    if (!accountAllowed) throw new Error("ACCOUNT_CHANGED");
  };
  const pinRelease = vi.fn(async () => {}),
    reuseRelease = vi.fn(async () => {}),
    pin = {
      artifactId: cached.artifactId,
      relativePath: cached.relativePath,
      sha256: sha,
      release: pinRelease,
    },
    cache = {
      lookup: vi.fn(async () => null as CachedAccountArtifact | null),
      download: vi.fn(async () => cached),
    },
    pins = { pin: vi.fn(async () => pin) },
    playback = {
      pin: vi.fn(async () => pin),
      resolvePlayback: vi.fn(async () => ({
        ...cached,
        path: win32.join("C:\\fixture", cached.relativePath),
        mime: "audio/mpeg" as const,
        originalDuration: 60,
        voiceDuration: 60,
        sourceDuration: 60,
        trimEnabled: false,
        accountOwned: false,
        title: "Voice",
        thumbnailUrl: null,
        current: async () => {},
      })),
    },
    reuse = {
      find: vi.fn(async () => ({
        origin: "local" as const,
        trackId: "local:voice",
        provenance: "trusted" as const,
        release: reuseRelease,
      })),
      findCached: vi.fn(async () => ({
        origin: "local" as const,
        trackId: "local:voice",
        provenance: "trusted" as const,
        release: reuseRelease,
      })),
    };
  const media = new WindowsBrowserMedia({
    host: { personalRoot: "C:\\fixture" } as HostContext,
    origin: chromeOrigin,
    cache,
    pins,
    playback,
    reuse: () => reuse,
    verifyPeer: async () => peerAllowed,
    sourceFiles: {
      openFile: () => open(path, "r"),
      fingerprint: async () => {
        const stat = await lstat(path, { bigint: true });
        return {
          device: String(stat.dev),
          fileId: String(stat.ino),
          bytes: Number(stat.size),
          writtenAt: String(stat.mtimeNs),
          changedAt: String(stat.ctimeNs),
        };
      },
    },
  });
  await media.start();
  fixtures.push(async () => {
    await media.close();
    await rm(root, { recursive: true, force: true });
  });
  const input: Parameters<BrowserCloudMediaPort["publish"]>[0] = {
    ownerId: randomUUID(),
    requestId: randomUUID(),
    peer,
    scope,
    videoId: "bZxrIoCPsOc",
    durationSeconds: 60,
    job,
    grant: {
      url: "https://fixture.invalid/private-grant",
      expires_at: "2030-01-01T00:00:00Z",
    },
    signal: new AbortController().signal,
    assertCurrent: current,
  };
  const local: Parameters<BrowserLocalReusePort["find"]>[0] = {
    ownerId: input.ownerId,
    requestId: input.requestId,
    peer,
    videoId: input.videoId,
    durationSeconds: 60,
    cacheOnly: true,
    signal: input.signal,
  };
  return {
    media,
    input,
    local,
    cache,
    pins,
    playback,
    reuse,
    pinRelease,
    reuseRelease,
    bytes,
    path,
    cached,
    changeAccount: () => {
      accountAllowed = false;
    },
    denyPeer: () => {
      peerAllowed = false;
    },
  };
}
it("serves cold cloud bytes without processing tools and accepts the contract's null output duration", async () => {
  const f = await fixture(),
    issued = await f.media.publish(f.input);
  expect(f.cache.download).toHaveBeenCalledOnce();
  expect(issued.media.trim_enabled).toBe(false);
  expect(issued.media.duration_seconds).toBe(60);
  expect(issued.media.url).not.toContain("fixture");
  const response = await fetch(issued.media.url, {
    headers: { Origin: chromeOrigin },
  });
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
  expect(
    (
      await fetch(issued.media.url, {
        headers: { Origin: "https://untrusted.invalid" },
      })
    ).status,
  ).toBe(403);
  await issued.release();
  await issued.release();
  expect(f.pinRelease).toHaveBeenCalledOnce();
  expect(f.media.activity().idle).toBe(true);
});
it("reuses verified account bytes without another download", async () => {
  const f = await fixture();
  f.cache.lookup.mockResolvedValue(f.cached);
  const issued = await f.media.publish(f.input);
  expect(f.cache.download).not.toHaveBeenCalled();
  await issued.release();
});
it("rejects a different source or trimmed timeline before requesting bytes", async () => {
  const f = await fixture();
  f.input.job.source_url = "https://www.youtube.com/watch?v=abcdefghijk";
  await expect(f.media.publish(f.input)).rejects.toThrow(
    "SOURCE_IDENTITY_MISMATCH",
  );
  f.input.job.source_url = "https://www.youtube.com/watch?v=bZxrIoCPsOc";
  f.input.job.trim_enabled = true;
  await expect(f.media.publish(f.input)).rejects.toThrow(
    "SOURCE_IDENTITY_MISMATCH",
  );
  expect(f.cache.download).not.toHaveBeenCalled();
});
it("rejects a cached artifact remapped to another account", async () => {
  const f = await fixture();
  f.cached.ownerUid = "account-b";
  await expect(f.media.publish(f.input)).rejects.toThrow(
    "SOURCE_IDENTITY_MISMATCH",
  );
  expect(f.pins.pin).not.toHaveBeenCalled();
});
it("checks actual file bytes before Chrome receives a grant", async () => {
  const f = await fixture();
  await writeFile(f.path, Buffer.alloc(f.bytes.length, 1));
  await expect(f.media.publish(f.input)).rejects.toThrow("MEDIA_UNAVAILABLE");
  expect(f.pinRelease).toHaveBeenCalledOnce();
  expect(f.media.activity().idle).toBe(true);
});
it("fences a grant after account replacement or peer death", async () => {
  const f = await fixture(),
    issued = await f.media.publish(f.input);
  f.changeAccount();
  expect((await fetch(issued.media.url)).status).toBe(403);
  await issued.release();
  const guest = await f.media.find(f.local);
  f.denyPeer();
  expect((await fetch(guest!.media.url)).status).toBe(403);
  await guest!.release();
});
it("resolves Chrome local reuse only through guest scope and retains it across account changes", async () => {
  const f = await fixture();
  f.changeAccount();
  const issued = await f.media.find(f.local);
  expect(f.reuse.findCached).toHaveBeenCalledWith(
    expect.objectContaining({ scope: null }),
    expect.any(AbortSignal),
  );
  expect(f.playback.pin).toHaveBeenCalledWith("local:voice", "voice", null);
  expect((await fetch(issued!.media.url)).status).toBe(200);
  await issued!.release();
  expect(f.reuseRelease).toHaveBeenCalledOnce();
  expect(f.pinRelease).toHaveBeenCalledOnce();
});
it("does not expose account-owned bytes through a guest reuse hit", async () => {
  const f = await fixture();
  const resolved = await f.playback.resolvePlayback();
  f.playback.resolvePlayback.mockResolvedValue({
    ...resolved,
    accountOwned: true,
  });
  await expect(f.media.find(f.local)).rejects.toThrow("PEER_DENIED");
  expect(f.reuseRelease).toHaveBeenCalledOnce();
  expect(f.pinRelease).toHaveBeenCalledOnce();
});
it("drains and revokes all byte and reuse pins on close", async () => {
  const f = await fixture(),
    issued = await f.media.find(f.local);
  expect(f.media.activity().idle).toBe(false);
  await f.media.close();
  expect(f.reuseRelease).toHaveBeenCalledOnce();
  expect(f.pinRelease).toHaveBeenCalledOnce();
  await expect(f.media.publish(f.input)).rejects.toThrow("CANCELLED");
  await expect(fetch(issued!.media.url)).rejects.toThrow();
});
it("browser close retries an exact failed reuse lease without reopening or recopying media", async () => {
  const f = await fixture();
  await f.media.find(f.local);
  f.reuseRelease.mockRejectedValueOnce(new Error("LEASE_RELEASE_UNKNOWN"));
  await expect(f.media.close()).rejects.toThrow("MEDIA_RELEASE_PENDING");
  expect(f.media.activity().idle).toBe(false);
  expect(f.pinRelease).toHaveBeenCalledOnce();
  await f.media.close();
  expect(f.reuseRelease).toHaveBeenCalledTimes(2);
  expect(f.pinRelease).toHaveBeenCalledOnce();
  expect(f.media.activity().idle).toBe(true);
  expect(f.reuse.findCached).toHaveBeenCalledOnce();
  await expect(f.media.find(f.local)).rejects.toThrow("CANCELLED");
});
it("unissued descriptor failure retains its pin cleanup until close retries the exact old owner", async () => {
  const f = await fixture();
  f.pinRelease.mockRejectedValueOnce(new Error("PIN_RELEASE_UNKNOWN"));
  await writeFile(f.path, "corrupt bytes");
  await expect(f.media.publish(f.input)).rejects.toThrow("PIN_RELEASE_UNKNOWN");
  expect(f.media.activity()).toMatchObject({ retained: 1, idle: false });
  await f.media.close();
  expect(f.media.activity().idle).toBe(true);
  expect(f.pinRelease).toHaveBeenCalledTimes(2);
  expect(f.pins.pin).toHaveBeenCalledOnce();
});
it("failed actual storage pin release remains visible and retry cleans the same descriptor/grant", async () => {
  const f = await fixture(),
    issued = await f.media.publish(f.input);
  f.pinRelease.mockRejectedValueOnce(new Error("PIN_RELEASE_UNKNOWN"));
  await expect(issued.release()).rejects.toThrow("PIN_RELEASE_UNKNOWN");
  expect(
    (await fetch(issued.media.url, { headers: { Origin: chromeOrigin } }))
      .status,
  ).toBe(403);
  expect(f.media.activity().idle).toBe(false);
  await issued.release();
  expect(f.pinRelease).toHaveBeenCalledTimes(2);
  expect(f.media.activity().idle).toBe(true);
  expect(f.cache.download).toHaveBeenCalledOnce();
});
