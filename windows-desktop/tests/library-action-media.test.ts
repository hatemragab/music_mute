import { describe, expect, it, vi } from "vitest";
import { restoreLibraryActionMedia } from "../src/main/library/action-media.js";
import { LibraryController } from "../src/main/library/controller.js";
import { LibraryPlaybackProvider } from "../src/main/library/provider.js";
import { LibraryStore } from "../src/main/library/store.js";
import { accountLibraryJob, localTrackId } from "../src/main/library/model.js";
import type { HostContext } from "../src/main/host-context.js";
import type { LibraryPins } from "../src/main/library/pins.js";
import type {
  CachedAccountArtifact,
  LibraryArtifactCache,
  TrustedLibraryArtifact,
} from "../src/main/library/artifacts.js";
import type { SessionAccountScope } from "../src/shared/session-contracts.js";
import {
  libraryOwnerA,
  libraryOwnerB,
  libraryPersonal,
  libraryJob,
  MemoryLibraryDisk,
} from "./library-fixtures.js";

async function fixture() {
  let scope: SessionAccountScope | null = null,
    ownerCurrent = true,
    localFailure = "ENOENT";
  const personal = libraryPersonal(),
    raw = libraryJob(),
    disk = new MemoryLibraryDisk(),
    current = (candidate: SessionAccountScope | null) =>
      candidate === null ||
      (candidate.firebaseUid === scope?.firebaseUid &&
        candidate.generation === scope?.generation),
    store = new LibraryStore(disk, current),
    cached = new Map<string, CachedAccountArtifact>(),
    artifact = (variant: "voice" | "original"): TrustedLibraryArtifact => {
      const selected =
        variant === "voice" ? personal.vocals! : personal.original!;
      return {
        relativePath: `personal\\results\\${personal.id}\\${selected.name}`,
        artifactId: selected.id,
        bytes: selected.bytes,
        sha256: selected.sha256,
        mime: selected.contentType,
        durationSeconds: selected.durationSeconds,
      };
    },
    cache = {
      local: vi.fn(async (_id, _selected, variant: "voice" | "original") => {
        if (variant === "original")
          throw Object.assign(new Error(localFailure), { code: localFailure });
        return artifact(variant);
      }),
      lookup: vi.fn(async (job, _scope, signal, variant = "voice") => {
        signal.throwIfAborted();
        if (
          !(variant === "voice"
            ? job.can_download_output
            : job.can_download_input)
        )
          throw new Error("LIBRARY_RESULT_UNAVAILABLE");
        return cached.get(variant) ?? null;
      }),
      download: vi.fn(
        async (_job, _grant, captured, signal, variant = "voice") => {
          signal.throwIfAborted();
          if (!current(captured)) throw new Error("ACCOUNT_CHANGED");
          const selected = artifact(variant);
          const result: CachedAccountArtifact = {
            ...selected,
            version: 1,
            ownerUid: captured.firebaseUid,
            jobId: raw.id,
            relativePath: `library\\media\\owner\\${raw.id}\\${variant}\\audio`,
            contentType: selected.mime,
            variant,
            createdAt: 1,
          };
          cached.set(variant, result);
          return result;
        },
      ),
      adopt: vi.fn(async () => {
        throw new Error("UNEXPECTED_ADOPTION");
      }),
    } satisfies Pick<
      LibraryArtifactCache,
      "local" | "lookup" | "download" | "adopt"
    >,
    request = vi.fn(
      async (
        _captured: SessionAccountScope,
        _path: string,
        _method: "POST" | "PATCH" | "DELETE",
        _body: unknown,
        signal: AbortSignal,
      ) => {
        signal.throwIfAborted();
        return {
          url: "https://fixture.r2.cloudflarestorage.com/input?signature=test",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        };
      },
    ),
    controller = new LibraryController({
      store,
      cache,
      scope: () => scope,
      realtime: { watch: () => () => {} },
      request,
      removeCache: async () => {},
      deleteLocal: async () => {},
    }),
    release = vi.fn(async () => {}),
    pins = {
      pin: vi.fn(async (selected: TrustedLibraryArtifact) => ({
        artifactId: selected.artifactId,
        relativePath: selected.relativePath,
        sha256: selected.sha256,
        release,
      })),
    },
    provider = new LibraryPlaybackProvider(
      {
        personalRoot: "C:\\Fixture\\MusicMuteLocal",
        native: { validatePath: async () => {} },
      } as unknown as HostContext,
      store,
      cache as unknown as LibraryArtifactCache,
      pins as unknown as LibraryPins,
      current,
    );
  await store.rememberPersonal(personal, null);
  const entry = (await store.snapshot(null)).guest.entries[0]!,
    id = localTrackId(entry);
  scope = libraryOwnerA;
  await controller.setScope(scope);
  await store.saveAccountJobs(scope, [accountLibraryJob(raw)]);
  await store.linkPersonal(id, scope, raw.id, entry.vocals.sha256);
  await controller.refreshLocal();
  const abort = new AbortController(),
    options = {
      controller,
      playback: provider,
      trackId: id,
      variant: "original" as const,
      scope: libraryOwnerA,
      signal: abort.signal,
      assertCurrent: () => {
        if (
          !ownerCurrent ||
          scope?.firebaseUid !== libraryOwnerA.firebaseUid ||
          scope.generation !== libraryOwnerA.generation
        )
          throw new Error("ACCOUNT_CHANGED");
      },
    };
  return {
    options,
    controller,
    provider,
    request,
    cache,
    release,
    id,
    raw,
    store,
    abort,
    cached,
    changeScope: (next: SessionAccountScope) => {
      scope = next;
    },
    replaceWindow: () => {
      ownerCurrent = false;
    },
    corruptLocal: () => {
      localFailure = "EACCES";
    },
  };
}

