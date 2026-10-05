import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { processStartIdentity } from "../src/companion/process-start.js";

describe("OS process birth identity", () => {
  it("returns a stable bounded digest without leaking the OS birth description", async () => {
    const first = await processStartIdentity(process.pid);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await processStartIdentity(process.pid)).toBe(first);
  });
  it("distinguishes an actual live child from its exited PID", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const pid = child.pid!;
    try {
      expect(await processStartIdentity(pid)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    expect(await processStartIdentity(pid)).toBeNull();
  });
  it("rejects non-process inputs with a closed error", async () => {
    for (const pid of [0, -1, NaN, 1.5, 2_147_483_648])
      await expect(processStartIdentity(pid)).rejects.toThrow(
        "PROCESS_IDENTITY_UNAVAILABLE",
      );
  });
});
