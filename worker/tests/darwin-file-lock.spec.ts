import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { withDarwinFileLock } from "../src/runtime/darwin-file-lock.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../src/runtime/local-lifecycle.js";

it.skipIf(process.platform !== "darwin")(
  "kernel releases killed owner; competing recovery preserves lifecycle revisions",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mw-kernel-lock-"));
    const path = join(root, "lifecycle.json");
    await initializeLocalLifecycle(path);
    const child = fork(
      fileURLToPath(
        new URL("./fixtures/darwin-lock-owner.mjs", import.meta.url),
      ),
      [
        new URL("../src/runtime/darwin-file-lock.ts", import.meta.url).href,
        `${path}.lock`,
      ],
      {
        execArgv: ["--experimental-transform-types"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const ready = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => {
          throw new Error("Lock owner exited before ready");
        }),
      ]);
      expect(ready[0]).toEqual({ ready: true });
      await expect(setLocalLifecycleIntent(path, "paused")).rejects.toThrow(
        "already in progress",
      );
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          setLocalLifecycleIntent(path, "paused"),
        ),
      );
      const count = results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      expect(count).toBeGreaterThan(0);
      expect(await loadLocalLifecycle(path)).toMatchObject({
        intent: "paused",
        revision: 1 + count,
      });
      await expect(
        withDarwinFileLock(`${path}.lock.guard`, async () => "available"),
      ).resolves.toBe("available");
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "rejects symlink lock paths without changing the target",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mw-kernel-lock-"));
    try {
      await writeFile(join(root, "target"), "unchanged", { mode: 0o600 });
      await symlink(join(root, "target"), join(root, "guard"));
      await expect(
        withDarwinFileLock(join(root, "guard"), async () => "unsafe"),
      ).rejects.toThrow();
      expect(await readFile(join(root, "target"), "utf8")).toBe("unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
