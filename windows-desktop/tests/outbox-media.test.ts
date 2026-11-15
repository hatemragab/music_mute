import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  lstat,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type {
  LibraryArtifactCache,
  TrustedLibraryArtifact,
} from "../src/main/library/artifacts.js";
import type { LibraryPins } from "../src/main/library/pins.js";
import { ownerA } from "./realtime-fixtures.js";
import { localEntry, outboxInstallation } from "./outbox-fixtures.js";
const harness = vi.hoisted(() => ({
  root: "",
  base: "C:\\fixture",
  failWrite: false,
}));
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const local = (path: unknown) =>
    typeof path === "string" && path.startsWith(harness.base)
      ? join(
          harness.root,
          ...path.slice(harness.base.length).split("\\").filter(Boolean),
        )
      : path;
  return {
    ...actual,
    lstat: (path: unknown, ...args: unknown[]) =>
      Reflect.apply(actual.lstat, undefined, [local(path), ...args]),
    open: async (path: unknown, ...args: unknown[]) => {
      const file = await Reflect.apply(actual.open, undefined, [
        local(path),
        ...args,
      ]);
      if (harness.failWrite && String(path).includes("outbox")) {
        file.write = async () => {
          throw new Error("COPY_WRITE_FAILED");
        };
      }
      return file;
    },
    rename: (a: unknown, b: unknown) =>
      Reflect.apply(actual.rename, undefined, [local(a), local(b)]),
    unlink: (path: unknown) =>
      Reflect.apply(actual.unlink, undefined, [local(path)]),
    statfs: (path: unknown, ...args: unknown[]) =>
      Reflect.apply(actual.statfs, undefined, [local(path), ...args]),
  };
});
import { hashPrivateFile } from "../src/main/prepare/private-files.js";
import { WindowsOutboxMedia } from "../src/main/outbox/media.js";
import { WindowsPublicationMedia } from "../src/main/reuse/publication.js";
import { parsePersonalPair } from "../src/main/reuse/pair.js";
import type { PrivateReadable } from "../../worker/src/platform/windows/consumer-private-file.js";
import { parseOutboxRecord } from "../src/main/outbox/model.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { FULL_TIMELINE_RECIPE_DIGEST } from "../../chrome-extension/src/companion/cloud-provider.js";
import { createReuseReceipt } from "../src/main/reuse/receipts.js";
import { LibraryPins as ActualLibraryPins } from "../src/main/library/pins.js";
import { WindowsStorageController } from "../src/main/storage/controller.js";
import { storageBirth } from "../src/main/storage/write-journal.js";
import { storagePartialNativeFixture } from "./storage-partial-native-fixture.js";
const hash = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex"),
  local = (relative: string) => join(harness.root, ...relative.split("\\"));
