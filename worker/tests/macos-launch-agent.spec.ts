import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  MacLaunchAgentController,
  MacLaunchAgentError,
  renderLaunchAgentPlist,
  type LaunchAgentExecutor,
} from "../src/platform/macos/launch-agent.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";

// These fixtures exercise Darwin paths, UID ownership and POSIX permissions.
describe.skipIf(process.platform !== "darwin")("macOS user LaunchAgent", () => {
  afterEach(() => vi.useRealTimers());
  it("renders an owner-scoped worker without privileged identity fields", () => {
    const plist = renderLaunchAgentPlist(
      createMacUserLayout("/Users/Music & Mute"),
    );
    expect(plist).toContain("<string>com.musicmute.worker</string>");
    expect(plist).toContain(
      "/Users/Music &amp; Mute/Library/Application Support",
    );
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain(
      "<key>ProcessType</key>\n  <string>Background</string>",
    );
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).toContain(
      "<key>ThrottleInterval</key>\n  <integer>10</integer>",
    );
    expect(plist).toContain(
      "/Users/Music &amp; Mute/Library/Application Support/MusicMuteWorker/runtime/current/runtime/bin:/Users/Music &amp; Mute/Library/Application Support/MusicMuteWorker/runtime/current/runtime/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
    expect(plist).toContain(
      "<key>PYTHONDONTWRITEBYTECODE</key>\n    <string>1</string>",
    );
    expect(plist).toContain(
      "<key>NUMBA_CACHE_DIR</key>\n    <string>/Users/Music &amp; Mute/Library/Application Support/MusicMuteWorker/cache/numba</string>",
    );
    expect(plist).toContain(
      "<key>PYTHONPYCACHEPREFIX</key>\n    <string>/Users/Music &amp; Mute/Library/Application Support/MusicMuteWorker/cache/python</string>",
    );
    expect(plist).toContain(
      "<key>XDG_CACHE_HOME</key>\n    <string>/Users/Music &amp; Mute/Library/Application Support/MusicMuteWorker/cache</string>",
    );
    expect(plist).not.toContain("UserName");
    expect(plist).not.toContain("GroupName");
    expect(plist).not.toContain("credential");
    expect(plist).not.toContain("STORAGE_");
  });

  it("uses only the current user launchctl domain", async () => {
    const execute = vi.fn<LaunchAgentExecutor>(async (_file, args) => {
      if (args[0] === "print")
        throw Object.assign(new Error("absent"), { code: 113 });
      return { stdout: "", stderr: "" };
    });
    const controller = new MacLaunchAgentController(501, execute);

    await controller.bootstrap("/Users/tester/Library/LaunchAgents/test.plist");
    await controller.kickstart();
    await controller.bootout();

    expect(execute.mock.calls).toEqual([
      ["/bin/launchctl", ["enable", "gui/501/com.musicmute.worker"]],
      [
        "/bin/launchctl",
        [
          "bootstrap",
          "gui/501",
          "/Users/tester/Library/LaunchAgents/test.plist",
        ],
      ],
      ["/bin/launchctl", ["kickstart", "gui/501/com.musicmute.worker"]],
      ["/bin/launchctl", ["bootout", "gui/501/com.musicmute.worker"]],
      ["/bin/launchctl", ["print", "gui/501/com.musicmute.worker"]],
    ]);
  });

  it("reinstalls a worker whose disabled override survived app and data removal", async () => {
    const disabled = new Set([
      "gui/501/com.musicmute.worker",
      "gui/501/com.example.other",
      "gui/502/com.musicmute.worker",
    ]);
    const execute = vi.fn<LaunchAgentExecutor>(async (_file, args) => {
      if (args[0] === "enable") disabled.delete(args[1]!);
      if (
        args[0] === "bootstrap" &&
        disabled.has(`${args[1]}/com.musicmute.worker`)
      )
        throw Object.assign(new Error("Bootstrap failed: 5"), { code: 5 });
      return { stdout: "", stderr: "" };
    });
    const plistPath =
      "/Users/tester/Library/LaunchAgents/com.musicmute.worker.plist";

    await new MacLaunchAgentController(501, execute).bootstrap(plistPath);

    expect(execute.mock.calls).toEqual([
      ["/bin/launchctl", ["enable", "gui/501/com.musicmute.worker"]],
      ["/bin/launchctl", ["bootstrap", "gui/501", plistPath]],
    ]);
    expect([...disabled]).toEqual([
      "gui/501/com.example.other",
      "gui/502/com.musicmute.worker",
    ]);
  });

  it.each([
    ["enable", "WORKER_SERVICE_ENABLE_FAILED"],
    ["bootstrap", "WORKER_SERVICE_START_FAILED"],
  ] as const)(
    "reports a safe %s failure and stops the startup sequence",
    async (command, code) => {
      const cause = Object.assign(new Error("private launchctl output"), {
        code: 5,
      });
      const execute = vi.fn<LaunchAgentExecutor>(async (_file, args) => {
        if (args[0] === command) throw cause;
        return { stdout: "", stderr: "" };
      });
      const failure = await new MacLaunchAgentController(501, execute)
        .bootstrap(
          "/Users/tester/Library/LaunchAgents/com.musicmute.worker.plist",
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MacLaunchAgentError);
      expect(failure).toMatchObject({ code, cause });
      expect((failure as MacLaunchAgentError).message).not.toContain(
        cause.message,
      );
      expect(execute.mock.calls.map(([, args]) => args[0])).toEqual(
        command === "enable" ? ["enable"] : ["enable", "bootstrap"],
      );
    },
  );

  it("waits for registration removal after bootout is acknowledged", async () => {
    vi.useFakeTimers();
    let checks = 0;
    const execute = vi.fn<LaunchAgentExecutor>(async (_file, args) => {
      if (args[0] === "print" && ++checks > 2)
        throw Object.assign(new Error("absent"), { code: 113 });
      return { stdout: "state = exited\n", stderr: "" };
    });
    let complete = false;
    const stopped = new MacLaunchAgentController(501, execute)
      .bootout()
      .then(() => {
        complete = true;
      });
    await vi.advanceTimersByTimeAsync(100);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await stopped;
    expect(checks).toBe(3);
    expect(
      execute.mock.calls.filter(([, args]) => args[0] === "bootout"),
    ).toHaveLength(1);
  });

  it("fails within the deadline when the label remains registered", async () => {
    vi.useFakeTimers();
    const execute = vi.fn<LaunchAgentExecutor>(async () => ({
      stdout: "state = running\npid = 4321\n",
      stderr: "",
    }));
    const stopped = expect(
      new MacLaunchAgentController(501, execute).bootout(),
    ).rejects.toThrow("MusicMute worker service did not unload");
    await vi.advanceTimersByTimeAsync(30_000);
    await stopped;
    expect(
      execute.mock.calls.filter(([, args]) => args[0] === "bootout"),
    ).toHaveLength(1);
  });

  it.each([5, "ENOENT"])(
    "does not treat inspection failure %s as successful removal",
    async (code) => {
      const error = Object.assign(new Error("inspection failed"), { code });
      const execute = vi.fn<LaunchAgentExecutor>(async (_file, args) => {
        if (args[0] === "print") throw error;
        return { stdout: "", stderr: "" };
      });
      await expect(
        new MacLaunchAgentController(501, execute).bootout(),
      ).rejects.toBe(error);
    },
  );

  it("renders a one-shot MPS qualification without KeepAlive", () => {
    const layout = createMacUserLayout("/Users/tester");
    const releaseRoot = join(layout.releasesRoot, "0.1.0");
    const plist = renderLaunchAgentPlist(layout, {
      fixturePath: join(layout.stateRoot, "qualification.wav"),
      fixtureSha256: "a".repeat(64),
      reportPath: join(layout.stateRoot, "qualification.json"),
      releaseRoot,
    });
    expect(plist).toContain("musicmute_engine.qualification");
    expect(plist).toContain("<string>mps</string>");
    expect(plist).toContain(
      `<string>${join(releaseRoot, "runtime", "python", "bin", "python3")}</string>`,
    );
    expect(plist).toContain(
      `<string>${join(releaseRoot, "app", "engine")}</string>`,
    );
    expect(plist).toContain(
      `<string>${join(releaseRoot, "runtime", "bin", "ffmpeg")}</string>`,
    );
    expect(plist).not.toContain(`<string>${layout.pythonPath}</string>`);
    expect(plist).not.toContain("<key>KeepAlive</key>");
  });

  it("parses running and unloaded service status", async () => {
    const running: LaunchAgentExecutor = async () => ({
      stdout: "state = running\npid = 4321\n",
      stderr: "",
    });
    await expect(
      new MacLaunchAgentController(501, running).status(),
    ).resolves.toEqual({
      loaded: true,
      running: true,
      pid: 4321,
      detail: "running",
    });

    const missing: LaunchAgentExecutor = async () => {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    };
    await expect(
      new MacLaunchAgentController(501, missing).status(),
    ).resolves.toEqual({ loaded: false, running: false });

    const realLaunchctlMissing: LaunchAgentExecutor = async () => {
      const error = new Error("not found") as Error & { code: number };
      error.code = 113;
      throw error;
    };
    await expect(
      new MacLaunchAgentController(501, realLaunchctlMissing).status(),
    ).resolves.toEqual({ loaded: false, running: false });
  });

  it("rejects root and invalid user ids", () => {
    expect(() => new MacLaunchAgentController(0)).toThrow(
      "macOS user id is invalid",
    );
    expect(() => new MacLaunchAgentController(Number.NaN)).toThrow(
      "macOS user id is invalid",
    );
  });
});
