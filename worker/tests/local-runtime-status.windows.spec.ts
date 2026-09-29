import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLocalRuntimeStatus,
  writeLocalRuntimeStatus,
} from "../src/runtime/local-runtime-status.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform === "win32")(
  "Windows status publication",
  () => {
    it("keeps the old snapshot intact until a native reader releases it", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-status-sharing-"));
      roots.push(root);
      const path = join(root, "runtime-status.json");
      await writeLocalRuntimeStatus(path, [], { childState: "loading" });
      const reader = await holdNativeReader(path);
      let settled = false;
      const writing = writeLocalRuntimeStatus(path, [], { childState: "ready" })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await delay(150);
        expect(settled).toBe(false);
        expect((await loadLocalRuntimeStatus(path)).childState).toBe("loading");
      } finally {
        await reader.release();
      }
      const result = await writing;
      expect(result).not.toHaveProperty("error");
      expect((await loadLocalRuntimeStatus(path)).childState).toBe("ready");
      expect(await readdir(root)).toEqual(["runtime-status.json"]);
    }, 15_000);

    it("bounds a persistent sharing failure and removes its unpublished temporary", async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-status-sharing-"));
      roots.push(root);
      const path = join(root, "runtime-status.json");
      await writeLocalRuntimeStatus(path, [], { childState: "loading" });
      const previous = await readFile(path);
      const reader = await holdNativeReader(path);
      try {
        const started = performance.now();
        await expect(
          writeLocalRuntimeStatus(path, [], { childState: "ready" }),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/^(EPERM|EACCES|EBUSY)$/u),
        });
        expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(await readFile(path)).toEqual(previous);
        expect(await readdir(root)).toEqual(["runtime-status.json"]);
      } finally {
        await reader.release();
      }
    }, 15_000);
  },
);

async function holdNativeReader(path: string) {
  const script = `$ErrorActionPreference='Stop'; $Stream=[IO.File]::Open('${path.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $Stream.Dispose() }`;
  const child = spawn(
    join(
      process.env.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native reader did not acquire its handle")),
        5_000,
      );
      let output = "";
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Native reader exited before acknowledgement"));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("locked")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  }
  return {
    release: async () => {
      child.stdin.end("release\n");
      await closed;
    },
  };
}
