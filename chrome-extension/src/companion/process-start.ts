import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A bounded OS birth identity; an unknown live process must never look dead. */
export async function processStartIdentity(
  pid: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647)
    throw new Error("PROCESS_IDENTITY_UNAVAILABLE");
  const dead = () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  if (dead()) return null;
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("PROCESS_IDENTITY_UNAVAILABLE");
  try {
    const { stdout } = await run(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        timeout: 2_000,
        maxBuffer: 512,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        encoding: "utf8",
      },
    );
    const started = stdout.trim();
    if (
      !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(
        started,
      )
    )
      throw new Error("PROCESS_IDENTITY_UNAVAILABLE");
    if (dead()) return null;
    return createHash("sha256")
      .update(JSON.stringify([process.platform, pid, started]))
      .digest("hex");
  } catch {
    if (dead()) return null;
    throw new Error("PROCESS_IDENTITY_UNAVAILABLE");
  }
}
