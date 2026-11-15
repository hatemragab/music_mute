import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import {
  RuntimeStaging,
  RUNTIME_STAGING_KEY,
  RUNTIME_STAGING_PATH,
} from "../src/main/prepare/runtime-staging.js";
import type { PreparationBundle } from "../src/main/prepare/bundle.js";
import { storageFixture } from "./storage-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function bundle(target = "a".repeat(64)): PreparationBundle {
  return {
    targetIdentity: target,
    archivePath: "fixture-only.zip",
    metadata: {
      schemaVersion: 1,
      platform: "windows-amd64",
      installationProfile: "windows-user",
      sequence: 1,
      releaseVersion: "0.1.3",
      publishedAt: "2026-10-09T00:00:00.000Z",
      expiresAt: "2026-10-10T00:00:00.000Z",
      release: {
        filename: "fixture-only.zip",
        bytes: 100,
        sha256: "b".repeat(64),
        contentType: "application/zip",
      },
    },
  };
}
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  const vault = new Map<string, Buffer>();
  Object.assign(f.native, {
    vaultRead: vi.fn(async (_: string, key: string) =>
      vault.has(key) ? Buffer.from(vault.get(key)!) : null,
    ),
    vaultWrite: vi.fn(async (_: string, key: string, bytes: Buffer) => {
      vault.set(key, Buffer.from(bytes));
    }),
    vaultDelete: vi.fn(async (_: string, key: string) => {
      vault.delete(key);
    }),
  });
  const verify = vi.fn(async () => {});
  const stage = new RuntimeStaging(f.host, verify);
  const path = (relative: string) =>
    join(f.root, relative.replaceAll("\\", "/"));
  return { ...f, vault, verify, stage, path };
}
it("uses one fixed private stage and discards only its closed current Node writer tree on failure", async () => {
  const f = await fixture();
  const directory = await f.stage.create(bundle());
  await mkdir(join(directory, "runtime"));
  await writeFile(
    join(directory, "runtime", "node.exe"),
    "fixture-only partial",
  );
  await writeFile(join(f.root, "user-source.wav"), "never touched");
  expect(directory).toBe(f.path(RUNTIME_STAGING_PATH));
  await f.stage.discardOwned();
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
  await expect(
    readFile(join(directory, "runtime", "node.exe")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.root, "user-source.wav"), "utf8")).toBe(
    "never touched",
  );
  expect(await f.stage.create(bundle("c".repeat(64)))).toBe(directory);
});
it("recovers exact dead Node birth, including reused PID, before another target can allocate staging", async () => {
  const f = await fixture();
  await f.stage.create(bundle());
  await writeFile(f.path(`${RUNTIME_STAGING_PATH}\\partial`), "private bytes");
  f.setAlive(false);
  const next = new RuntimeStaging(f.host, f.verify);
  await next.recover();
  expect(f.vault.size).toBe(0);
  await expect(
    readFile(f.path(`${RUNTIME_STAGING_PATH}\\partial`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await next.create(bundle("c".repeat(64)))).toBe(
    f.path(RUNTIME_STAGING_PATH),
  );
});
it("live consuming Node and unknown birth query retain the exact partial instead of inferring abandoned-mutex death", async () => {
  const f = await fixture();
  await f.stage.create(bundle());
  await writeFile(f.path(`${RUNTIME_STAGING_PATH}\\partial`), "keep");
  const next = new RuntimeStaging(f.host, f.verify);
  await expect(next.create(bundle())).rejects.toThrow("BUSY");
  f.native.processIdentity.mockRejectedValue(new Error("query unavailable"));
  await expect(next.recover()).rejects.toThrow("INTEGRITY_INVALID");
  expect(
    await readFile(f.path(`${RUNTIME_STAGING_PATH}\\partial`), "utf8"),
  ).toBe("keep");
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(true);
});
it("an unbound stage or replaced directory birth denies cleanup/new allocation", async () => {
  const f = await fixture();
  await f.host.directory(RUNTIME_STAGING_PATH);
  await writeFile(f.path(`${RUNTIME_STAGING_PATH}\\unknown`), "keep unknown");
  await expect(f.stage.create(bundle())).rejects.toThrow("INTEGRITY_INVALID");
  expect(f.vault.size).toBe(0);
  await rm(f.path(RUNTIME_STAGING_PATH), { recursive: true });
  await f.stage.create(bundle());
  await rename(f.path(RUNTIME_STAGING_PATH), f.path("staging\\original-stage"));
  await f.host.directory(RUNTIME_STAGING_PATH);
  await writeFile(
    f.path(`${RUNTIME_STAGING_PATH}\\replacement`),
    "keep replacement",
  );
  f.setAlive(false);
  await expect(new RuntimeStaging(f.host, f.verify).recover()).rejects.toThrow(
    "INTEGRITY_INVALID",
  );
  expect(
    await readFile(f.path(`${RUNTIME_STAGING_PATH}\\replacement`), "utf8"),
  ).toBe("keep replacement");
});
it("never follows a link in dead private staging or deletes its external target", async () => {
  const f = await fixture();
  await f.stage.create(bundle());
  await writeFile(join(f.root, "user-source.wav"), "keep source");
  await symlink(
    join(f.root, "user-source.wav"),
    f.path(`${RUNTIME_STAGING_PATH}\\link`),
  );
  f.setAlive(false);
  await expect(new RuntimeStaging(f.host, f.verify).recover()).rejects.toThrow(
    "INTEGRITY_INVALID",
  );
  expect(await readFile(join(f.root, "user-source.wav"), "utf8")).toBe(
    "keep source",
  );
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(true);
});
it("lost staging-write ACK is cleaned only by the exact current in-memory writer after its copy has stopped", async () => {
  const f = await fixture();
  const native = f.native as typeof f.native & {
    vaultWrite: ReturnType<typeof vi.fn>;
  };
  native.vaultWrite.mockImplementationOnce(
    async (_: string, key: string, bytes: Buffer) => {
      f.vault.set(key, Buffer.from(bytes));
      throw new Error("lost ACK");
    },
  );
  await expect(f.stage.create(bundle())).rejects.toThrow("lost ACK");
  expect(f.vault.size).toBe(0);
  await expect(readFile(f.path(RUNTIME_STAGING_PATH))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await f.stage.create(bundle());
});
it("rename-before-retirement preserves final bytes until exact birth and full promoted proof verify", async () => {
  const f = await fixture();
  await f.stage.create(bundle());
  await writeFile(
    f.path(`${RUNTIME_STAGING_PATH}\\payload`),
    "published private bytes",
  );
  await f.stage.verified("d".repeat(64));
  await f.host.directory("runtime\\releases");
  await f.stage.promote();
  const final = `runtime\\releases\\${bundle().targetIdentity}`;
  await f.stage.discardOwned();
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(true);
  await expect(new RuntimeStaging(f.host, f.verify).recover()).rejects.toThrow(
    "BUSY",
  );
  f.native.processIdentity.mockRejectedValueOnce(
    new Error("unknown Node birth"),
  );
  await expect(new RuntimeStaging(f.host, f.verify).recover()).rejects.toThrow(
    "INTEGRITY_INVALID",
  );
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(true);
  f.setAlive(false);
  f.verify.mockRejectedValueOnce(new Error("full proof refused"));
  await expect(new RuntimeStaging(f.host, f.verify).recover()).rejects.toThrow(
    "full proof refused",
  );
  expect(await readFile(f.path(`${final}\\payload`), "utf8")).toBe(
    "published private bytes",
  );
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(true);
  await new RuntimeStaging(f.host, f.verify).recover();
  expect(f.vault.size).toBe(0);
  expect(await readFile(f.path(`${final}\\payload`), "utf8")).toBe(
    "published private bytes",
  );
});
it("the same closed extraction may retire its exact renamed WAL only after full final proof, never by another live instance", async () => {
  const f = await fixture();
  await f.stage.create(bundle());
  await writeFile(f.path(`${RUNTIME_STAGING_PATH}\\payload`), "closed source");
  await f.stage.verified("d".repeat(64));
  await f.host.directory("runtime\\releases");
  await f.stage.promote();
  await f.stage.discardOwned();
  await f.stage.recover();
  expect(f.verify).toHaveBeenCalledOnce();
  expect(f.vault.size).toBe(0);
  expect(
    await readFile(
      f.path(`runtime\\releases\\${bundle().targetIdentity}\\payload`),
      "utf8",
    ),
  ).toBe("closed source");
});
it("corrupt/foreign journal and failed known-tree deletion stay bounded recovery conflicts", async () => {
  const f = await fixture();
  await f.stage.create(bundle());
  const original = Buffer.from(f.vault.get(RUNTIME_STAGING_KEY)!);
  const row = JSON.parse(original.toString());
  f.vault.set(
    RUNTIME_STAGING_KEY,
    Buffer.from(JSON.stringify({ ...row, extra: true })),
  );
  f.setAlive(false);
  await expect(new RuntimeStaging(f.host, f.verify).recover()).rejects.toThrow(
    "INTEGRITY_INVALID",
  );
  f.vault.set(RUNTIME_STAGING_KEY, original);
  f.native.validatePath.mockRejectedValueOnce(new Error("EPERM"));
  await expect(new RuntimeStaging(f.host, f.verify).recover()).rejects.toThrow(
    "EPERM",
  );
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(true);
  await new RuntimeStaging(f.host, f.verify).recover();
  expect(f.vault.size).toBe(0);
});
