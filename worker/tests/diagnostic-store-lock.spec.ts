import { mkdtemp, readFile, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { withDiagnosticStoreLock } from "../src/runtime/diagnostic-store-lock.js";

it("never steals an old incomplete diagnostic lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "mw-diagnostic-lock-"));
  try {
    const path = join(root, "writer.lock");
    await writeFile(path, "", { mode: 0o600 });
    await utimes(path, new Date(0), new Date(0));
    let entered = false;
    await expect(
      withDiagnosticStoreLock(root, async () => {
        entered = true;
      }),
    ).rejects.toThrow("ownership is unknown");
    expect(entered).toBe(false);
    expect(await readFile(path, "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "darwin")(
  "serializes competing diagnostic recovery and preserves every mutation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mw-diagnostic-lock-"));
    try {
      await writeFile(
        join(root, "writer.lock"),
        JSON.stringify({ pid: 2147483647, createdAt: 0 }),
        { mode: 0o600 },
      );
      const counter = join(root, "counter");
      await writeFile(counter, "0", { mode: 0o600 });
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withDiagnosticStoreLock(root, async () => {
            const value = Number(await readFile(counter, "utf8"));
            await delay(2);
            await writeFile(counter, String(value + 1));
          }),
        ),
      );
      expect(await readFile(counter, "utf8")).toBe("8");
      await expect(readFile(join(root, "writer.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
