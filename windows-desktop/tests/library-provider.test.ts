import { describe, expect, it, vi } from "vitest";
import { LibraryPlaybackProvider } from "../src/main/library/provider.js";
import { LibraryStore } from "../src/main/library/store.js";
import { accountLibraryJob, localTrackId } from "../src/main/library/model.js";
import type { HostContext } from "../src/main/host-context.js";
import type { LibraryArtifactCache } from "../src/main/library/artifacts.js";
import type { LibraryPins } from "../src/main/library/pins.js";
import {
  libraryPersonal,
  libraryOwnerA,
  libraryOwnerB,
  libraryJob,
  MemoryLibraryDisk,
} from "./library-fixtures.js";
import type { SessionAccountScope } from "../src/shared/session-contracts.js";
async function fixture() {
  let scope: SessionAccountScope | null = null;
  const current = (candidate: SessionAccountScope | null) =>
      candidate === null ||
      (candidate?.firebaseUid === scope?.firebaseUid &&
        candidate?.generation === scope?.generation),
    disk = new MemoryLibraryDisk(),
    store = new LibraryStore(disk, current),
    view = libraryPersonal(),
    id = await store.rememberPersonal(view, null),
    validatePath = vi.fn(async () => {}),
    host = {
      personalRoot: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
      native: { validatePath },
    } as unknown as HostContext;
  const file = {
      relativePath: `personal\\results\\${view.id}\\vocals.mp3`,
      artifactId: view.vocals!.id,
      sha256: view.vocals!.sha256,
      bytes: view.vocals!.bytes,
      mime: "audio/mpeg",
      durationSeconds: 60,
    },
    release = vi.fn(async () => {}),
    cache = {
      local: vi.fn(async () => file),
      lookup: vi.fn(async () => ({
        ...file,
        contentType: file.mime,
        relativePath: "library\\media\\owner\\voice.mp3",
      })),
    },
    pins = {
      pin: vi.fn(async (selected) => ({
        artifactId: selected.artifactId,
        relativePath: selected.relativePath,
        sha256: selected.sha256,
        release,
      })),
    },
    provider = new LibraryPlaybackProvider(
      host,
      store,
      cache as unknown as LibraryArtifactCache,
      pins as unknown as LibraryPins,
      current,
    );
  return {
    disk,
    store,
    view,
    id,
    current,
    cache,
    pins,
    release,
    provider,
    setScope: (next: SessionAccountScope | null) => {
      scope = next;
    },
  };
}
describe("trusted Library playback source resolution", () => {
  it("a valid original remains standalone when a trimmed account voice duration/map is unavailable", async () => {
    const h = await fixture();
    h.setScope(libraryOwnerA);
    const raw = libraryJob(undefined, undefined, {
      trim_enabled: true,
      comparison_ranges: "corrupt",
      output: { ...libraryJob().output, duration_seconds: null },
    });
    await h.store.saveAccountJobs(libraryOwnerA, [accountLibraryJob(raw)]);
    const artifact = await h.provider.resolvePlayback(
      raw.id,
      "original",
      libraryOwnerA,
      new AbortController().signal,
    );
    expect(artifact).toMatchObject({
      originalDuration: 60,
      sourceDuration: 60,
      voiceDuration: null,
      trimEnabled: true,
      accountOwned: true,
    });
    expect(artifact.comparisonRanges).toBeUndefined();
  });
  it("returns private paths only to main with exact artifact metadata and full durations", async () => {
    const h = await fixture(),
      source = await h.provider.resolvePlayback(
        h.id,
        "voice",
        null,
        new AbortController().signal,
      );
    expect(source).toMatchObject({
      artifactId: h.view.vocals!.id,
      accountOwned: false,
      originalDuration: 60,
      voiceDuration: 60,
      sourceDuration: 60,
      trimEnabled: false,
      mime: "audio/mpeg",
    });
    expect(source.path).toMatch(/^C:\\/u);
    const pin = await h.provider.pin(h.id, "voice", null);
    expect(pin.artifactId).toBe(source.artifactId);
    await pin.release();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("keeps guest resolution and pins independent of captured desktop account after A to B/signout", async () => {
    const h = await fixture();
    h.setScope(libraryOwnerA);
    const source = await h.provider.resolvePlayback(
      h.id,
      "original",
      libraryOwnerA,
      new AbortController().signal,
    );
    h.setScope(libraryOwnerB);
    await expect(source.current()).resolves.toBeUndefined();
    await expect(
      h.provider.resolvePlayback(
        h.id,
        "voice",
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ accountOwned: false });
    h.setScope(null);
    const receipt = await h.provider.pin(h.id, "voice", libraryOwnerA);
    await receipt.release();
    expect(h.cache.local).toHaveBeenCalledWith(
      h.view.id,
      h.view.original,
      "original",
    );
  });
  it("binds account bytes to exact current generation and carries backend trim ranges without remapping", async () => {
    const h = await fixture();
    h.setScope(libraryOwnerA);
    const raw = libraryJob(undefined, undefined, {
      trim_enabled: true,
      comparison_ranges: [[0, 1323000]],
      output: { ...libraryJob().output, duration_seconds: 30 },
    });
    await h.store.saveAccountJobs(libraryOwnerA, [accountLibraryJob(raw)]);
    const source = await h.provider.resolvePlayback(
      raw.id,
      "voice",
      libraryOwnerA,
      new AbortController().signal,
    );
    expect(source).toMatchObject({
      accountOwned: true,
      trimEnabled: true,
      comparisonRanges: [[0, 1323000]],
      originalDuration: 60,
      voiceDuration: 30,
    });
    h.setScope({ ...libraryOwnerA, generation: libraryOwnerB.generation });
    await expect(source.current()).rejects.toThrow("ACCOUNT_CHANGED");
  });
  it("requires a separate retained original cache and does not substitute vocals", async () => {
    const h = await fixture();
    h.setScope(libraryOwnerA);
    await h.store.saveAccountJobs(libraryOwnerA, [
      accountLibraryJob(libraryJob()),
    ]);
    h.cache.lookup.mockResolvedValueOnce(null as never);
    await expect(
      h.provider.resolvePlayback(
        libraryJob().id,
        "original",
        libraryOwnerA,
        new AbortController().signal,
      ),
    ).rejects.toThrow("LIBRARY_DOWNLOAD_REQUIRED");
    expect(h.cache.lookup).toHaveBeenLastCalledWith(
      expect.any(Object),
      libraryOwnerA,
      expect.any(AbortSignal),
      "original",
    );
  });
  it("releases a new pin if account changes during asynchronous acquisition", async () => {
    const h = await fixture();
    h.setScope(libraryOwnerA);
    await h.store.saveAccountJobs(libraryOwnerA, [
      accountLibraryJob(libraryJob()),
    ]);
    h.pins.pin.mockImplementationOnce(async (selected) => {
      h.setScope(libraryOwnerB);
      return { ...selected, release: h.release };
    });
    await expect(
      h.provider.pin(libraryJob().id, "voice", libraryOwnerA),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect(h.release).toHaveBeenCalledOnce();
    expect(localTrackId((await h.disk.read(null)).entries[0]!)).toBe(h.id);
  });
  it("carries private trimmed PCM ranges without exposing a proportional timeline", async () => {
    const h = await fixture(),
      view = libraryPersonal();
    view.vocals!.durationSeconds = 59.03;
    const timeline = {
      version: 1 as const,
      trimEnabled: true,
      sourceSamples: 2646000,
      outputSamples: 2601900,
      comparisonRanges: [
        [0, 44100],
        [88200, 2646000],
      ] as [number, number][],
    };
    const id = await h.store.rememberPersonal(view, null, timeline);
    h.cache.local.mockResolvedValueOnce({
      relativePath: `personal\\results\\${view.id}\\vocals.mp3`,
      artifactId: view.vocals!.id,
      sha256: view.vocals!.sha256,
      bytes: 3,
      mime: "audio/mpeg",
      durationSeconds: 59.03,
    });
    const artifact = await h.provider.resolvePlayback(
      id,
      "voice",
      null,
      new AbortController().signal,
    );
    expect(artifact).toMatchObject({
      originalDuration: 60,
      voiceDuration: 59.03,
      sourceDuration: 59.03,
      trimEnabled: true,
      comparisonRanges: [
        [0, 44100],
        [88200, 2646000],
      ],
    });
    expect(
      (await h.disk.read(null)).entries.find(
        (entry) => entry.personalJobId === view.id,
      )?.catalog.trim_enabled,
    ).toBe(true);
  });
  it("restores only an exact current-account linked copy after local eviction", async () => {
    const h = await fixture();
    h.setScope(libraryOwnerA);
    const job = accountLibraryJob(libraryJob());
    await h.store.saveAccountJobs(libraryOwnerA, [job]);
    await h.store.linkPersonal(
      h.id,
      libraryOwnerA,
      job.metadata.id,
      h.view.vocals!.sha256,
    );
    h.cache.local.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    const artifact = await h.provider.resolvePlayback(
      h.id,
      "voice",
      libraryOwnerA,
      new AbortController().signal,
    );
    expect(artifact).toMatchObject({
      accountOwned: true,
      relativePath: "library\\media\\owner\\voice.mp3",
    });
    h.setScope(libraryOwnerB);
    await expect(artifact.current()).rejects.toThrow("ACCOUNT_CHANGED");
  });
});
