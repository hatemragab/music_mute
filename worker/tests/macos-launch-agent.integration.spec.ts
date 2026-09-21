import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
} from "../src/platform/macos/launch-agent.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";

const roots: string[] = [];
let ownsLoadedService = false;
const enabled =
  process.platform === "darwin" &&
  process.env.MUSICMUTE_RUN_LAUNCHD_INTEGRATION === "1";

afterEach(async () => {
  const uid = process.getuid?.();
  if (uid !== undefined && uid > 0) {
    const controller = new MacLaunchAgentController(uid);
    if (ownsLoadedService && (await controller.status()).loaded)
      await controller.bootout().catch(() => undefined);
  }
  ownsLoadedService = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(enabled)("real macOS LaunchAgent", () => {
  it("bootstraps the generated one-shot plist in the current GUI domain", async () => {
    const uid = process.getuid?.();
    if (uid === undefined || uid <= 0) throw new Error("non-root uid required");
    const home = await mkdtemp(join(tmpdir(), "musicmute-launchd-"));
    roots.push(home);
    await chmod(home, 0o700);
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    const releaseRoot = join(layout.releasesRoot, "launchd-test");
    await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
    await mkdir(layout.engineRoot, { recursive: true, mode: 0o700 });
    await mkdir(dirname(layout.pythonPath), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      layout.pythonPath,
      '#!/bin/sh\nfor last do :; done\nprintf \'{"status":"ok"}\\n\' > "$last"\n',
      { mode: 0o700 },
    );
    const fixturePath = join(layout.stateRoot, "qualification.wav");
    const reportPath = join(layout.stateRoot, "qualification.json");
    await writeFile(fixturePath, "fixture", { mode: 0o600 });
    await writeLaunchAgentPlist(layout, {
      fixturePath,
      fixtureSha256: "a".repeat(64),
      reportPath,
      releaseRoot,
    });
    const controller = new MacLaunchAgentController(uid);
    expect(await controller.status()).toEqual({
      loaded: false,
      running: false,
    });
    await controller.bootstrap(layout.plistPath);
    ownsLoadedService = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        expect(await readFile(reportPath, "utf8")).toContain('"status":"ok"');
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error("LaunchAgent did not write its one-shot report");
  });

  it("restarts only the test-owned persistent worker after a crash", async () => {
    const uid = process.getuid?.();
    if (uid === undefined || uid <= 0) throw new Error("non-root uid required");
    const controller = new MacLaunchAgentController(uid);
    if ((await controller.status()).loaded)
      throw new Error("Refusing to replace a pre-existing MusicMute service");
    const home = await mkdtemp(join(tmpdir(), "musicmute-launchd-service-"));
    roots.push(home);
    await chmod(home, 0o700);
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    const releaseRoot = join(layout.releasesRoot, "launchd-service");
    const nodePath = join(releaseRoot, "runtime", "node", "bin", "node");
    const cliPath = join(releaseRoot, "app", "dist", "src", "cli", "main.js");
    await mkdir(dirname(nodePath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(cliPath), { recursive: true, mode: 0o700 });
    const pidLog = join(layout.stateRoot, "launchd-test-pids.txt");
    await writeFile(
      nodePath,
      `#!/bin/sh\nprintf '%s\\n' "$$" >> ${shellQuote(pidLog)}\nexec /bin/sleep 30\n`,
      { mode: 0o700 },
    );
    await writeFile(cliPath, "test entry\n", { mode: 0o600 });
    await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
    await symlink("releases/launchd-service", layout.currentLink);
    await writeLaunchAgentPlist(layout);

    await controller.bootstrap(layout.plistPath);
    ownsLoadedService = true;
    const first = await waitForRunningPid(controller);
    await waitForRecordedPid(pidLog, first);
    process.kill(first, "SIGKILL");
    const second = await waitForRunningPid(controller, first);
    await waitForRecordedPid(pidLog, second);
    expect(second).not.toBe(first);
    const recorded = (await readFile(pidLog, "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    expect(recorded).toContain(first);
    expect(recorded).toContain(second);
  }, 20_000);
});

async function waitForRunningPid(
  controller: MacLaunchAgentController,
  previous?: number,
): Promise<number> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await controller.status();
    if (
      status.loaded &&
      status.running &&
      status.pid !== undefined &&
      status.pid !== previous
    )
      return status.pid;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("LaunchAgent did not reach the expected running PID");
}

async function waitForRecordedPid(path: string, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const values = (await readFile(path, "utf8")).trim().split("\n");
      if (values.includes(String(pid))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Test worker did not record its launchd PID");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
