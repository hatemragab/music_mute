import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportLibraryTrack } from "../src/main/library/export.js";
import { emptyPartition } from "../src/main/library/store.js";
import { localTrackId } from "../src/main/library/model.js";
import { saveLocalToAccount } from "../src/main/outbox/local-save.js";
import { PlaybackController } from "../src/main/player/controller.js";
import { parsePersonalPair } from "../src/main/reuse/pair.js";
import { receiptFixture } from "./reuse-fixtures.js";
import type {
  LibraryPlaybackArtifact,
  LibraryPlaybackPort,
} from "../src/main/library/playback.js";

const roots: string[] = [],
  releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(accountOwned = false) {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-library-export-matrix-"),
  );
  roots.push(root);
  const data = Buffer.alloc(1024 ** 2 + 31, 0x5a),
    source = join(root, "trimmed-voice.mp3"),
    target = join(root, "new-export.mp3"),
    unrelated = join(root, "unrelated-existing-file.mp3"),
    scope = accountOwned
      ? { firebaseUid: "fixture-a", generation: randomUUID() }
      : null;
  await writeFile(source, data);
  await writeFile(unrelated, "existing unrelated bytes");
  let current = true;
  const release = vi.fn(async () => {}),
    commit = vi.fn(),
    discard = vi.fn(),
    artifact: LibraryPlaybackArtifact = {
      path: source,
      relativePath: "personal\\results\\fixture\\vocals.mp3",
      artifactId: randomUUID(),
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      mime: "audio/mpeg",
      originalDuration: 60,
      voiceDuration: 20,
      sourceDuration: 20,
      trimEnabled: true,
      accountOwned,
      title: "Trimmed voice",
      thumbnailUrl: null,
      // Trusted descriptor authority is the injected boundary; byte I/O and export are real.
      current: async () => {
        if (accountOwned && !current) throw new Error("ACCOUNT_CHANGED");
      },
    },
    playback: LibraryPlaybackPort = {
      pin: async () => ({
        artifactId: artifact.artifactId,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
        release,
      }),
      resolvePlayback: async () => artifact,
    },
    destination = {
      choose: vi.fn(async () => {
        const file = await open(target, "wx", 0o600);
        return {
          file,
          commit: async () => {
            commit();
            await file.close();
          },
          discard: async () => {
            discard();
            await file.close();
            await unlink(target);
          },
        };
      }),
    },
    abort = new AbortController();
  return {
    source,
    target,
    unrelated,
    data,
    scope,
    artifact,
    playback,
    destination,
    release,
    commit,
    discard,
    abort,
    options: {
      playback,
      destination,
      trackId: "fixture",
      variant: "voice" as const,
      scope,
      signal: abort.signal,
    },
    retire: () => {
      current = false;
    },
  };
}

