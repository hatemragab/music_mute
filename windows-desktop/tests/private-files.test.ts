import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import {
  newPrivateFile,
  privateFingerprint,
  readPrivateBytes,
  verifyPrivateFile,
} from "../src/main/prepare/private-files.js";
import { privateFileNativeFixture } from "./private-file-port-fixture.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-retained-private-code-"),
  );
  roots.push(root);
  const native = privateFileNativeFixture((relative) =>
    join(root, relative.replaceAll("\\", "/")),
  );
  const host = {
    personalRoot: root,
    native: {
      ...native,
      validatePath: vi.fn(async () => {
        throw new Error("legacy-path-validation-forbidden");
      }),
    },
    directory: async (relative: string) => {
      const path = join(root, relative.replaceAll("\\", "/"));
      await mkdir(path, { recursive: true });
      return path;
    },
  } as unknown as HostContext;
  return { root, host, native };
}
it("reads and hashes only the returned held token, preserving existing fingerprint fields", async () => {
  const f = await fixture(),
    bytes = Buffer.alloc(1024 * 1024 + 17, 61);
  await writeFile(join(f.root, "source.bin"), bytes);
  expect(await readPrivateBytes(f.host, "source.bin", bytes.length)).toEqual(
    bytes,
  );
  const proof = await verifyPrivateFile(
    f.host,
    "source.bin",
    bytes.length,
    new AbortController().signal,
  );
  expect(proof.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(Object.keys(proof.fingerprint)).toEqual([
    "device",
    "fileId",
    "bytes",
    "writtenAt",
    "changedAt",
  ]);
  expect(await privateFingerprint(f.host, "source.bin")).toEqual(
    proof.fingerprint,
  );
  expect(f.host.native.validatePath).not.toHaveBeenCalled();
});
it("uses token bytes despite a synthetic name swap and never falls back from a native failure", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "source.bin"), "held-original");
  const open = f.native.openPrivateFile;
  const opened = vi.fn(async () => {
    const file = await open("source.bin", "read", 4 * 1024 ** 3);
    await rename(join(f.root, "source.bin"), join(f.root, "preserved.bin"));
    await writeFile(join(f.root, "source.bin"), "foreign");
    return file;
  });
  Object.assign(f.host.native, { openPrivateFile: opened });
  expect((await readPrivateBytes(f.host, "source.bin", 100)).toString()).toBe(
    "held-original",
  );
  Object.assign(f.host.native, {
    openPrivateFile: vi.fn(async () => {
      throw Object.assign(new Error("PATH_UNSAFE"), { code: "PATH_UNSAFE" });
    }),
  });
  await expect(
    readPrivateBytes(f.host, "source.bin", 100),
  ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  expect((await readFile(join(f.root, "source.bin"))).toString()).toBe(
    "foreign",
  );
});
it("creates exclusively and appends through the native writer, retaining all chunks", async () => {
  const f = await fixture();
  const file = await newPrivateFile(f.host, "scratch\\created.bin");
  await file.writeFile("first");
  await file.writeFile(Buffer.alloc(65537, 65));
  await file.sync();
  await file.close();
  expect(await readFile(join(f.root, "scratch", "created.bin"))).toEqual(
    Buffer.concat([Buffer.from("first"), Buffer.alloc(65537, 65)]),
  );
  await expect(
    newPrivateFile(f.host, "scratch\\created.bin"),
  ).rejects.toMatchObject({ code: "EEXIST" });
});
it("retains missing, bounds, metadata-change and cancellation failures without leaking tokens", async () => {
  const f = await fixture();
  await expect(
    readPrivateBytes(f.host, "missing.bin", 100),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(f.root, "source.bin"), "1234");
  await expect(readPrivateBytes(f.host, "source.bin", 3)).rejects.toMatchObject(
    { code: "INTEGRITY_INVALID" },
  );
  const file = await f.native.openPrivateFile("source.bin", "read", 100);
  if (!file) throw new Error("fixture-open");
  const info = file.info.bind(file),
    close = vi.spyOn(file, "close");
  let queries = 0;
  Object.assign(file, {
    info: async () => {
      const value = await info();
      return ++queries > 1
        ? { ...value, changedAt: String(BigInt(value.changedAt) + 1n) }
        : value;
    },
  });
  Object.assign(f.host.native, { openPrivateFile: vi.fn(async () => file) });
  await expect(
    readPrivateBytes(f.host, "source.bin", 100),
  ).rejects.toMatchObject({ code: "INTEGRITY_INVALID" });
  expect(close).toHaveBeenCalledOnce();
  const abort = new AbortController();
  abort.abort();
  await expect(
    verifyPrivateFile(f.host, "source.bin", 4, abort.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});
