import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import { expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import { LibraryPlaybackSources } from "../src/main/player/library-sources.js";
import type { VerifiedPlaybackFile } from "../src/main/player/media-server.js";
import type { LibraryPlaybackArtifact } from "../src/main/library/playback.js";
import type { WindowsSilenceRunner } from "../src/main/player/silence-runner.js";
function fixture(
  onPlaybackStarted?: ConstructorParameters<
    typeof LibraryPlaybackSources
  >[0]["onPlaybackStarted"],
) {
  const events: string[] = [],
    bytes = Buffer.from("verified voice"),
    digest = createHash("sha256").update(bytes).digest("hex");
  const artifact: LibraryPlaybackArtifact = {
    relativePath: `personal\\results\\${randomUUID()}\\vocals.mp3`,
    path: "",
    artifactId: randomUUID(),
    bytes: bytes.length,
    sha256: digest,
    mime: "audio/mpeg",
    originalDuration: 10,
    voiceDuration: 10,
    sourceDuration: 10,
    trimEnabled: false,
    accountOwned: false,
    title: "Voice",
    thumbnailUrl: null,
    current: vi.fn(async () => {}),
  };
  artifact.path = win32.join("C:\\fixture", artifact.relativePath);
  let fingerprint = {
    device: "1",
    fileId: "2",
    bytes: bytes.length,
    writtenAt: "3",
    changedAt: "4",
  };
  const close = vi.fn(async () => {
    events.push("close-file");
  });
  const file = {
    stat: async () => ({
      isFile: () => true,
      nlink: 1n,
      ino: 2n,
      dev: 1n,
      size: BigInt(bytes.length),
      mtimeNs: 3n,
      ctimeNs: 4n,
    }),
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => ({
      bytesRead: bytes.copy(buffer, offset, position, position + length),
      buffer,
    }),
    close,
  } as unknown as FileHandle;
  const pin = {
    artifactId: artifact.artifactId,
    relativePath: artifact.relativePath,
    sha256: digest,
    release: vi.fn(async () => {
      events.push("unpin");
    }),
  };
  const library = {
    pin: vi.fn(async () => {
      events.push("pin");
      return pin;
    }),
    resolvePlayback: vi.fn(async () => {
      events.push("resolve");
      return artifact;
    }),
  };
  let issued: VerifiedPlaybackFile | undefined;
  const server = {
    issue: vi.fn(async (_owner: string, verified: VerifiedPlaybackFile) => {
      events.push("issue");
      issued = verified;
      return {
        url: `http://127.0.0.1:12345/media/${randomUUID()}?capability=${"a".repeat(43)}`,
        release: async () => verified.release(),
      };
    }),
  };
  const silence = {
    run: vi.fn<WindowsSilenceRunner["run"]>(async () => [{ start: 2, end: 5 }]),
  };
  const retained = new Set<() => Promise<void>>();
  const sources = new LibraryPlaybackSources({
    host: { personalRoot: "C:\\fixture" } as HostContext,
    library,
    server,
    scope: () => null,
    silence,
    onReleasePending: (retry) => {
      retained.add(retry);
    },
    openFile: async () => {
      events.push("open");
      return file;
    },
    fingerprint: async () => ({ ...fingerprint }),
    ...(onPlaybackStarted ? { onPlaybackStarted } : {}),
  });
  return {
    sources,
    artifact,
    pin,
    library,
    server,
    events,
    close,
    silence,
    retained,
    issued: () => issued,
    changeFingerprint: () => {
      fingerprint = { ...fingerprint, fileId: "other" };
    },
  };
}
it("retains unissued failure cleanup as one stable descriptor/pin callback without selecting new media", async () => {
  const f = fixture();
  f.server.issue.mockRejectedValueOnce(new Error("ISSUE_FAILED"));
  f.pin.release.mockRejectedValueOnce(new Error("PIN_RELEASE_UNKNOWN"));
  await expect(
    f.sources.open("local:one", "voice", new AbortController().signal),
  ).rejects.toThrow("PIN_RELEASE_UNKNOWN");
  expect(f.retained.size).toBe(1);
  const retry = [...f.retained][0]!;
  await retry();
  await retry();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.pin.release).toHaveBeenCalledTimes(2);
  expect(f.library.pin).toHaveBeenCalledOnce();
});
it("does not unpin an unconfirmed descriptor close and retries the exact old handle", async () => {
  const f = fixture(),
    source = await f.sources.open(
      "local:one",
      "voice",
      new AbortController().signal,
    );
  f.close.mockRejectedValueOnce(new Error("FILE_CLOSE_UNKNOWN"));
  await expect(source.release()).rejects.toThrow("FILE_CLOSE_UNKNOWN");
  expect(f.pin.release).not.toHaveBeenCalled();
  await expect(f.issued()!.current()).rejects.toThrow("MEDIA_UNAVAILABLE");
  await source.release();
  expect(f.close).toHaveBeenCalledTimes(2);
  expect(f.pin.release).toHaveBeenCalledOnce();
  expect(f.library.pin).toHaveBeenCalledOnce();
});
it("retries an unconfirmed pin write after descriptor close without closing or selecting a replacement", async () => {
  const f = fixture(),
    source = await f.sources.open(
      "local:one",
      "voice",
      new AbortController().signal,
    );
  f.pin.release.mockRejectedValueOnce(new Error("PIN_WRITE_UNKNOWN"));
  await expect(source.release()).rejects.toThrow("PIN_WRITE_UNKNOWN");
  await source.release();
  await source.release();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.pin.release).toHaveBeenCalledTimes(2);
  expect(f.library.pin).toHaveBeenCalledOnce();
});
it("pins the exact artifact before resolving, verifies its descriptor and grants only an opaque URL", async () => {
  const f = fixture(),
    source = await f.sources.open(
      "local:one",
      "voice",
      new AbortController().signal,
    );
  expect(f.events).toEqual(["pin", "resolve", "open", "issue"]);
  expect(source.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(source.url).not.toContain("fixture");
  await f.issued()!.current();
  await source.release();
  expect(f.events.slice(-2)).toEqual(["close-file", "unpin"]);
});
it("keeps the verified descriptor pinned through a one-use playback acknowledgement and concurrent release", async () => {
  let complete!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
      complete = resolve;
    }),
    callback = vi.fn(
      async (
        input: Parameters<
          NonNullable<
            ConstructorParameters<
              typeof LibraryPlaybackSources
            >[0]["onPlaybackStarted"]
          >
        >[0],
      ) => {
        await input.assertCurrent();
        await acknowledgement;
      },
    ),
    f = fixture(callback),
    source = await f.sources.open(
      "local:one",
      "voice",
      new AbortController().signal,
    );
  expect(callback).not.toHaveBeenCalled();
  const started = source.playbackStarted!(),
    releasing = source.release();
  await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  expect(f.close).not.toHaveBeenCalled();
  expect(f.pin.release).not.toHaveBeenCalled();
  complete();
  await started;
  await releasing;
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.pin.release).toHaveBeenCalledOnce();
  await source.playbackStarted!();
  expect(callback).toHaveBeenCalledOnce();
});
it("rejects a track remap whose artifact is not covered by its pin receipt", async () => {
  const f = fixture();
  f.artifact.artifactId = randomUUID();
  await expect(
    f.sources.open("local:one", "voice", new AbortController().signal),
  ).rejects.toThrow("MEDIA_UNAVAILABLE");
  expect(f.events).toEqual(["pin", "resolve", "unpin"]);
  expect(f.server.issue).not.toHaveBeenCalled();
});
it("rejects corrupt bytes and private path replacement without issuing media", async () => {
  const f = fixture();
  f.artifact.sha256 = "f".repeat(64);
  f.pin.sha256 = f.artifact.sha256;
  await expect(
    f.sources.open("local:one", "voice", new AbortController().signal),
  ).rejects.toThrow("MEDIA_UNAVAILABLE");
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.pin.release).toHaveBeenCalledOnce();
  expect(f.server.issue).not.toHaveBeenCalled();
  const good = fixture(),
    source = await good.sources.open(
      "one",
      "voice",
      new AbortController().signal,
    );
  good.changeFingerprint();
  await expect(good.issued()!.current()).rejects.toThrow("MEDIA_UNAVAILABLE");
  await source.release();
});
it("withholds a grant if the captured account no longer owns the artifact", async () => {
  const f = fixture();
  f.artifact.current = vi.fn(async () => {
    throw new Error("ACCOUNT_CHANGED");
  });
  await expect(
    f.sources.open("account:one", "voice", new AbortController().signal),
  ).rejects.toThrow("ACCOUNT_CHANGED");
  expect(f.server.issue).not.toHaveBeenCalled();
  expect(f.pin.release).toHaveBeenCalledOnce();
});
it("keeps the descriptor pinned until cancelled analysis confirms its owned cleanup", async () => {
  const f = fixture();
  let aborted = false,
    finish!: () => void;
  f.silence.run = vi.fn<WindowsSilenceRunner["run"]>(
    (_file, _sha, _duration, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            finish = () => reject(new Error("CANCELLED"));
          },
          { once: true },
        );
      }),
  );
  const source = await f.sources.open(
      "one",
      "voice",
      new AbortController().signal,
    ),
    analysis = source.analyzeSilence!(new AbortController().signal);
  void analysis.catch(() => {});
  const release = source.release();
  await vi.waitFor(() => expect(aborted).toBe(true));
  expect(f.close).not.toHaveBeenCalled();
  expect(f.pin.release).not.toHaveBeenCalled();
  finish();
  await release;
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.pin.release).toHaveBeenCalledOnce();
  await expect(
    source.analyzeSilence!(new AbortController().signal),
  ).rejects.toThrow("SILENCE_UNAVAILABLE");
});