describe("W16 exact trimmed export and interrupted destination I/O", () => {
  it("keeps actual guest playback and bytes intact when a verified trimmed pair cannot use full-timeline Save", async () => {
    const f = await fixture(),
      receipts = receiptFixture(),
      pair = parsePersonalPair(
        {
          version: 1,
          jobId: receipts.entry.personalJobId,
          original: receipts.raw.original,
          vocals: { ...receipts.raw.vocals, durationSeconds: 20 },
          completionReceipt: receipts.completion,
          timeline: {
            version: 1,
            trimEnabled: true,
            sourceSamples: 60 * 44100,
            outputSamples: 20 * 44100,
            comparisonRanges: [[10 * 44100, 30 * 44100]],
          },
        },
        receipts.completion.installationId,
        receipts.entry.personalJobId,
      ),
      guest = emptyPartition(null),
      stage = vi.fn();
    guest.entries.push(pair.entry);
    const player = new PlaybackController({
      open: async () => ({
        url: `http://127.0.0.1:1234/media/${randomUUID()}?capability=${"x".repeat(43)}`,
        originalDuration: 60,
        voiceDuration: 20,
        sourceDuration: 20,
        trimmed: true,
        accountOwned: false,
        release: f.release,
      }),
    });
    try {
      await player.execute({ type: "LOAD", trackId: localTrackId(pair.entry) });
      await player.execute({
        type: "MEDIA_EVENT",
        generation: player.view().generation,
        event: "playing",
        position: 0,
      });
      const before = player.view();
      expect(before.phase).toBe("playing");
      await expect(
        saveLocalToAccount({
          trackId: localTrackId(pair.entry),
          scope: receipts.capture,
          assertScope: () => {},
          store: {
            snapshot: async () => ({
              guest,
              account: emptyPartition(receipts.capture.firebaseUid),
            }),
          },
          pair: async () => pair,
          outbox: { stage },
        }),
      ).rejects.toThrow("OUTBOX_PROFILE_UNSUPPORTED");
      expect(stage).not.toHaveBeenCalled();
      expect(player.view()).toEqual(before);
      expect(f.release).not.toHaveBeenCalled();
      expect(await readFile(f.source)).toEqual(f.data);
      expect(pair.timeline?.trimEnabled).toBe(true);
      expect(pair.reuse).toBeUndefined();
    } finally {
      await player.dispose();
    }
  });
  it.each([false, true])(
    "exports exact standalone trimmed bytes with accountOwned=%s and no reuse/comparison receipt",
    async (accountOwned) => {
      const f = await fixture(accountOwned);
      expect(f.artifact.comparisonRanges).toBeUndefined();
      expect(await exportLibraryTrack(f.options)).toBe(true);
      expect(await readFile(f.target)).toEqual(f.data);
      expect(await readFile(f.source)).toEqual(f.data);
      expect(f.commit).toHaveBeenCalledOnce();
      expect(f.discard).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it("cancelled destination selection releases the pin without creating or deleting media", async () => {
    const f = await fixture();
    const destination = { choose: vi.fn(async () => null) };
    expect(await exportLibraryTrack({ ...f.options, destination })).toBe(false);
    expect(await readFile(f.source)).toEqual(f.data);
    expect(await readFile(f.unrelated, "utf8")).toBe(
      "existing unrelated bytes",
    );
    await expect(readFile(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["ENOSPC", "EIO"] as const)(
    "removes only its new partial destination after a rejected %s write",
    async (code) => {
      const f = await fixture(),
        choose = f.destination.choose;
      choose.mockImplementationOnce(async () => {
        const file = await open(f.target, "wx", 0o600),
          write = file.writeFile.bind(file);
        vi.spyOn(file, "writeFile").mockImplementationOnce(async (bytes) => {
          await write(Buffer.from(bytes as Uint8Array).subarray(0, 17));
          throw Object.assign(new Error("fixture destination write rejected"), {
            code,
          });
        });
        return {
          file,
          commit: async () => {
            f.commit();
            await file.close();
          },
          discard: async () => {
            f.discard();
            await file.close();
            await unlink(f.target);
          },
        };
      });
      await expect(exportLibraryTrack(f.options)).rejects.toMatchObject({
        code,
      });
      await expect(readFile(f.target)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(f.source)).toEqual(f.data);
      expect(await readFile(f.unrelated, "utf8")).toBe(
        "existing unrelated bytes",
      );
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.discard).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it.each(["cancel", "account-change", "source-replacement"] as const)(
    "holds the pin through actual partial copying and refuses %s before commit",
    async (fault) => {
      const f = await fixture(fault === "account-change"),
        entered = deferred(),
        proceed = deferred();
      releases.push(proceed.resolve);
      f.destination.choose.mockImplementationOnce(async () => {
        const file = await open(f.target, "wx", 0o600),
          write = file.writeFile.bind(file);
        vi.spyOn(file, "writeFile").mockImplementationOnce(async (...args) => {
          await write(...args);
          entered.resolve();
          await proceed.promise;
        });
        return {
          file,
          commit: async () => {
            f.commit();
            await file.close();
          },
          discard: async () => {
            f.discard();
            await file.close();
            await unlink(f.target);
          },
        };
      });
      const exporting = exportLibraryTrack(f.options),
        rejected = expect(exporting).rejects.toBeDefined();
      await entered.promise;
      expect(f.release).not.toHaveBeenCalled();
      expect((await readFile(f.target)).length).toBe(1024 ** 2);
      if (fault === "cancel") f.abort.abort();
      else if (fault === "account-change") f.retire();
      else {
        await rename(f.source, `${f.source}.previous`);
        await writeFile(f.source, "replacement belongs to another writer");
      }
      proceed.resolve();
      await rejected;
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.discard).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
      await expect(readFile(f.target)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(f.unrelated, "utf8")).toBe(
        "existing unrelated bytes",
      );
      if (fault === "source-replacement")
        expect(await readFile(f.source, "utf8")).toBe(
          "replacement belongs to another writer",
        );
      else expect(await readFile(f.source)).toEqual(f.data);
    },
  );
});
