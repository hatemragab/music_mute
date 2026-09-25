import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import {
  buildMacUserRuntimeConfig,
  installMacUserWorker,
  PRODUCTION_BACKEND_BASE_URL,
  readPendingMacUserEnrollmentCredential,
  recoverMacUserWorker,
  resumeMacUserInstallation,
  resetPendingMacUserEnrollment,
} from "../src/platform/macos/user-installer.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";
import { loadRuntimeConfig } from "../src/runtime/runtime-config.js";
import { MAC_RECIPE_IDS } from "../src/platform/macos/runtime-recipes.js";
import { runMacUserCommand } from "../src/platform/macos/user-cli.js";
import {
  setLocalLifecycleIntent,
  loadLocalLifecycle,
} from "../src/runtime/local-lifecycle.js";

const machineId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";
const workerId = "718bd89b-bd03-43f7-adb7-9cb5ff415918";
const roots: string[] = [];
const compatibleRuntime = {
  node: {
    decision: "reuse" as const,
    requestedVersion: "24.18.0",
    installedVersion: "24.18.0",
    reason: "compatible" as const,
  },
  ffmpeg: {
    decision: "reuse" as const,
    requestedVersion: "8.0.3",
    installedVersion: "8.0.3",
    reason: "compatible" as const,
  },
  ffprobe: {
    decision: "reuse" as const,
    requestedVersion: "8.0.3",
    installedVersion: "8.0.3",
    reason: "compatible" as const,
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("macOS one-command user installation", () => {
  it
    .skipIf(process.platform !== "darwin")
    .each(["bootstrap", "service-loaded"])(
    "resumes a SIGKILLed installer at %s without reenrollment",
    async (boundary) => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const layout = createMacUserLayout(home);
      await createMacUserDirectories(layout);
      const release = join(root, "release");
      await releaseFixture(release, "0.1.0");
      const modelPath = join(root, "model.onnx");
      const fixturePath = join(root, "fixture.wav");
      await writeFile(modelPath, "model");
      await writeFile(fixturePath, "fixture");
      const callsPath = join(root, "calls.txt");
      const servicePath = join(root, "service.json");
      const serviceCallsPath = join(root, "service-calls.txt");
      await writeFile(servicePath, "false");
      const inputPath = join(root, "input.json");
      await writeFile(
        inputPath,
        JSON.stringify({
          layout,
          callsPath,
          servicePath,
          serviceCallsPath,
          boundary,
          runtime: compatibleRuntime,
          identity: { machineId, workerId },
          artifacts: {
            schemaVersion: 1,
            installationId: "cb56441d-f2df-4b44-a320-6f37dfa81f7f",
            platform: "darwin-arm64",
            releaseVersion: "0.1.0",
            release: { releaseRoot: release },
            model: {
              path: modelPath,
              bytes: 5,
              sha256: createHash("sha256").update("model").digest("hex"),
            },
            fixture: {
              path: fixturePath,
              sha256: createHash("sha256").update("fixture").digest("hex"),
            },
          },
        }),
        { mode: 0o600 },
      );
      const run = (mode: string) =>
        fork(
          new URL("./fixtures/interrupted-install.mjs", import.meta.url),
          [new URL("../src/", import.meta.url).href, inputPath, mode],
          {
            execArgv: ["--experimental-transform-types"],
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
      const child = run("install");
      let errors = "";
      child.stderr!.on("data", (chunk) => {
        errors += String(chunk);
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
      try {
        const [message] = await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error(errors);
          }),
        ]);
        expect(message).toEqual({ boundary });
        const journalPath = join(
          layout.transactionRoot,
          "install",
          "finalization.json",
        );
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        const credential = await readFile(layout.credentialPath, "utf8");
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        await setLocalLifecycleIntent(layout.lifecyclePath, "paused");
        const recovery = run("recover");
        recovery.stderr!.on("data", (chunk) => {
          errors += String(chunk);
        });
        const recoveryTimeout = setTimeout(
          () => recovery.kill("SIGKILL"),
          8000,
        );
        try {
          expect((await once(recovery, "exit"))[0], errors).toBe(0);
        } finally {
          clearTimeout(recoveryTimeout);
        }
        expect(await readFile(callsPath, "utf8")).toBe("prepare\nenroll\n");
        expect(await readFile(serviceCallsPath, "utf8")).toBe("bootstrap\n");
        expect(await readFile(layout.credentialPath, "utf8")).toBe(credential);
        expect((await loadLocalLifecycle(layout.lifecyclePath)).intent).toBe(
          "paused",
        );
        expect(
          JSON.parse(await readFile(layout.installationStatePath, "utf8")),
        ).toMatchObject({
          installedAt: journal.installedAt,
          machineId,
          releaseVersion: "0.1.0",
        });
        await expect(readFile(journalPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readPendingMacUserEnrollmentCredential(layout)).toBeNull();
        expect(await readFile(servicePath, "utf8")).toBe("true");
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
    },
    20_000,
  );
  it.each([false, true])(
    "stages and recovers installation with bootstrap interruption=%s",
    async (interrupt) => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      const sourceRelease = join(root, "release");
      const modelSource = join(root, "Kim_Vocal_2.onnx");
      const fixtureSource = join(root, "qualification.wav");
      await mkdir(home, { mode: 0o700 });
      await releaseFixture(sourceRelease, "0.1.0");
      const model = Buffer.from("model");
      const fixture = Buffer.from("fixture");
      await writeFile(modelSource, model, { mode: 0o600 });
      await writeFile(fixtureSource, fixture, { mode: 0o600 });
      const layout = createMacUserLayout(home);
      const prepare = vi.fn(
        async (
          arguments_: string[],
          _reuse?: { reusableModelPath?: string },
        ) => {
          const output = arguments_[arguments_.indexOf("--output") + 1]!;
          await writeFile(
            join(output, "installation-artifacts.json"),
            `${JSON.stringify({
              schemaVersion: 1,
              installationId: "cb56441d-f2df-4b44-a320-6f37dfa81f7f",
              platform: "darwin-arm64",
              releaseVersion: "0.1.0",
              release: { releaseRoot: sourceRelease },
              model: {
                path: modelSource,
                bytes: model.length,
                sha256: createHash("sha256").update(model).digest("hex"),
              },
              fixture: {
                path: fixtureSource,
                sha256: createHash("sha256").update(fixture).digest("hex"),
              },
            })}\n`,
            { mode: 0o600 },
          );
        },
      );
      const enroll = vi.fn(async (arguments_: string[]) => {
        const output = arguments_[arguments_.indexOf("--output") + 1]!;
        await writeFile(
          join(output, ".enrollment-state.json"),
          `${JSON.stringify({ machineId, workerId })}\n`,
          { mode: 0o600 },
        );
        await writeFile(
          join(output, "machine.credential"),
          `${"m".repeat(43)}\n`,
          {
            mode: 0o600,
          },
        );
      });
      const qualificationPath = join(layout.stateRoot, "qualification.json");
      const qualify = vi.fn(async () => qualificationPath);
      let loaded = false;
      let failBootstrap = interrupt;
      const launchAgent = {
        kickstart: vi.fn(async () => undefined),
        bootstrap: vi.fn(async () => {
          if (failBootstrap) throw new Error("fixture interrupted bootstrap");
          loaded = true;
        }),
        bootout: vi.fn(async () => {
          loaded = false;
        }),
        status: vi.fn(async () => ({ loaded, running: loaded })),
      };

      const installation = installMacUserWorker({
        layout,
        uid: process.getuid!(),
        enrollmentCredential: "x".repeat(43),
        label: "Studio Mac",
        launchAgent,
        prepare,
        enroll,
        qualify,
        inspectRuntime: vi.fn(async () => compatibleRuntime),
      });
      if (interrupt) {
        await expect(installation).rejects.toThrow(
          "fixture interrupted bootstrap",
        );
        expect(
          await readPendingMacUserEnrollmentCredential(layout),
        ).not.toBeNull();
        failBootstrap = false;
        await setLocalLifecycleIntent(layout.lifecyclePath, "paused");
        await expect(
          runMacUserCommand("install", [], {
            layout,
            host: {
              platform: "darwin",
              arch: "arm64",
              uid: process.getuid!(),
              home,
            },
            launchAgent,
            stdout: vi.fn(),
            readEnrollmentCode: async () => {
              throw new Error("Must not consume another code");
            },
          }),
        ).resolves.toBe(0);
        expect((await loadLocalLifecycle(layout.lifecyclePath)).intent).toBe(
          "paused",
        );
        expect(enroll).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
      } else
        await expect(installation).resolves.toMatchObject({
          machineId,
          releaseVersion: "0.1.0",
          serviceLoaded: true,
        });
      await expect(
        resumeMacUserInstallation({
          layout,
          uid: process.getuid!(),
          launchAgent,
        }),
      ).resolves.toBeNull();
      const config = await loadRuntimeConfig(layout.configPath, {
        platform: "darwin",
        arch: "arm64",
      });
      expect(config).toMatchObject({
        backendBaseUrl: `${PRODUCTION_BACKEND_BASE_URL}/`,
        machineId,
        localLifecyclePath: layout.lifecyclePath,
        credential: "m".repeat(43),
        slots: [
          {
            recipeIds: [...MAC_RECIPE_IDS],
          },
        ],
      });
      expect(launchAgent.bootstrap).toHaveBeenCalledWith(layout.plistPath);
      expect(prepare).toHaveBeenCalledWith(expect.any(Array), {
        reusableModelPath: join(
          layout.modelRoot,
          "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
          "Kim_Vocal_2.onnx",
        ),
      });
      expect(await readFile(layout.plistPath, "utf8")).toContain(
        "com.musicmute.worker",
      );
      expect(
        JSON.parse(await readFile(layout.installationStatePath, "utf8")),
      ).toMatchObject({
        releaseVersion: "0.1.0",
        runtimePreflight: {
          node: { decision: "reuse", installedVersion: "24.18.0" },
          ffmpeg: { decision: "reuse", installedVersion: "8.0.3" },
          ffprobe: { decision: "reuse", installedVersion: "8.0.3" },
        },
      });
    },
  );

  it("builds only the production HTTPS base URL by default", () => {
    const layout = createMacUserLayout("/Users/tester");
    expect(
      buildMacUserRuntimeConfig(layout, PRODUCTION_BACKEND_BASE_URL, false, {
        machineId,
        workerId,
      }),
    ).toMatchObject({
      backendBaseUrl: "https://api.music-mute.com/",
      localLifecyclePath: layout.lifecyclePath,
    });
  });

  it("reactivates a preserved verified release without enrollment", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await releaseFixture(join(layout.releasesRoot, "0.1.0"), "0.1.0");
    await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
    await writeFile(layout.credentialPath, `${"m".repeat(43)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      layout.installationStatePath,
      `${JSON.stringify({ releaseVersion: "0.1.0" })}\n`,
      { mode: 0o600 },
    );
    const launchAgent = {
      bootstrap: vi.fn(async () => undefined),
      bootout: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ loaded: true, running: true })),
    };

    await expect(
      recoverMacUserWorker({
        layout,
        uid: process.getuid!(),
        launchAgent,
        confirmHealthy: async () => true,
      }),
    ).resolves.toEqual({ releaseVersion: "0.1.0", serviceLoaded: true });
    expect(
      await import("node:fs/promises").then(({ readlink }) =>
        readlink(layout.currentLink),
      ),
    ).toBe("releases/0.1.0");
    expect(launchAgent.bootstrap).toHaveBeenCalledWith(layout.plistPath);
  });

  it("rolls recovery back when the restored runtime is unhealthy", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await releaseFixture(join(layout.releasesRoot, "0.1.0"), "0.1.0");
    await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
    await writeFile(layout.credentialPath, `${"m".repeat(43)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      layout.installationStatePath,
      `${JSON.stringify({ releaseVersion: "0.1.0" })}\n`,
      { mode: 0o600 },
    );
    const launchAgent = {
      bootstrap: vi.fn(async () => undefined),
      bootout: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ loaded: true, running: true })),
    };

    await expect(
      recoverMacUserWorker({
        layout,
        uid: process.getuid!(),
        launchAgent,
        confirmHealthy: async () => false,
      }),
    ).rejects.toThrow("failed runtime doctor");
    await expect(
      import("node:fs/promises").then(({ lstat }) => lstat(layout.currentLink)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(launchAgent.bootout).toHaveBeenCalledOnce();
  });

  it("reads only a private valid pending enrollment credential", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    const pending = join(
      layout.transactionRoot,
      "install",
      "enrollment.credential",
    );
    await mkdir(dirname(pending), { recursive: true, mode: 0o700 });
    await writeFile(pending, `${"p".repeat(43)}\n`, { mode: 0o600 });
    await expect(readPendingMacUserEnrollmentCredential(layout)).resolves.toBe(
      "p".repeat(43),
    );
    await chmod(pending, 0o644);
    await expect(
      readPendingMacUserEnrollmentCredential(layout),
    ).rejects.toThrow("unsafe");
  });

  it("refuses to replace a code after an installation identity exists", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    const pendingRoot = join(layout.transactionRoot, "install");
    await mkdir(pendingRoot, { recursive: true, mode: 0o700 });
    const credentialPath = join(pendingRoot, "enrollment.credential");
    await writeFile(credentialPath, `${"p".repeat(43)}\n`, { mode: 0o600 });
    await writeFile(
      join(pendingRoot, ".enrollment-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        exchangeRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
        reportRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eab",
        activationRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eac",
        installationId: "32410a14-e85a-4a1d-bb99-61fa54b07ead",
      })}\n`,
      { mode: 0o600 },
    );

    await expect(resetPendingMacUserEnrollment(layout)).rejects.toThrow(
      "has progressed",
    );
    await expect(readFile(credentialPath, "utf8")).resolves.toBe(
      `${"p".repeat(43)}\n`,
    );
  });
});

async function releaseFixture(root: string, version: string): Promise<void> {
  for (const path of [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3.13",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
  ]) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(absolute, 0o755);
  }
  await symlink(
    "python3.13",
    join(root, "runtime", "python", "bin", "python3"),
  );
  await mkdir(join(root, "app", "engine"), { recursive: true });
  await writeFile(join(root, "app", "engine", "module.py"), "VALUE = 1\n");
  await writeFile(
    join(root, "app", "package.json"),
    '{"name":"@musicmute/worker","version":"0.1.0"}\n',
  );
  for (const [path, value] of [
    ["runtime/licenses/ffmpeg/COPYING.LGPLv2.1", "license\n"],
    ["runtime/licenses/lame/COPYING", "license\n"],
    ["runtime/media-source-manifest.json", '{"schemaVersion":1}\n'],
  ] as const) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
  }
  await writeMacReleaseManifest(root, version);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-installer-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
