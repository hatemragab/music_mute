import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withMacUserCommandLock } from "../src/platform/macos/command-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS CLI command lock", () => {
  it("rejects concurrent mutation and releases after completion", async () => {
    const path = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withMacUserCommandLock(path, async () => {
      entered();
      await gate;
      return "done";
    });
    await acquired;
    await expect(
      withMacUserCommandLock(path, async () => "unexpected"),
    ).rejects.toThrow("already running");
    release();
    await expect(first).resolves.toBe("done");
    await expect(
      withMacUserCommandLock(path, async () => "next"),
    ).resolves.toBe("next");
  });

  it("recovers an owner-only lock whose process no longer exists", async () => {
    const path = await fixture();
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        createdAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    await expect(
      withMacUserCommandLock(path, async () => "recovered"),
    ).resolves.toBe("recovered");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-lock-"));
  roots.push(root);
  await chmod(root, 0o700);
  return join(root, "command.lock");
}