function uploadGrant(artifact: { contentType: string; sha256: string }) {
  const checksum = Buffer.from(artifact.sha256, "hex").toString("base64");
  return {
    method: "PUT" as const,
    url: "https://fixture.r2.cloudflarestorage.com/private?signature=fixture",
    expires_at: new Date(Date.now() + 60000).toISOString(),
    headers: {
      "Content-Type": artifact.contentType,
      "If-None-Match": "*",
      "x-amz-checksum-sha256": checksum,
      "x-amz-meta-sha256": checksum,
    },
  };
}
beforeEach(async () => {
  harness.root = await mkdtemp(
    join(tmpdir(), "musicmute-outbox-media-fixture-"),
  );
  harness.failWrite = false;
});
afterEach(async () => {
  await rm(harness.root, { recursive: true, force: true });
});
async function fixture(extension = "m4a") {
  const entry = localEntry(),
    original = Buffer.from("synthetic original fixture"),
    vocals = Buffer.from("synthetic voice fixture"),
    originalPath = `personal\\results\\${entry.personalJobId}\\original.${extension}`,
    vocalsPath = `personal\\results\\${entry.personalJobId}\\vocals.mp3`;
  entry.original.bytes = original.length;
  entry.original.sha256 = hash(original);
  entry.vocals.bytes = vocals.length;
  entry.vocals.sha256 = hash(vocals);
  await mkdir(local(`personal\\results\\${entry.personalJobId}`), {
    recursive: true,
  });
  await writeFile(local(originalPath), original);
  await writeFile(local(vocalsPath), vocals);
  await writeFile(
    local(`personal\\results\\${entry.personalJobId}\\pair.json`),
    JSON.stringify({
      version: 1,
      jobId: entry.personalJobId,
      original: { ...entry.original, filename: `original.${extension}` },
      vocals: { ...entry.vocals, filename: "vocals.mp3" },
      reuseReceipt: createReuseReceipt(
        {
          modelDigest: MODEL.sha256,
          recipeDigest: FULL_TIMELINE_RECIPE_DIGEST,
          recipeId: "kim-vocals-v2",
          recipeRevision: 6,
          trimEnabled: false,
          denoiseEnabled: false,
        },
        { bytes: original.length, sha256: hash(original) },
        entry.original.sha256,
        entry.vocals.sha256,
      ),
    }),
  );
  let creationTime = "1000";
  const locked = new Set<string>();
  const identity = {
      sid: "S-1-5-21-100-200-300-1001",
      sessionId: 1,
      pid: process.pid,
      creationTime,
    },
    processIdentity = async (pid: number) =>
      pid === process.pid ? { ...identity, creationTime } : null;
  const host = {
      personalRoot: harness.base,
      identity,
      report: { installationId: outboxInstallation },
      native: {
        ...privateFileNativeFixture(local),
        ...storagePartialNativeFixture({
          path: local,
          cacheHeld: () => locked.has("cache"),
          currentProcess: processIdentity,
        }),
        validatePath: vi.fn(async () => {}),
        acquireMutex: async (scope: string) => {
          if (locked.has(scope)) return null;
          locked.add(scope);
          return { scope, nonce: "fixture" };
        },
        releaseMutex: async (lease: { scope: string }) => {
          locked.delete(lease.scope);
        },
        processIdentity,
      },
      directory: vi.fn(async (relative: string) => {
        await mkdir(local(relative), { recursive: true });
        return `${harness.base}\\${relative}`;
      }),
    } as unknown as HostContext,
    cache = {
      local: vi.fn(
        async (
          _job: string,
          artifact: typeof entry.original,
          variant: string,
        ): Promise<TrustedLibraryArtifact> => ({
          relativePath: variant === "voice" ? vocalsPath : originalPath,
          artifactId: artifact.id,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          mime: artifact.contentType,
          durationSeconds: artifact.durationSeconds,
        }),
      ),
      verify: vi.fn(async (a: TrustedLibraryArtifact, signal: AbortSignal) => {
        if (
          (await hashPrivateFile(host, a.relativePath, a.bytes, signal)) !==
          a.sha256
        )
          throw new Error("LIBRARY_RESULT_INVALID");
      }),
    } as Pick<LibraryArtifactCache, "local" | "verify">,
    released: string[] = [],
    pins = {
      pin: vi.fn(async (a: TrustedLibraryArtifact) => ({
        ...a,
        release: async () => {
          released.push(a.relativePath);
        },
      })),
    } as unknown as Pick<LibraryPins, "pin">,
    actualPins = new ActualLibraryPins(host, processIdentity),
    storage = new WindowsStorageController({
      host,
      pins: actualPins,
      processIdentity,
      treeExited: async () => false,
      freeBytes: async () => 100 * 1024 ** 3,
    }),
    admission = {
      beginPartialWrite: (relative: string, bytes: number) =>
        storage.beginPartialWrite(relative, bytes),
      recoverPartialWrites: (canonical: string, signal: AbortSignal) =>
        storage.recoverPartialWrites(canonical, signal),
    },
    media = new WindowsOutboxMedia(host, cache, pins, undefined, admission),
    abort = new AbortController(),
    context = {
      signal: abort.signal,
      assertCurrent: () => abort.signal.throwIfAborted(),
    },
    record = await media.describe(
      entry,
      ownerA,
      outboxInstallation,
      "11111111-1111-4111-8111-111111111111",
      "pair",
      Date.now(),
      context,
    );
  return {
    entry,
    host,
    cache,
    pins,
    media,
    abort,
    context,
    record,
    released,
    original,
    vocals,
    storage,
    admission,
    setCreationTime: (value: string) => {
      creationTime = value;
    },
  };
}
describe("real filesystem outbox copy fixtures", () => {
  it.each(["outbox", "community"] as const)(
    "%s uploads consume native read ports at declared capacity and close them",
    async (route) => {
      const f = await fixture();
      if (route === "outbox") await f.media.retain(f.record, f.context);
      const pair = parsePersonalPair(
          JSON.parse(
            await readFile(
              local(`personal\\results\\${f.entry.personalJobId}\\pair.json`),
              "utf8",
            ),
          ),
          outboxInstallation,
          f.entry.personalJobId,
        ),
        original = f.host.native.openPrivateFile,
        readers: PrivateReadable[] = [],
        uploaded: Buffer[] = [],
        opener = vi.fn(
          async (
            relative: string,
            _mode: "read",
            maximum: number,
          ): Promise<PrivateReadable | null> => {
            const file = await original(relative, "read", maximum);
            if (file) {
              vi.spyOn(file, "close");
              readers.push(file);
            }
            return file;
          },
        ),
        fetcher = vi.fn<typeof fetch>(async (_url, init) => {
          uploaded.push(
            Buffer.from(await new Response(init!.body).arrayBuffer()),
          );
          return new Response(null, { status: 201 });
        });
      Object.assign(f.host.native, { openPrivateFile: opener });
      try {
        if (route === "outbox") {
          const media = new WindowsOutboxMedia(
            f.host,
            f.cache,
            f.pins,
            fetcher,
            f.admission,
          );
          await media.upload(
            f.record,
            f.record.vocals,
            uploadGrant(f.record.vocals),
            f.context,
          );
          expect(opener).toHaveBeenCalledWith(
            f.record.vocals.relativePath,
            "read",
            f.vocals.length,
          );
          expect(uploaded).toEqual([f.vocals]);
        } else {
          const media = new WindowsPublicationMedia(
            f.host,
            f.cache,
            f.pins,
            fetcher,
          );
          await media.transfer(
            pair,
            {
              original: uploadGrant(pair.entry.original),
              vocals: uploadGrant(pair.entry.vocals),
            },
            f.context.signal,
          );
          expect(opener).toHaveBeenCalledWith(
            `personal\\results\\${f.entry.personalJobId}\\original.m4a`,
            "read",
            f.original.length,
          );
          expect(opener).toHaveBeenCalledWith(
            `personal\\results\\${f.entry.personalJobId}\\vocals.mp3`,
            "read",
            f.vocals.length,
          );
          expect(uploaded).toEqual([f.original, f.vocals]);
        }
        expect(readers.length).toBe(route === "outbox" ? 1 : 2);
        for (const reader of readers)
          expect(reader.close).toHaveBeenCalledTimes(1);
        expect(
          await readFile(
            local(`personal\\results\\${f.entry.personalJobId}\\original.m4a`),
          ),
        ).toEqual(f.original);
      } finally {
        Object.assign(f.host.native, { openPrivateFile: original });
      }
    },
  );
  it.each([
    ["outbox", "denied"],
    ["outbox", "missing"],
    ["community", "denied"],
    ["community", "missing"],
  ] as const)(
    "%s native source %s prevents fetch without a pathname fallback",
    async (route, failure) => {
      const f = await fixture();
      if (route === "outbox") await f.media.retain(f.record, f.context);
      const pair = parsePersonalPair(
          JSON.parse(
            await readFile(
              local(`personal\\results\\${f.entry.personalJobId}\\pair.json`),
              "utf8",
            ),
          ),
          outboxInstallation,
          f.entry.personalJobId,
        ),
        original = f.host.native.openPrivateFile,
        fetcher = vi.fn<typeof fetch>(),
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
      try {
        const operation =
          route === "outbox"
            ? new WindowsOutboxMedia(
                f.host,
                f.cache,
                f.pins,
                fetcher,
                f.admission,
              ).upload(
                f.record,
                f.record.vocals,
                uploadGrant(f.record.vocals),
                f.context,
              )
            : new WindowsPublicationMedia(
                f.host,
                f.cache,
                f.pins,
                fetcher,
              ).transfer(
                pair,
                {
                  original: uploadGrant(pair.entry.original),
                  vocals: uploadGrant(pair.entry.vocals),
                },
                f.context.signal,
              );
        await expect(operation).rejects.toThrow(
          failure === "denied"
            ? "NATIVE_SOURCE_DENIED"
            : route === "outbox"
              ? "OUTBOX_ARTIFACT_INVALID"
              : "COMMUNITY_SOURCE_INVALID",
        );
        expect(fetcher).not.toHaveBeenCalled();
        expect(opener).toHaveBeenCalledTimes(route === "outbox" ? 1 : 2);
        expect(
          await readFile(
            local(`personal\\results\\${f.entry.personalJobId}\\original.m4a`),
          ),
        ).toEqual(f.original);
        expect(
          await readFile(
            local(`personal\\results\\${f.entry.personalJobId}\\vocals.mp3`),
          ),
        ).toEqual(f.vocals);
      } finally {
        Object.assign(f.host.native, { openPrivateFile: original });
      }
    },
  );
  it("keeps legacy pairs playable without inventing full-profile evidence for account saving", async () => {
    const f = await fixture();
    const path = local(
        `personal\\results\\${f.entry.personalJobId}\\pair.json`,
      ),
      raw = JSON.parse(await readFile(path, "utf8"));
    delete raw.reuseReceipt;
    await writeFile(path, JSON.stringify(raw));
    await expect(
      f.media.describe(
        f.entry,
        ownerA,
        outboxInstallation,
        "11111111-1111-4111-8111-111111111111",
        "pair",
        Date.now(),
        f.context,
      ),
    ).rejects.toThrow("OUTBOX_PROFILE_UNSUPPORTED");
  });
  it("copies and verifies both artifacts with temporary source pins and preserves source bytes after release", async () => {
    const f = await fixture();
    parseOutboxRecord(f.record, outboxInstallation);
    await f.media.retain(f.record, f.context);
    await f.media.verify(f.record, f.context);
    expect(await readFile(local(f.record.original!.relativePath))).toEqual(
      f.original,
    );
    expect(await readFile(local(f.record.vocals.relativePath))).toEqual(
      f.vocals,
    );
    expect(f.pins.pin).toHaveBeenCalledTimes(2);
    expect(f.released).toHaveLength(2);
    expect(await f.storage.writes.readOwned()).toEqual([]);
    await f.media.release(f.record);
    await expect(
      readFile(local(f.record.vocals.relativePath)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(local(f.record.original!.sourceRelativePath)),
    ).toEqual(f.original);
  });
  it("uses the verified pair filename when an audio MP4 source shares the M4A MIME type", async () => {
    const f = await fixture("mp4");
    expect(f.record.original!.extension).toBe("mp4");
    expect(() => parseOutboxRecord(f.record, outboxInstallation)).not.toThrow();
    await f.media.retain(f.record, f.context);
    expect(await readFile(local(f.record.original!.relativePath))).toEqual(
      f.original,
    );
  });
  it("can recover its retained copies without reopening an expired source", async () => {
    const f = await fixture();
    await f.media.retain(f.record, f.context);
    await rm(local(`personal\\results\\${f.entry.personalJobId}`), {
      recursive: true,
    });
    await f.media.retain(f.record, f.context);
    await f.media.verify(f.record, f.context);
    expect(f.pins.pin).toHaveBeenCalledTimes(2);
  });
  it("releases the source pin and removes only the partial copy when writing fails", async () => {
    const f = await fixture();
    harness.failWrite = true;
    await expect(f.media.retain(f.record, f.context)).rejects.toThrow(
      "COPY_WRITE_FAILED",
    );
    expect(f.released).toHaveLength(1);
    expect(await f.storage.writes.readOwned()).toEqual([]);
    expect(
      await readFile(local(f.record.original!.sourceRelativePath)),
    ).toEqual(f.original);
    await expect(
      readFile(local(f.record.original!.relativePath)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("a restarted copier reclaims only its exact prior partial before retry without accumulating another copy", async () => {
    const f = await fixture(),
      canonical = f.record.original!.relativePath,
      partial = `${canonical}.22222222-2222-4222-8222-222222222222.part`;
    await f.host.directory(canonical.slice(0, canonical.lastIndexOf("\\")));
    const write = await f.admission.beginPartialWrite(
      partial,
      f.original.length,
    );
    await writeFile(local(partial), Buffer.alloc(0));
    await write.captureCreated(
      storageBirth(await lstat(local(partial), { bigint: true })),
    );
    await writeFile(local(partial), f.original.subarray(0, 4));
    f.setCreationTime("2000"); // Injected current Node birth differs from the recorded interrupted writer.
    await f.media.retain(f.record, f.context);
    await expect(lstat(local(partial))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(local(canonical))).toEqual(f.original);
    expect(
      (
        await readdir(local(canonical.slice(0, canonical.lastIndexOf("\\"))))
      ).sort(),
    ).toEqual(["original.m4a", "vocals.mp3"]);
    expect(await f.storage.writes.readOwned()).toEqual([]);
  });
  it("an unbound crash partial blocks retry and preserves source/canonical authority rather than guessing ownership", async () => {
    const f = await fixture(),
      canonical = f.record.original!.relativePath,
      partial = `${canonical}.22222222-2222-4222-8222-222222222222.part`;
    await f.host.directory(canonical.slice(0, canonical.lastIndexOf("\\")));
    await f.admission.beginPartialWrite(partial, f.original.length);
    await writeFile(local(partial), "unbound");
    f.setCreationTime("2000");
    await expect(f.media.retain(f.record, f.context)).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
    expect(await readFile(local(partial), "utf8")).toBe("unbound");
    expect(
      await readFile(local(f.record.original!.sourceRelativePath)),
    ).toEqual(f.original);
    expect(f.pins.pin).not.toHaveBeenCalled();
  });
  it("rejects a changed retained artifact before any upload", async () => {
    const f = await fixture();
    await f.media.retain(f.record, f.context);
    await writeFile(
      local(f.record.vocals.relativePath),
      Buffer.alloc(f.vocals.length),
    );
    await expect(f.media.verify(f.record, f.context)).rejects.toThrow(
      "OUTBOX_ARTIFACT_INVALID",
    );
  });
  it("rejects an unbound pin receipt and releases it without copying", async () => {
    const f = await fixture();
    vi.mocked(f.pins.pin).mockResolvedValueOnce({
      artifactId: "wrong",
      relativePath: f.record.original!.sourceRelativePath,
      sha256: f.record.original!.sha256,
      release: vi.fn(async () => {}),
    });
    await expect(f.media.retain(f.record, f.context)).rejects.toThrow(
      "OUTBOX_PIN_INVALID",
    );
    await expect(
      readFile(local(f.record.original!.relativePath)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
