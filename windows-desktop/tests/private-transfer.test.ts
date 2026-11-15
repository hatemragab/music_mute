import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});
vi.mock("../../chrome-extension/src/shared/local-model.js", async () => {
  const { createHash } = await import("node:crypto"),
    bytes = Buffer.from("synthetic-model-fixture");
  return {
    MODEL: Object.freeze({
      filename: "Kim_Vocal_2.onnx",
      url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  };
});
import type { HostContext } from "../src/main/host-context.js";
import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import {
  downloadPrivatePreparationArtifact,
  PREPARATION_TRANSFER_KEYS,
  removePreparationArchive,
} from "../src/main/prepare/private-transfer.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const bytes = Buffer.from("synthetic-runtime-fixture"),
  sha = (value: Buffer) => createHash("sha256").update(value).digest("hex"),
  target = "a".repeat(64);
async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-private-transfer-code-"),
  );
  roots.push(root);
  const vault = new Map<string, Buffer>(),
    native = {
      openPrivateFile: vi.fn(
        privateFileNativeFixture((relative) =>
          join(root, relative.replaceAll("\\", "/")),
        ).openPrivateFile,
      ),
      validatePath: vi.fn(
        async (_namespace: string, relative: string, kind: string) => {
          const path = join(root, relative.replaceAll("\\", "/"));
          try {
            const stat = await lstat(path);
            if (
              kind === "absent" ||
              stat.isSymbolicLink() ||
              (kind === "file" && (!stat.isFile() || stat.nlink !== 1))
            )
              throw new Error("PATH_UNSAFE");
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code === "ENOENT" &&
              kind === "absent"
            )
              return;
            throw error;
          }
        },
      ),
      vaultRead: vi.fn(
        async (_namespace: string, key: string) => vault.get(key) ?? null,
      ),
      vaultWrite: vi.fn(
        async (_namespace: string, key: string, value: Uint8Array) => {
          vault.set(key, Buffer.from(value));
        },
      ),
      vaultDelete: vi.fn(async (_namespace: string, key: string) => {
        vault.delete(key);
      }),
    };
  const host = {
    personalRoot: root,
    native,
    directory: async (relative: string) => {
      const path = join(root, relative.replaceAll("\\", "/"));
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    },
  } as unknown as HostContext;
  const options = {
    host,
    kind: "runtime" as const,
    target,
    pin: {
      url: "https://downloads.music-mute.com/releases/test-only-fixture/runtime.zip",
      bytes: bytes.length,
      sha256: sha(bytes),
    },
    destination: `prepare\\downloads\\runtime-${target}.zip`,
    signal: new AbortController().signal,
  };
  return { root, host, native, vault, options };
}
it("publishes only exact verified runtime bytes and reuses final private cache offline", async () => {
  const f = await fixture(),
    fetcher = vi.fn(async () => new Response(bytes));
  const path = await downloadPrivatePreparationArtifact({
    ...f.options,
    fetch: fetcher as typeof fetch,
  });
  expect(await readFile(path)).toEqual(bytes);
  expect(f.vault.size).toBe(0);
  await expect(
    readFile(join(f.root, "prepare", "downloads", "runtime.part")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await downloadPrivatePreparationArtifact({
    ...f.options,
    allowNetwork: false,
    fetch: fetcher as typeof fetch,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await removePreparationArchive(f.host, target);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("a complete exact pinned pre-rename partial may publish offline; an incomplete prefix retains bytes and never fetches", async () => {
  const f = await fixture();
  await f.host.directory("prepare\\downloads");
  const partial = join(f.root, "prepare", "downloads", "runtime.part");
  const fetcher = vi.fn(async () => {
    throw new Error("offline must not fetch");
  });
  await writeFile(partial, bytes.subarray(0, 7));
  await expect(
    downloadPrivatePreparationArtifact({
      ...f.options,
      allowNetwork: false,
      fetch: fetcher as typeof fetch,
    }),
  ).rejects.toThrow("NETWORK_UNAVAILABLE");
  expect(await readFile(partial)).toEqual(bytes.subarray(0, 7));
  await writeFile(partial, bytes);
  const published = await downloadPrivatePreparationArtifact({
    ...f.options,
    allowNetwork: false,
    fetch: fetcher as typeof fetch,
  });
  expect(await readFile(published)).toEqual(bytes);
  expect(fetcher).not.toHaveBeenCalled();
});
it("resumes a protected DPAPI checkpoint after interruption without persisting redirect URLs", async () => {
  const f = await fixture();
  let pulls = 0;
  const first = new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ === 0) c.enqueue(bytes.subarray(0, 7));
        else c.error(new Error("fixture connection lost"));
      },
    }),
    { headers: { ETag: '"stable"' } },
  );
  await expect(
    downloadPrivatePreparationArtifact({
      ...f.options,
      fetch: (async () => first) as typeof fetch,
    }),
  ).rejects.toThrow("NETWORK_UNAVAILABLE");
  expect(f.vault.has(PREPARATION_TRANSFER_KEYS.runtime)).toBe(true);
  const saved = JSON.parse(
    f.vault.get(PREPARATION_TRANSFER_KEYS.runtime)!.toString(),
  );
  expect(saved.bytes).toBe(7);
  expect(JSON.stringify(saved)).not.toContain("https:");
  const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
    expect(init.headers).toMatchObject({
      Range: "bytes=7-",
      "If-Range": '"stable"',
    });
    return new Response(bytes.subarray(7), {
      status: 206,
      headers: {
        ETag: '"stable"',
        "Content-Range": `bytes 7-${bytes.length - 1}/${bytes.length}`,
      },
    });
  });
  const path = await downloadPrivatePreparationArtifact({
    ...f.options,
    fetch: fetcher as typeof fetch,
  });
  expect(await readFile(path)).toEqual(bytes);
  expect(f.vault.size).toBe(0);
});
it("corrupt transfer-cache final is replaced safely instead of poisoning every Retry", async () => {
  const f = await fixture();
  await f.host.directory("prepare\\downloads");
  const path = join(f.root, "prepare", "downloads", `runtime-${target}.zip`);
  await writeFile(path, Buffer.alloc(bytes.length, 0));
  await downloadPrivatePreparationArtifact({
    ...f.options,
    fetch: (async () => new Response(bytes)) as typeof fetch,
  });
  expect(await readFile(path)).toEqual(bytes);
});
it("bad full digest clears only its exact owned partial and never publishes", async () => {
  const f = await fixture();
  await expect(
    downloadPrivatePreparationArtifact({
      ...f.options,
      fetch: (async () =>
        new Response(Buffer.alloc(bytes.length, 0))) as typeof fetch,
    }),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(
    (await readFile(join(f.root, "prepare", "downloads", "runtime.part")))
      .length,
  ).toBe(0);
  await expect(
    readFile(join(f.root, "prepare", "downloads", `runtime-${target}.zip`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.vault.size).toBe(0);
});
it("expiry forbids a new runtime network attempt and arbitrary output paths", async () => {
  const f = await fixture(),
    fetcher = vi.fn();
  await expect(
    downloadPrivatePreparationArtifact({
      ...f.options,
      allowNetwork: false,
      fetch: fetcher,
    }),
  ).rejects.toThrow("INTEGRITY_INVALID");
  await expect(
    downloadPrivatePreparationArtifact({
      ...f.options,
      destination: "personal\\results\\unrelated.mp3",
      fetch: fetcher,
    }),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(fetcher).not.toHaveBeenCalled();
});
it("model transfer enforces the exact shared pin and upstream source, with synthetic module pin only", async () => {
  const f = await fixture(),
    modelBytes = Buffer.from("synthetic-model-fixture"),
    fetcher = vi.fn(async () => new Response(modelBytes));
  const model = {
    ...f.options,
    kind: "model" as const,
    pin: MODEL,
    destination: `models\\${MODEL.filename}.verified`,
  };
  const path = await downloadPrivatePreparationArtifact({
    ...model,
    fetch: fetcher as typeof fetch,
  });
  expect(await readFile(path)).toEqual(modelBytes);
  await expect(
    downloadPrivatePreparationArtifact({
      ...model,
      pin: { ...MODEL, bytes: MODEL.bytes + 1 },
      fetch: fetcher as typeof fetch,
    }),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