describe("Library export/share restored media receiving", () => {
  it.each(["Export", "Share"])(
    "restores the exact linked original before %s pins it",
    async () => {
      const f = await fixture();
      expect(
        f.controller.view().tracks.find((t) => t.id === f.id)
          ?.originalAvailable,
      ).toBe(true);
      await restoreLibraryActionMedia(f.options);
      const pin = await f.provider.pin(f.id, "original", libraryOwnerA);
      expect(pin.sha256).toBe("a".repeat(64));
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        libraryOwnerA,
        `/jobs/${f.raw.id}/download-grants`,
        "POST",
        { variant: "input" },
        expect.any(AbortSignal),
      );
      expect(f.cache.download).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        libraryOwnerA,
        expect.any(AbortSignal),
        "original",
      );
      await pin.release();
      expect(f.release).toHaveBeenCalledOnce();
      f.controller.dispose();
    },
  );
  it("does not request a grant for an already valid selected voice", async () => {
    const f = await fixture();
    await restoreLibraryActionMedia({ ...f.options, variant: "voice" });
    expect(f.request).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("does not conceal a local permission failure with account restoration", async () => {
    const f = await fixture();
    f.corruptLocal();
    await expect(restoreLibraryActionMedia(f.options)).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(f.request).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("refuses captured generation drift before a grant even when the Firebase user is unchanged", async () => {
    const f = await fixture();
    await expect(
      f.controller.download(f.id, "original", {
        scope: { ...libraryOwnerA, generation: libraryOwnerB.generation },
        signal: f.abort.signal,
      }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect(f.request).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("fences a grant response after an account transition before caching or native delivery", async () => {
    const f = await fixture();
    f.request.mockImplementationOnce(async () => {
      f.changeScope(libraryOwnerB);
      return {
        url: "https://fixture.r2.cloudflarestorage.com/input?signature=test",
        expires_at: new Date(Date.now() + 60000).toISOString(),
      };
    });
    await expect(restoreLibraryActionMedia(f.options)).rejects.toThrow(
      "ACCOUNT_CHANGED",
    );
    expect(f.cache.download).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("propagates window cancellation to the actual grant and cache transfer signal", async () => {
    const f = await fixture();
    f.request.mockImplementationOnce(
      async (_scope, _path, _method, _body, signal) => {
        f.abort.abort();
        expect(signal.aborted).toBe(true);
        signal.throwIfAborted();
        throw new Error("UNREACHABLE");
      },
    );
    await expect(restoreLibraryActionMedia(f.options)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(f.cache.download).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("does not treat a completed download promise as proof when the selected cache is still absent", async () => {
    const f = await fixture();
    f.cache.download.mockImplementationOnce(
      async () => ({}) as CachedAccountArtifact,
    );
    await expect(restoreLibraryActionMedia(f.options)).rejects.toThrow(
      "LIBRARY_DOWNLOAD_REQUIRED",
    );
    f.controller.dispose();
  });
  it("refuses a stale window after a valid local preflight without starting a grant", async () => {
    const f = await fixture(),
      original = f.cache.local.getMockImplementation()!;
    f.cache.local.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      f.replaceWindow();
      return result;
    });
    await expect(
      restoreLibraryActionMedia({ ...f.options, variant: "voice" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect(f.request).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("does not restore an input whose current remote permission was removed", async () => {
    const f = await fixture();
    await f.store.saveAccountJobs(libraryOwnerA, [
      accountLibraryJob({ ...f.raw, can_download_input: false }),
    ]);
    await expect(restoreLibraryActionMedia(f.options)).rejects.toThrow(
      "LIBRARY_RESULT_UNAVAILABLE",
    );
    expect(f.request).not.toHaveBeenCalled();
    f.controller.dispose();
  });
});
