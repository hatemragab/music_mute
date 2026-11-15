import { lstat, readFile, rm, writeFile } from "node:fs/promises";
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
import { sparseAccountVoice, storageFixture } from "./storage-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("aborts Clear Offline Voices before deleting eligible audio or reporting cleanup success", async () => {
  const f = await storageFixture();
  roots.push(f.root);
  const voice = await sparseAccountVoice(f, 1, 1000),
    models = await f.host.directory("models"),
    diagnostics = await f.host.directory("diagnostics"),
    abort = new AbortController();
  await writeFile(join(models, "keep-model.dat"), "model");
  await writeFile(join(diagnostics, "keep-report.dat"), "diagnostics");
  abort.abort(new Error("USER_CANCELLED"));
  await expect(
    f.controller.execute(
      {
        type: "CLEANUP",
        target: "voices",
        confirmation: "clear-eligible-cache",
      },
      abort.signal,
    ),
  ).rejects.toThrow("USER_CANCELLED");
  expect(
    await lstat(join(f.root, voice.relativePath.replaceAll("\\", "/"))),
  ).toBeDefined();
  expect(await readFile(join(models, "keep-model.dat"), "utf8")).toBe("model");
  expect(await readFile(join(diagnostics, "keep-report.dat"), "utf8")).toBe(
    "diagnostics",
  );
  expect(f.controller.view().lastCleanup).toBeNull();
});
