import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  unlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RuntimePaths = { runtime: string; node: string; python: string };
type RuntimeOptions = {
  environment?: Record<string, string | undefined>;
  userHome?: string;
  resolvePackagedRuntime?: (
    resources: string,
    support: string,
  ) => Promise<{ runtime_root: string }>;
};
const { resolveE2ERuntime } = (await import(
  new URL("../scripts/e2e-runtime.mjs", import.meta.url).href
)) as {
  resolveE2ERuntime(options?: RuntimeOptions): Promise<RuntimePaths>;
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function runtimeFixture(): Promise<RuntimePaths & { userHome: string }> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-e2e-runtime-"));
  roots.push(root);
  const runtime = join(root, "prepared-runtime");
  const paths = {
    runtime,
    node: join(runtime, "runtime/node/bin/node"),
    python: join(runtime, "runtime/python/bin/python3"),
    userHome: join(root, "user-home"),
  };
  for (const path of [paths.node, paths.python]) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  return paths;
}

describe("isolated browser test runtime selection", () => {
  it("uses an explicit runtime without resolving or inspecting other installed state", async () => {
    const fixture = await runtimeFixture();
    const resolver = vi.fn(async () => {
      throw new Error("must not resolve installed state");
    });
    expect(
      await resolveE2ERuntime({
        environment: { MUSICMUTE_LOCAL_RUNTIME: fixture.runtime },
        userHome: fixture.userHome,
        resolvePackagedRuntime: resolver,
      }),
    ).toEqual({
      runtime: await realpath(fixture.runtime),
      node: await realpath(fixture.node),
      python: await realpath(fixture.python),
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("resolves only the installed app's validated active runtime by default", async () => {
    const fixture = await runtimeFixture();
    const resolver = vi.fn(async () => ({ runtime_root: fixture.runtime }));
    const result = await resolveE2ERuntime({
      environment: {},
      userHome: fixture.userHome,
      resolvePackagedRuntime: resolver,
    });
    expect(result.runtime).toBe(await realpath(fixture.runtime));
    expect(resolver).toHaveBeenCalledExactlyOnceWith(
      "/Applications/MusicMute Local.app/Contents/Resources",
      join(fixture.userHome, "Library/Application Support/MusicMuteLocal"),
    );
  });

  it.each(["runtime/current", "", "~/runtime"])(
    "rejects invalid explicit path %j without falling back",
    async (path) => {
      const resolver = vi.fn();
      await expect(
        resolveE2ERuntime({
          environment: { MUSICMUTE_LOCAL_RUNTIME: path },
          resolvePackagedRuntime: resolver,
        }),
      ).rejects.toThrow("E2E_RUNTIME_PATH_INVALID");
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it.each(["node", "python"] as const)(
    "rejects an explicit runtime missing %s without falling back",
    async (entry) => {
      const fixture = await runtimeFixture();
      await unlink(fixture[entry]);
      const resolver = vi.fn();
      await expect(
        resolveE2ERuntime({
          environment: { MUSICMUTE_LOCAL_RUNTIME: fixture.runtime },
          resolvePackagedRuntime: resolver,
        }),
      ).rejects.toThrow("E2E_RUNTIME_EXECUTABLE_MISSING");
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it.each(["node", "python"] as const)(
    "rejects a non-executable %s",
    async (entry) => {
      const fixture = await runtimeFixture();
      await chmod(fixture[entry], 0o600);
      await expect(
        resolveE2ERuntime({
          environment: { MUSICMUTE_LOCAL_RUNTIME: fixture.runtime },
        }),
      ).rejects.toThrow("E2E_RUNTIME_EXECUTABLE_MISSING");
    },
  );

  it("rejects an executable directory in place of Python", async () => {
    const fixture = await runtimeFixture();
    await unlink(fixture.python);
    await mkdir(fixture.python, { mode: 0o700 });
    await expect(
      resolveE2ERuntime({
        environment: { MUSICMUTE_LOCAL_RUNTIME: fixture.runtime },
      }),
    ).rejects.toThrow("E2E_RUNTIME_EXECUTABLE_MISSING");
  });

  it("does not fall back when the packaged runtime resolver rejects", async () => {
    const fixture = await runtimeFixture();
    const resolver = vi.fn(async () => {
      throw new Error("APP_RUNTIME_NOT_PREPARED with a private path");
    });
    await expect(
      resolveE2ERuntime({
        environment: {},
        userHome: fixture.userHome,
        resolvePackagedRuntime: resolver,
      }),
    ).rejects.toThrow(/^E2E_RUNTIME_EXECUTABLE_MISSING$/);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid output from the installed resolver", async () => {
    await expect(
      resolveE2ERuntime({
        environment: {},
        userHome: "/synthetic-user-home",
        resolvePackagedRuntime: async () => ({
          runtime_root: "relative-runtime",
        }),
      }),
    ).rejects.toThrow("E2E_RUNTIME_EXECUTABLE_MISSING");
  });
});
