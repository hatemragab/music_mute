import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportLibraryTrack,
  libraryExportFilename,
} from "../src/main/library/export.js";
import type {
  LibraryPlaybackPort,
  LibraryPlaybackArtifact,
} from "../src/main/library/playback.js";
import { TrustedSaveDestinations } from "../src/main/save-destinations.js";
import { fixtureCreatedExportDiscard } from "./export-discard-fixture.js";
const roots: string[] = [];
const registries: TrustedSaveDestinations[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    registries.splice(0).map((registry) => registry.close()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-library-export-code-"));
  roots.push(root);
  const data = Buffer.from("synthetic-code-media"),
    path = join(root, "owned.mp3"),
    target = join(root, "saved.mp3"),
    id = randomUUID(),
    sha = createHash("sha256").update(data).digest("hex");
  await writeFile(path, data);
  const release = vi.fn(async () => {}),
    artifact: LibraryPlaybackArtifact = {
      path,
      relativePath: "personal\\results\\fixture\\vocals.mp3",
      artifactId: id,
      bytes: data.length,
      sha256: sha,
      mime: "audio/mpeg",
      originalDuration: 60,
      voiceDuration: 60,
      sourceDuration: 60,
      trimEnabled: false,
      accountOwned: false,
      title: "CON",
      thumbnailUrl: null,
      current: async () => {},
    };
  const playback: LibraryPlaybackPort = {
    pin: async () => ({
      artifactId: id,
      relativePath: artifact.relativePath,
      sha256: sha,
      release,
    }),
    resolvePlayback: async () => artifact,
  };
  const destination = {
    choose: vi.fn(async () => {
      const file = await open(target, "wx", 0o600);
      return {
        file,
        commit: async () => file.close(),
        discard: async () => {
          await file.close();
          await unlink(target);
        },
      };
    }),
  };
  return { root, path, target, data, artifact, playback, destination, release };
}
describe("Library export descriptor capability", () => {
  it("uses safe Windows names and refuses unsupported extensions", () => {
    expect(libraryExportFilename("CON", "audio/mpeg")).toBe("Voice_CON.mp3");
    expect(libraryExportFilename(" A/B:C? . ", "audio/mp4")).toBe("A_B_C_.m4a");
    expect(() => libraryExportFilename("title", "text/html")).toThrow(
      "LIBRARY_RESULT_INVALID",
    );
  });
  it("copies a verified pinned artifact without deleting source and fsyncs before commit", async () => {
    const f = await fixture();
    expect(
      await exportLibraryTrack({
        ...f,
        trackId: "track",
        variant: "voice",
        scope: null,
        signal: new AbortController().signal,
      }),
    ).toBe(true);
    expect(await readFile(f.target)).toEqual(f.data);
    expect(await readFile(f.path)).toEqual(f.data);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.destination.choose).toHaveBeenCalledWith(
      "Voice_CON.mp3",
      "audio/mpeg",
      expect.any(AbortSignal),
    );
  });
  it("rejects an existing destination without overwriting it", async () => {
    const f = await fixture();
    await writeFile(f.target, "existing");
    await expect(
      exportLibraryTrack({
        ...f,
        trackId: "track",
        variant: "voice",
        scope: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(f.target, "utf8")).toBe("existing");
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("drops its new destination when source changes and always releases the pin", async () => {
    const f = await fixture();
    f.artifact.sha256 = "0".repeat(64);
    f.playback.pin = async () => ({
      artifactId: f.artifact.artifactId,
      relativePath: f.artifact.relativePath,
      sha256: f.artifact.sha256,
      release: f.release,
    });
    await expect(
      exportLibraryTrack({
        ...f,
        trackId: "track",
        variant: "voice",
        scope: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("LIBRARY_RESULT_INVALID");
    await expect(readFile(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.path)).toEqual(f.data);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("refuses a remapped artifact before opening a destination", async () => {
    const f = await fixture();
    f.artifact.artifactId = randomUUID();
    await expect(
      exportLibraryTrack({
        ...f,
        trackId: "track",
        variant: "voice",
        scope: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("LIBRARY_RESULT_CHANGED");
    expect(f.destination.choose).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("actual owner retirement waits for direct export's source-pin finally and preserves its completed file", async () => {
    const f = await fixture();
    let resolve!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((done) => {
      resolve = done;
    });
    const releasing = new Promise<void>((done) => {
      entered = done;
    });
    f.release.mockImplementation(async () => {
      entered();
      await held;
    });
    const registry = new TrustedSaveDestinations(
      async () => ({
        canceled: false,
        filePath: f.target,
      }),
      undefined,
      undefined,
      fixtureCreatedExportDiscard(),
    );
    registries.push(registry);
    const owner = { id: "direct-export-owner", current: () => true };
    const exported = registry.runOwned(
      owner,
      new AbortController().signal,
      (signal, retainCleanup) =>
        exportLibraryTrack({
          playback: f.playback,
          destination: {
            choose: (name, _mime, chosenSignal) =>
              registry.choose(name, "Export", owner, chosenSignal),
          },
          retainCleanup,
          signal,
          trackId: "track",
          variant: "voice",
          scope: null,
        }),
    );
    await releasing;
    let retired = false;
    const retirement = registry.revokeOwner(owner.id).then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    expect(registry.activity().idle).toBe(false);
    resolve();
    expect(await exported).toBe(true);
    await retirement;
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(registry.activity().idle).toBe(true);
    expect(await readFile(f.target)).toEqual(f.data);
    expect(await readFile(f.path)).toEqual(f.data);
  });

  it("retains a failed actual source-close before releasing its pin and retries only those exact handles", async () => {
    const f = await fixture();
    const registry = new TrustedSaveDestinations(
      async () => ({
        canceled: false,
        filePath: f.target,
      }),
      undefined,
      undefined,
      fixtureCreatedExportDiscard(),
    );
    registries.push(registry);
    const owner = { id: "source-close-owner", current: () => true };
    let registration = 0;
    let permitClose = false;
    const closing = vi.fn();
    try {
      await expect(
        registry.runOwned(
          owner,
          new AbortController().signal,
          (signal, retainCleanup) =>
            exportLibraryTrack({
              playback: f.playback,
              destination: {
                choose: (name, _mime, chosenSignal) =>
                  registry.choose(name, "Export", owner, chosenSignal),
              },
              retainCleanup: (cleanup) => {
                registration++;
                if (registration !== 2) return retainCleanup(cleanup);
                return retainCleanup(async () => {
                  closing();
                  if (!permitClose)
                    throw new Error("PRIVATE_SOURCE_CLOSE_FAILURE");
                  await cleanup();
                });
              },
              signal,
              trackId: "track",
              variant: "voice",
              scope: null,
            }),
        ),
      ).rejects.toThrow("LIBRARY_EXPORT_CLEANUP_PENDING");
      expect(f.release).not.toHaveBeenCalled();
      expect(registry.activity().retained).toBe(2);
      expect(registry.activity().idle).toBe(false);
      permitClose = true;
      await registry.revokeOwner(owner.id);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(closing).toHaveBeenCalledTimes(3);
      expect(registry.activity().idle).toBe(true);
      expect(await readFile(f.path)).toEqual(f.data);
      expect(await readFile(f.target)).toEqual(f.data);
    } finally {
      permitClose = true;
    }
  });

  it("preserves the original fixed artifact failure while retained pin cleanup fails and later retires positively", async () => {
    const f = await fixture();
    f.artifact.artifactId = randomUUID();
    f.release
      .mockRejectedValueOnce(new Error("PRIVATE_PIN_FAILURE"))
      .mockResolvedValue(undefined);
    const registry = new TrustedSaveDestinations(
      async () => ({
        canceled: false,
        filePath: f.target,
      }),
      undefined,
      undefined,
      fixtureCreatedExportDiscard(),
    );
    registries.push(registry);
    const owner = { id: "failed-pin-owner", current: () => true };
    await expect(
      registry.runOwned(
        owner,
        new AbortController().signal,
        (signal, retainCleanup) =>
          exportLibraryTrack({
            ...f,
            trackId: "track",
            variant: "voice",
            scope: null,
            signal,
            retainCleanup,
          }),
      ),
    ).rejects.toThrow("LIBRARY_RESULT_CHANGED");
    expect(registry.activity().idle).toBe(false);
    expect(registry.activity().retained).toBe(1);
    await registry.revokeOwner(owner.id);
    expect(registry.activity().idle).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.destination.choose).not.toHaveBeenCalled();
    expect(await readFile(f.path)).toEqual(f.data);
  });
});
