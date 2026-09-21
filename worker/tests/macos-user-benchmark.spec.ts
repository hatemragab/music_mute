import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeLocalLifecycle } from "../src/runtime/local-lifecycle.js";
import { benchmarkMacUserWorker } from "../src/platform/macos/user-benchmark.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS local benchmark admission", () => {
  it("refuses while the worker is active or loaded", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-benchmark-"));
    roots.push(root);
    await chmod(root, 0o700);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await initializeLocalLifecycle(layout.lifecyclePath);
    const qualify = vi.fn();

    await expect(
      benchmarkMacUserWorker({
        layout,
        uid: process.getuid!(),
        launchAgent: {
          status: async () => ({ loaded: true, running: true }),
          bootstrap: async () => undefined,
          bootout: async () => undefined,
        },
        qualify,
      }),
    ).rejects.toThrow("already-drained and stopped");
    expect(qualify).not.toHaveBeenCalled();
  });
});
