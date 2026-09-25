import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32").each(["empty", "saturated"])(
  "removes busy engine and decoder after abrupt supervisor death with %s input",
  async (mode) => {
    const parent = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("./fixtures/guardian-parent.mjs", import.meta.url),
        ),
        fileURLToPath(
          new URL("../src/agent/process-guardian.ts", import.meta.url),
        ),
        fileURLToPath(new URL("./fixtures/hanging-child.mjs", import.meta.url)),
        mode,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let pids: number[] = [];
    try {
      const [data] = await Promise.race([
        once(parent.stdout, "data"),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("guardian fixture startup timed out")),
            3000,
          ).unref(),
        ),
      ]);
      const ready = JSON.parse(String(data)) as Record<string, number>;
      pids = [ready.guardianPid!, ready.enginePid!, ready.descendantPid!];
      expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(
        true,
      );
      const exited = once(parent, "exit");
      parent.kill("SIGKILL");
      await exited;
      await expect
        .poll(
          () =>
            pids.every((pid) => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === "ESRCH";
              }
            }),
          { timeout: 3000 },
        )
        .toBe(true);
    } finally {
      parent.kill("SIGKILL");
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* reaped */
        }
      }
    }
  },
);
