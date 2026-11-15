import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  open,
  readFile,
  rm,
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
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  statfs: async () => ({ bavail: 100n * 1024n ** 3n, bsize: 1n }),
}));
import {
  stagePersonalFile,
  PrivatePersonalStorage,
} from "../src/main/personal/storage.js";
import type { FileCapabilities } from "../src/main/file-capabilities.js";
import { storageFixture } from "./storage-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.useRealTimers();
});
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  const vault = new Map<string, Buffer>();
  Object.assign(f.native, {
    vaultRead: async (_space: string, key: string) => vault.get(key) ?? null,
    vaultWrite: async (_space: string, key: string, bytes: Buffer) => {
      vault.set(key, bytes);
    },
    vaultDelete: async (_space: string, key: string) => {
      vault.delete(key);
    },
  });
  await f.host.directory("personal\\inputs");
  const source = join(f.root, "user-source.wav");
  await writeFile(source, "untouched-source");
  const selected = await open(source, "r"),
    consume = vi.fn(async () => ({ file: selected, name: "source.wav" }));
  const caps = { consume } as unknown as FileCapabilities,
    owner = randomUUID(),
    id = randomUUID();
  return { ...f, source, selected, caps, owner, id, vault, consume };
}
it("stages exact source with a durable Node birth and transfers into the protected native workspace", async () => {
  const f = await fixture(),
    capability = await stagePersonalFile(
      f.host,
      f.caps,
      f.id,
      "window",
      f.owner,
      null,
      new AbortController().signal,
    );
  expect(f.consume).toHaveBeenCalledWith(f.id, "window");
  const row = (await f.controller.writes.readOwned())[0]!;
  expect(row).toMatchObject({
    owner: f.parent,
    settled: true,
    relativePath: `personal\\inputs\\${capability}`,
    input: { bytes: 16 },
  });
  const storage = new PrivatePersonalStorage(f.host, {
    beginWrite: (relative, kind) => f.controller.beginWrite(relative, kind),
    assertRecoveredExit: (relative) =>
      f.controller.assertWorkspaceExited(relative),
    trackWorkspace: (relative) =>
      f.controller.trackWorkspace(
        relative,
        { role: "personal", nonce: "a".repeat(64), identity: f.parent },
        "processing",
      ),
    protectTree: (relative, purpose) =>
      f.controller.protectTree(relative, purpose),
    protectPlannedTree: (relative, purpose) =>
      f.controller.protectTree(relative, purpose, true),
    reserveVoice: (bytes, relative) =>
      f.controller.reserveVoice(bytes, relative),
  });
  const job = randomUUID();
  await storage.workDirectory(job);
  const input = await storage.consume(
    capability,
    f.owner,
    null,
    new AbortController().signal,
    job,
  );
  expect(await readFile(input.path, "utf8")).toBe("untouched-source");
  expect(await f.controller.writes.readOwned()).toEqual([]);
  expect(f.vault.has(`personal_input_${capability}`)).toBe(false);
  f.setAlive(false);
  await f.controller.cleanup("scratch", new AbortController().signal);
  expect(await readFile(input.path, "utf8")).toBe("untouched-source");
  f.setExited(true);
  await f.controller.cleanup("scratch", new AbortController().signal);
  await expect(lstat(input.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.source, "utf8")).toBe("untouched-source");
});
it("the 65th stage is refused before any bytes or capability are published", async () => {
  const f = await fixture();
  for (let i = 0; i < 64; i++)
    await f.controller.writes.beginOwned(
      `personal\\inputs\\${randomUUID()}`,
      "tree",
      { bytes: 1, expiresAt: Date.now() + 15 * 60000 },
    );
  await expect(
    stagePersonalFile(
      f.host,
      f.caps,
      f.id,
      "window",
      f.owner,
      null,
      new AbortController().signal,
    ),
  ).rejects.toThrow("INPUT_LIMIT");
  expect(f.vault.size).toBe(0);
  expect(await readFile(f.source, "utf8")).toBe("untouched-source");
});
it("the aggregate 512 MiB reservation includes concurrent unfinished copying before files exist", async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++)
    await f.controller.writes.beginOwned(
      `personal\\inputs\\${randomUUID()}`,
      "tree",
      { bytes: 256 * 1024 ** 2, expiresAt: Date.now() + 15 * 60000 },
    );
  await expect(
    stagePersonalFile(
      f.host,
      f.caps,
      f.id,
      "window",
      f.owner,
      null,
      new AbortController().signal,
    ),
  ).rejects.toThrow("INPUT_LIMIT");
  expect(
    (await f.controller.writes.readOwned()).reduce(
      (sum, row) => sum + row.input!.bytes,
      0,
    ),
  ).toBe(512 * 1024 ** 2);
  expect(f.vault.size).toBe(0);
});
it("an unclaimed stopped copy remains retained until expiry and then becomes bounded eligible scratch", async () => {
  const f = await fixture(),
    capability = await stagePersonalFile(
      f.host,
      f.caps,
      f.id,
      "window",
      f.owner,
      null,
      new AbortController().signal,
    ),
    row = (await f.controller.writes.readOwned())[0]!;
  expect(await f.controller.writes.eligible(row)).toBe(false);
  vi.useFakeTimers();
  vi.setSystemTime(row.input!.expiresAt + 1);
  await f.controller.cleanup("scratch", new AbortController().signal);
  await expect(
    lstat(join(f.root, "personal", "inputs", capability)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.source, "utf8")).toBe("untouched-source");
});
it("source growth cannot exceed its aggregate reservation or create a playable capability", async () => {
  const f = await fixture(),
    original = f.selected.read.bind(f.selected);
  let changed = false;
  vi.spyOn(f.selected, "read").mockImplementation(
    async (...args: Parameters<typeof f.selected.read>) => {
      const result = await original(...args);
      if (!changed) {
        changed = true;
        await appendFile(f.source, "late-growth");
      }
      return result;
    },
  );
  await expect(
    stagePersonalFile(
      f.host,
      f.caps,
      f.id,
      "window",
      f.owner,
      null,
      new AbortController().signal,
    ),
  ).rejects.toThrow("INPUT_CHANGED");
  expect(f.vault.size).toBe(0);
  expect(await f.controller.writes.readOwned()).toEqual([]);
  expect(await readFile(f.source, "utf8")).toBe("untouched-sourcelate-growth");
});
